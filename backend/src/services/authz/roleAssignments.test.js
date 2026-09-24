const assert = require("assert");

const {
  assignRole,
  resolveRole,
  findAssignment,
  listRoles,
  countAdmins,
  REASONS,
  __resetAssignmentsForTests,
} = require("./roleAssignments");
const { findAuditEntry, getAuditEntries } = require("../audit/auditLog");
const { can, PERMISSIONS } = require("./permissions");

// The baseline principal list the boundary would build from COLABERRY_API_TOKENS.
// Two admins, so the last-admin guard does not fire on the ordinary cases; the
// one-admin directory is built explicitly in the test that needs it.
const DIRECTORY = [
  { userId: "ADMIN-1", role: "admin" },
  { userId: "ADMIN-2", role: "admin" },
  { userId: "ADVISOR-1", role: "advisor" },
  { userId: "CUST-1", role: "customer" },
];

let correlationCounter = 0;
function nextCorrelationId() {
  correlationCounter += 1;
  return "corr-roleassign-" + String(correlationCounter).padStart(4, "0");
}

// Every refusal must leave a trace. Asserting the reason alone would pass even
// if the audit write were deleted, which is the exact regression AC-3 cares
// about - so each refusal test checks the entry too.
function assertAudited(correlationId, discriminator, expected) {
  const entry = findAuditEntry("role-assign:" + correlationId + ":" + discriminator);
  assert.ok(entry, "expected an audit entry for " + correlationId + ":" + discriminator);
  assert.strictEqual(entry.event, expected.event);
  assert.strictEqual(entry.outcome, expected.outcome);
  if (expected.actor !== undefined) {
    assert.strictEqual(entry.actor, expected.actor);
  }
  if (expected.resource !== undefined) {
    assert.strictEqual(entry.resource, expected.resource);
  }
  return entry;
}

function main() {
  // In-memory for this suite; a run that inherits the last run's assignments
  // is not a test.
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();

  // HAPPY PATH: an admin promotes a customer to advisor, and the new role is
  // what the boundary will see from that moment on.
  const promote = nextCorrelationId();
  const promoted = assignRole(
    {
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "CUST-1",
      role: "advisor",
      reason: "joined the advisory team",
      correlationId: promote,
    },
    { directory: DIRECTORY, now: Date.parse("2026-09-23T10:00:00.000Z") }
  );

  assert.strictEqual(promoted.ok, true);
  assert.strictEqual(promoted.reason, REASONS.ASSIGNED);
  assert.strictEqual(promoted.assignment.role, "advisor");
  assert.strictEqual(promoted.assignment.previousRole, "customer");
  assert.strictEqual(promoted.assignment.assignedBy, "ADMIN-1");
  assert.strictEqual(promoted.assignment.assignedAt, "2026-09-23T10:00:00.000Z");

  // AN ASSIGNMENT OVERRIDES THE DIRECTORY. This is the whole point: the token
  // still claims "customer" and the effective role is now "advisor".
  assert.strictEqual(resolveRole("CUST-1", "customer"), "advisor");
  assert.strictEqual(can(resolveRole("CUST-1", "customer"), PERMISSIONS.ADVISOR_REVIEWS_READ), true);
  assert.strictEqual(can(resolveRole("CUST-1", "customer"), PERMISSIONS.PORTAL_TRIPS_READ), false);

  // Write-ahead: the "pending" entry exists alongside the success entry, so a
  // crash between them would still have left a trace of the attempt.
  assertAudited(promote, "pending", {
    event: "authz.role_assignment.attempted",
    outcome: "pending",
    actor: "ADMIN-1",
    resource: "CUST-1",
  });
  const changed = assertAudited(promote, REASONS.ASSIGNED, {
    event: "authz.role_assignment.changed",
    outcome: "success",
    actor: "ADMIN-1",
    resource: "CUST-1",
  });
  assert.deepStrictEqual(changed.context, {
    fromRole: "customer",
    toRole: "advisor",
    reason: "joined the advisory team",
  });
  console.log("roleAssignments: an admin can change a role, and the change is audited write-ahead");

  // IDEMPOTENT: the same assignment again changes nothing and says so.
  const repeat = nextCorrelationId();
  const again = assignRole(
    {
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "CUST-1",
      role: "advisor",
      correlationId: repeat,
    },
    { directory: DIRECTORY }
  );
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.reason, REASONS.UNCHANGED);
  assert.strictEqual(findAssignment("CUST-1").correlationId, promote, "the first write stands");
  assertAudited(repeat, REASONS.UNCHANGED, {
    event: "authz.role_assignment.unchanged",
    outcome: "success",
  });

  // A REPLAYED request - same correlation id - writes no second entry.
  const beforeReplay = getAuditEntries().length;
  assignRole(
    {
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "CUST-1",
      role: "advisor",
      correlationId: repeat,
    },
    { directory: DIRECTORY }
  );
  assert.strictEqual(getAuditEntries().length, beforeReplay, "a replay must not append");
  console.log("roleAssignments: re-assigning the same role is idempotent and a replay dedups");

  // FAILURE PATH - PERMISSION ESCALATION, the direct attempt. A customer tries
  // to make themselves an admin.
  const escalate = nextCorrelationId();
  const escalated = assignRole(
    {
      actorUserId: "CUST-2",
      actorRole: "customer",
      targetUserId: "CUST-2",
      role: "admin",
      correlationId: escalate,
    },
    { directory: DIRECTORY }
  );
  assert.strictEqual(escalated.ok, false);
  assert.strictEqual(escalated.reason, REASONS.NOT_PERMITTED);
  assert.strictEqual(findAssignment("CUST-2"), null, "a refused assignment writes nothing");
  assert.strictEqual(resolveRole("CUST-2", "customer"), "customer");
  assertAudited(escalate, REASONS.NOT_PERMITTED, {
    event: "authz.role_assignment.refused",
    outcome: "failure",
    actor: "CUST-2",
  });

  // An advisor is not an admin either - the nearest role to the privilege is
  // still short of it.
  const advisorTry = nextCorrelationId();
  assert.strictEqual(
    assignRole(
      {
        actorUserId: "ADVISOR-1",
        actorRole: "advisor",
        targetUserId: "CUST-3",
        role: "admin",
        correlationId: advisorTry,
      },
      { directory: DIRECTORY }
    ).reason,
    REASONS.NOT_PERMITTED
  );
  console.log("roleAssignments: a non-admin cannot assign any role, and the attempt is audited");

  // FAILURE PATH - SELF-ASSIGNMENT. Even a real admin cannot re-grade
  // themselves; a role change for an admin needs a second admin.
  const selfTry = nextCorrelationId();
  const self = assignRole(
    {
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "ADMIN-1",
      role: "customer",
      correlationId: selfTry,
    },
    { directory: DIRECTORY }
  );
  assert.strictEqual(self.reason, REASONS.SELF_ASSIGNMENT);
  assert.strictEqual(resolveRole("ADMIN-1", "admin"), "admin");
  assertAudited(selfTry, REASONS.SELF_ASSIGNMENT, {
    event: "authz.role_assignment.refused",
    outcome: "failure",
    actor: "ADMIN-1",
  });
  console.log("roleAssignments: nobody changes their own role, admin included");

  // FAILURE PATH - ROLE ASSIGNMENT ERROR: a role that does not exist. The typo
  // case, which without this guard creates a user with no permissions at all.
  const typo = nextCorrelationId();
  const unknown = assignRole(
    {
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "CUST-4",
      role: "admn",
      correlationId: typo,
    },
    { directory: DIRECTORY }
  );
  assert.strictEqual(unknown.reason, REASONS.UNKNOWN_ROLE);
  assert.strictEqual(findAssignment("CUST-4"), null);
  assertAudited(typo, REASONS.UNKNOWN_ROLE, {
    event: "authz.role_assignment.refused",
    outcome: "failure",
  });

  // ...including the prototype-chain names, which arrive from a JSON body.
  for (const poison of ["constructor", "__proto__", "toString"]) {
    const poisonCorrelation = nextCorrelationId();
    assert.strictEqual(
      assignRole(
        {
          actorUserId: "ADMIN-1",
          actorRole: "admin",
          targetUserId: "CUST-5",
          role: poison,
          correlationId: poisonCorrelation,
        },
        { directory: DIRECTORY }
      ).reason,
      REASONS.UNKNOWN_ROLE,
      poison + " must not be assignable"
    );
  }
  assert.strictEqual(findAssignment("CUST-5"), null);

  // FAILURE PATH - ROLE ASSIGNMENT ERROR: a target that is not a usable id.
  for (const badTarget of ["", "   ", "CUST 1", "CUST/1", "x".repeat(65), null, undefined, 7, {}]) {
    const badCorrelation = nextCorrelationId();
    assert.strictEqual(
      assignRole(
        {
          actorUserId: "ADMIN-1",
          actorRole: "admin",
          targetUserId: badTarget,
          role: "advisor",
          correlationId: badCorrelation,
        },
        { directory: DIRECTORY }
      ).reason,
      REASONS.INVALID_TARGET,
      JSON.stringify(String(badTarget)) + " must not be a usable target"
    );
    // Audited even though the target is unusable - the resource field is left
    // null rather than carrying a malformed value into the trail.
    const entry = assertAudited(badCorrelation, REASONS.INVALID_TARGET, {
      event: "authz.role_assignment.refused",
      outcome: "failure",
      resource: null,
    });
    assert.strictEqual(entry.context.targetShape, "rejected");
  }
  console.log("roleAssignments: unknown roles and malformed targets are refused and audited");

  // FAILURE PATH - LAST ADMIN. With one admin left, demoting them is refused;
  // the same demotion succeeds once a second admin exists.
  __resetAssignmentsForTests();
  const soloDirectory = [
    { userId: "ADMIN-1", role: "admin" },
    { userId: "CUST-1", role: "customer" },
  ];
  assert.strictEqual(countAdmins(soloDirectory), 1);

  const lockout = nextCorrelationId();
  const refused = assignRole(
    {
      actorUserId: "CUST-1",
      actorRole: "admin", // stands in for a second operator acting with admin rights
      targetUserId: "ADMIN-1",
      role: "customer",
      correlationId: lockout,
    },
    { directory: soloDirectory }
  );
  assert.strictEqual(refused.reason, REASONS.LAST_ADMIN);
  assert.strictEqual(resolveRole("ADMIN-1", "admin"), "admin", "the last admin keeps their role");
  assertAudited(lockout, REASONS.LAST_ADMIN, {
    event: "authz.role_assignment.refused",
    outcome: "failure",
    resource: "ADMIN-1",
  });

  // Promote a second admin, and the same demotion now goes through - proving
  // the guard is about the COUNT, not a blanket ban on demoting admins.
  assignRole(
    {
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "CUST-1",
      role: "admin",
      correlationId: nextCorrelationId(),
    },
    { directory: soloDirectory }
  );
  assert.strictEqual(countAdmins(soloDirectory), 2);

  const demote = assignRole(
    {
      actorUserId: "CUST-1",
      actorRole: "admin",
      targetUserId: "ADMIN-1",
      role: "customer",
      correlationId: nextCorrelationId(),
    },
    { directory: soloDirectory }
  );
  assert.strictEqual(demote.ok, true);
  assert.strictEqual(resolveRole("ADMIN-1", "admin"), "customer");
  assert.strictEqual(countAdmins(soloDirectory), 1);
  console.log("roleAssignments: the last admin cannot be demoted, the second-to-last can");

  // An assignment naming a role that no longer exists falls back to the
  // directory rather than granting a role with no permissions.
  assert.strictEqual(resolveRole("NOBODY", "customer"), "customer");
  assert.strictEqual(resolveRole("NOBODY", "wizard"), null, "an unknown directory role is not a role");
  assert.strictEqual(can(resolveRole("NOBODY", "wizard"), PERMISSIONS.CATALOG_READ), false);

  // listRoles unions both sources and reports which one won.
  const listed = listRoles(soloDirectory);
  assert.deepStrictEqual(
    listed.map(function (entry) {
      return [entry.userId, entry.role, entry.source];
    }),
    [
      ["ADMIN-1", "customer", "assignment"],
      ["CUST-1", "admin", "assignment"],
    ]
  );
  console.log("roleAssignments: resolveRole denies by default and listRoles unions both sources");

  // A missing correlation id is a programming error at the boundary, not a
  // runtime condition - it throws rather than auditing under a useless key.
  assert.throws(function () {
    assignRole({
      actorUserId: "ADMIN-1",
      actorRole: "admin",
      targetUserId: "CUST-9",
      role: "advisor",
    });
  }, /correlationId/);
  console.log("roleAssignments: an assignment with no correlation id is refused outright");

  console.log("roleAssignments: all tests passed");
}

main();
