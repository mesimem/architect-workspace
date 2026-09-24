// STORY-006 hardening: role assignments have to survive a restart.
//
// Every other suite in this story runs with COLABERRY_DATA_DIR unset, which is
// in-memory - correct for testing decisions, useless for testing durability.
// A role change that evaporates on deploy is not a role change: the demoted
// admin silently gets their powers back, and nobody finds out until they use
// them.
//
// THE ONLY HONEST WAY TO TEST THIS IS A SECOND PROCESS. Re-reading in this one
// would hit the rows already in the module's Map and prove nothing about the
// file. Same reasoning, and same shape, as auditLog.test.js and
// jsonFileStore.test.js.
//
// THE DIRECTION THAT MATTERS MOST IS THE DEMOTION. A lost promotion is a
// nuisance - someone cannot do their job and says so within the hour. A lost
// DEMOTION is a security incident that announces itself to nobody: the person
// you removed access from has it again, and the audit trail says they were
// demoted. So that case gets its own test rather than being folded into
// "assignments persist".

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const AUTHZ = "./backend/src/services/authz/roleAssignments";
const AUDIT = "./backend/src/services/audit/auditLog";

// Two admins, so the last-admin guard does not fire on the ordinary cases.
const DIRECTORY = JSON.stringify([
  { userId: "ADMIN-D-1", role: "admin" },
  { userId: "ADMIN-D-2", role: "admin" },
  { userId: "CUST-D-1", role: "customer" },
]);

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
  }).trim();
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-rbac-"));
}

function main() {
  // ============================ an assignment survives a restart ============================
  const dir = freshDir();

  const written = inChildProcess(
    dir,
    "const a = require('" + AUTHZ + "');" +
      "const r = a.assignRole({ actorUserId: 'ADMIN-D-1', actorRole: 'admin', " +
      "targetUserId: 'CUST-D-1', role: 'advisor', reason: 'Nairobi desk', " +
      "correlationId: 'corr-durable-0001' }, { directory: " + DIRECTORY + " });" +
      "console.log(JSON.stringify([r.ok, r.reason, a.resolveRole('CUST-D-1', 'customer')]));"
  );
  assert.deepStrictEqual(JSON.parse(written), [true, "assigned", "advisor"]);

  // A DIFFERENT PROCESS, reading the same directory from disk. The directory
  // still claims "customer" - so if the assignment had not persisted, this
  // would come back "customer" and look perfectly healthy.
  const afterRestart = inChildProcess(
    dir,
    "const a = require('" + AUTHZ + "');" +
      "const found = a.findAssignment('CUST-D-1');" +
      "console.log(JSON.stringify([a.resolveRole('CUST-D-1', 'customer'), found.assignedBy, " +
      "found.previousRole, found.reason, found.correlationId]));"
  );
  assert.deepStrictEqual(JSON.parse(afterRestart), [
    "advisor",
    "ADMIN-D-1",
    "customer",
    "Nairobi desk",
    "corr-durable-0001",
  ]);
  console.log("roleAssignments.durability: an assignment is still in force in a new process");

  // The AUDIT trail for that change survives too. An assignment that persists
  // while its audit row does not is worse than losing both: the state changed
  // and the record of who changed it is gone.
  const auditAfterRestart = inChildProcess(
    dir,
    "const l = require('" + AUDIT + "');" +
      "const e = l.findAuditEntry('role-assign:corr-durable-0001:assigned');" +
      "const p = l.findAuditEntry('role-assign:corr-durable-0001:pending');" +
      "console.log(JSON.stringify([e.actor, e.resource, e.outcome, e.context.toRole, p.outcome]));"
  );
  assert.deepStrictEqual(JSON.parse(auditAfterRestart), [
    "ADMIN-D-1",
    "CUST-D-1",
    "success",
    "advisor",
    "pending",
  ]);
  console.log("roleAssignments.durability: the audit entries for the change survive with it");

  // IDEMPOTENCY HOLDS ACROSS THE RESTART, not just within one process. A retry
  // after a deploy must not be treated as a fresh change.
  const replayed = inChildProcess(
    dir,
    "const a = require('" + AUTHZ + "');" +
      "const r = a.assignRole({ actorUserId: 'ADMIN-D-1', actorRole: 'admin', " +
      "targetUserId: 'CUST-D-1', role: 'advisor', correlationId: 'corr-durable-0002' }, " +
      "{ directory: " + DIRECTORY + " });" +
      "console.log(JSON.stringify([r.ok, r.reason]));"
  );
  assert.deepStrictEqual(JSON.parse(replayed), [true, "unchanged"]);
  console.log("roleAssignments.durability: re-assigning after a restart is still a no-op");

  // NOTHING SENSITIVE IS ON DISK. The store holds who has what, which is
  // legitimately persisted - but it must not have acquired a credential along
  // the way. Read as raw bytes, not through the module, because the point is
  // what a person with disk access would see.
  const storeFile = path.join(dir, "role-assignments.json");
  const raw = fs.readFileSync(storeFile, "utf8");
  assert.ok(JSON.parse(raw), "the store must be readable JSON");
  for (const word of ["token", "password", "secret", "hash", "bearer"]) {
    assert.ok(
      !raw.toLowerCase().includes(word),
      "the assignment store must not contain the word " + word
    );
  }
  console.log("roleAssignments.durability: the store file holds roles and no credentials");

  fs.rmSync(dir, { recursive: true, force: true });

  // ====================== THE DANGEROUS DIRECTION: a demotion persists ======================
  const demotionDir = freshDir();

  const demoted = inChildProcess(
    demotionDir,
    "const a = require('" + AUTHZ + "');" +
      "const r = a.assignRole({ actorUserId: 'ADMIN-D-1', actorRole: 'admin', " +
      "targetUserId: 'ADMIN-D-2', role: 'customer', reason: 'left the team', " +
      "correlationId: 'corr-durable-demote' }, { directory: " + DIRECTORY + " });" +
      "console.log(JSON.stringify([r.ok, a.countAdmins(" + DIRECTORY + ")]));"
  );
  assert.deepStrictEqual(JSON.parse(demoted), [true, 1]);

  // A NEW PROCESS MUST NOT HAND THE ADMIN ROLE BACK. The directory - which is
  // the environment, and has not changed - still says ADMIN-D-2 is an admin.
  // The assignment has to win, or a deploy silently re-grants access that was
  // deliberately removed.
  const stillDemoted = inChildProcess(
    demotionDir,
    "const a = require('" + AUTHZ + "');" +
      "const p = require('./backend/src/services/authz/permissions');" +
      "const role = a.resolveRole('ADMIN-D-2', 'admin');" +
      "console.log(JSON.stringify([role, p.can(role, p.PERMISSIONS.ADMIN_ROLES_ASSIGN), " +
      "a.countAdmins(" + DIRECTORY + ")]));"
  );
  assert.deepStrictEqual(
    JSON.parse(stillDemoted),
    ["customer", false, 1],
    "a demotion must survive a restart, or the deploy re-grants what was removed"
  );
  console.log("roleAssignments.durability: a demoted admin stays demoted across a restart");

  // AND THE LAST-ADMIN GUARD IS COMPUTED FROM THE PERSISTED STATE. If the
  // count were rebuilt from the directory alone, a fresh process would see two
  // admins and happily demote the remaining one - straight to zero.
  const guardAfterRestart = inChildProcess(
    demotionDir,
    "const a = require('" + AUTHZ + "');" +
      "const r = a.assignRole({ actorUserId: 'ADMIN-D-2', actorRole: 'admin', " +
      "targetUserId: 'ADMIN-D-1', role: 'customer', correlationId: 'corr-durable-lastadmin' }, " +
      "{ directory: " + DIRECTORY + " });" +
      "console.log(JSON.stringify([r.ok, r.reason, a.countAdmins(" + DIRECTORY + ")]));"
  );
  assert.deepStrictEqual(
    JSON.parse(guardAfterRestart),
    [false, "last_admin", 1],
    "the last-admin guard must count the persisted state, not just the directory"
  );
  console.log("roleAssignments.durability: the last-admin guard survives a restart too");

  // ================== RECOVERY: losing the store falls back to the directory ==================
  // roleAssignments.js documents this as the recovery path - "if the store is
  // lost entirely, every user falls back to their directory role, which is the
  // safe direction". That claim is worth proving rather than asserting in a
  // comment, because it is the behaviour an operator will rely on at the worst
  // possible moment.
  //
  // NOTE THE HONEST COST: the demotion above is UNDONE by this. Falling back
  // is safe in the sense that the bootstrap admin can still log in and the
  // system is not wedged - it is NOT safe in the sense of preserving every
  // revocation. Losing this file means re-applying every role change, and the
  // audit trail (a separate file) is what tells you which.
  fs.rmSync(path.join(demotionDir, "role-assignments.json"));

  const afterLoss = inChildProcess(
    demotionDir,
    "const a = require('" + AUTHZ + "');" +
      "console.log(JSON.stringify([a.resolveRole('ADMIN-D-2', 'admin'), " +
      "a.countAdmins(" + DIRECTORY + "), a.findAssignment('ADMIN-D-2')]));"
  );
  assert.deepStrictEqual(
    JSON.parse(afterLoss),
    ["admin", 2, null],
    "a lost store must fall back to the directory, not to nobody having a role"
  );

  // The audit trail is a DIFFERENT file and is untouched by that loss, which
  // is what makes re-applying the changes possible at all.
  const trailSurvives = inChildProcess(
    demotionDir,
    "const l = require('" + AUDIT + "');" +
      "const e = l.findAuditEntry('role-assign:corr-durable-demote:assigned');" +
      "console.log(JSON.stringify([e.resource, e.context.fromRole, e.context.toRole]));"
  );
  assert.deepStrictEqual(JSON.parse(trailSurvives), ["ADMIN-D-2", "admin", "customer"]);
  console.log(
    "roleAssignments.durability: a lost store falls back to the directory, and the trail says what to re-apply"
  );

  fs.rmSync(demotionDir, { recursive: true, force: true });

  console.log("roleAssignments.durability: all tests passed");
}

main();
