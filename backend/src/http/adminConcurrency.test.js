// STORY-006 hardening: the role-assignment invariants under concurrency.
//
// admin.test.js drives one request at a time, which is how a permission bug
// hides. This suite fires requests SIMULTANEOUSLY and asserts the two
// properties that a sequential test cannot see:
//
//   1. THE SYSTEM NEVER REACHES ZERO ADMINS. Two admins demoting each other at
//      the same instant is the race that would do it, and it is not
//      hypothetical - it is what a pair of operators reacting to the same
//      incident would actually type.
//   2. A REPEATED CHANGE HAS ONE EFFECT. Ten identical promotions fired at
//      once must produce one state change and one audit entry, not ten.
//
// WHY THIS PASSES TODAY, WHICH IS THE THING WORTH UNDERSTANDING. assignRole is
// synchronous end to end, so Node cannot interleave two calls inside it and the
// read-then-write is atomic by construction. That is a real guarantee, but it
// is a fragile one: it holds because of how the function is written, not
// because anything enforces it. One `await` inside assignRole and the
// mutual-demotion case below starts landing on zero admins - silently, because
// the sequential tests would all still pass.
//
// So this file does two jobs. The structural assertion catches the change at
// the moment someone makes assignRole async. The HTTP race catches it if the
// yield sneaks in somewhere the structural check cannot see - a dependency
// turning async underneath, say.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const {
  assignRole,
  resolveRole,
  countAdmins,
  __resetAssignmentsForTests,
} = require("../services/authz/roleAssignments");
const { getAuditEntries } = require("../services/audit/auditLog");

const ADMIN_A_TOKEN = "test-admin-a-token-concurrency";
const ADMIN_B_TOKEN = "test-admin-b-token-concurrency";

const TOKENS = [
  ADMIN_A_TOKEN + ":admin:ADMIN-CC-A",
  ADMIN_B_TOKEN + ":admin:ADMIN-CC-B",
].join(",");

const DIRECTORY = [
  { userId: "ADMIN-CC-A", role: "admin" },
  { userId: "ADMIN-CC-B", role: "admin" },
];

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();

  // ------------------------------------------- the structural invariant, first
  // Cheap, and it is the assertion that will actually fire on the day someone
  // changes this - long before anyone thinks to re-read the race test.
  assert.notStrictEqual(
    assignRole.constructor.name,
    "AsyncFunction",
    "assignRole must not be async: the last-admin guard reads then writes, and a " +
      "yield between them lets two concurrent demotions both remove the last admin"
  );
  const returned = assignRole(
    {
      actorUserId: "ADMIN-CC-A",
      actorRole: "admin",
      targetUserId: "PROBE-CC-1",
      role: "customer",
      correlationId: "corr-cc-structural-probe",
    },
    { directory: DIRECTORY }
  );
  assert.ok(
    !(returned instanceof Promise),
    "assignRole must return a value, not a promise - see the header of roleAssignments.js"
  );
  console.log("adminConcurrency: assignRole is synchronous, so its read-then-write is atomic");

  const server = createServer({
    principals: loadPrincipals(TOKENS),
    credentials: null,
  });
  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;

  function assignCall(token, body) {
    return fetch(base + "/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
  }

  try {
    // ============================== THE MUTUAL DEMOTION RACE ==============================
    // A demotes B while B demotes A, dispatched together. Exactly one may win.
    //
    // THE WINNER IS DETERMINISTIC; THE LOSER'S STATUS CODE IS NOT, and that is
    // the subtle part. Which refusal fires depends on how far the second
    // request had got through the pipeline when the first one committed:
    //
    //   403  the second request had NOT been authenticated yet. By the time it
    //        was, the assignment store already said "customer", so the boundary
    //        resolved its role to customer and refused it before the handler
    //        ran. This is per-request role resolution doing exactly its job -
    //        a demoted admin loses their powers mid-flight.
    //   409  the second request HAD been authenticated, so it carried an admin
    //        role into the handler, reached assignRole, and was stopped by the
    //        last-admin guard.
    //
    // Both are correct and both preserve the invariant, so this asserts the
    // invariant and accepts either code. Pinning one would make the test
    // flaky on a machine that schedules the sockets differently - and would be
    // asserting the scheduler rather than the behaviour.
    //
    // This also QUALIFIES a claim in admin.test.js, which records last_admin as
    // unreachable over HTTP. That holds for SEQUENTIAL requests, where
    // self_assignment always fires first. Concurrently, the 409 branch above
    // is reachable - so the guard is not merely defence for the script path
    // after all.
    assert.strictEqual(countAdmins(DIRECTORY), 2);

    const [aDemotesB, bDemotesA] = await Promise.all([
      assignCall(ADMIN_A_TOKEN, { userId: "ADMIN-CC-B", role: "customer" }),
      assignCall(ADMIN_B_TOKEN, { userId: "ADMIN-CC-A", role: "customer" }),
    ]);

    const statuses = [aDemotesB.status, bDemotesA.status];
    assert.strictEqual(
      statuses.filter(function (status) {
        return status === 200;
      }).length,
      1,
      "exactly one mutual demotion may succeed"
    );

    const loser = aDemotesB.status === 200 ? bDemotesA : aDemotesB;
    assert.ok(
      loser.status === 403 || loser.status === 409,
      "the losing demotion must be refused, by the boundary (403) or the last-admin guard (409); got " +
        loser.status
    );
    const loserBody = await loser.json();
    assert.ok(
      ["forbidden", "last_admin"].includes(loserBody.error),
      "the refusal must name a guard, not a generic failure; got " + loserBody.error
    );

    // THE INVARIANT ITSELF, asserted on the state rather than on the responses.
    // A pair of status codes could look right while the store ended up wrong -
    // this is the assertion that actually protects the system.
    assert.strictEqual(countAdmins(DIRECTORY), 1, "the system must never reach zero admins");

    // And the surviving admin can still do admin work - a system with one
    // admin left must not be wedged.
    const survivorToken =
      resolveRole("ADMIN-CC-A", "admin") === "admin" ? ADMIN_A_TOKEN : ADMIN_B_TOKEN;
    const stillWorks = await fetch(base + "/api/admin/roles", {
      headers: { Authorization: "Bearer " + survivorToken },
    });
    assert.strictEqual(stillWorks.status, 200, "the surviving admin must still hold their powers");

    // ...and the demoted one has genuinely lost them.
    const demotedToken = survivorToken === ADMIN_A_TOKEN ? ADMIN_B_TOKEN : ADMIN_A_TOKEN;
    const lostThem = await fetch(base + "/api/admin/roles", {
      headers: { Authorization: "Bearer " + demotedToken },
    });
    assert.strictEqual(lostThem.status, 403, "the demoted admin must lose access immediately");
    console.log(
      "adminConcurrency: two admins demoting each other at once leaves exactly one admin standing"
    );

    // ======================== A REPEATED CHANGE HAS ONE EFFECT ========================
    // Ten identical promotions, fired together, each with its own correlation
    // id - so this is not the replay case the audit key already dedups. It is
    // ten genuinely distinct requests that happen to ask for the same thing.
    const before = getAuditEntries().length;

    const responses = await Promise.all(
      Array.from({ length: 10 }, function () {
        return assignCall(survivorToken, { userId: "CUST-CC-1", role: "advisor" });
      })
    );

    const bodies = await Promise.all(
      responses.map(function (res) {
        return res.json();
      })
    );
    for (const res of responses) {
      assert.strictEqual(res.status, 200, "every identical promotion must be accepted");
    }

    const assigned = bodies.filter(function (body) {
      return body.status === "assigned";
    });
    const unchanged = bodies.filter(function (body) {
      return body.status === "unchanged";
    });
    assert.strictEqual(assigned.length, 1, "exactly one request may report a real change");
    assert.strictEqual(unchanged.length, 9, "the other nine must report no change, not an error");
    assert.strictEqual(resolveRole("CUST-CC-1", null), "advisor");

    // THE SIDE EFFECT IS ONCE, not ten times. Statuses can be right while the
    // trail records the change ten times over, which would make the audit log
    // lie about what happened.
    const entries = getAuditEntries().slice(before);
    const changes = entries.filter(function (entry) {
      return entry.event === "authz.role_assignment.changed" && entry.resource === "CUST-CC-1";
    });
    assert.strictEqual(changes.length, 1, "the trail must record one change, not ten");
    assert.strictEqual(changes[0].context.fromRole, null);
    assert.strictEqual(changes[0].context.toRole, "advisor");

    // The other nine are recorded too - as `unchanged`, not as nothing. An
    // attempt that happened and was a no-op is still an attempt, and an
    // auditor asking "who tried to touch this role?" needs all ten.
    const noops = entries.filter(function (entry) {
      return entry.event === "authz.role_assignment.unchanged" && entry.resource === "CUST-CC-1";
    });
    assert.strictEqual(noops.length, 9, "every no-op attempt must still be on the record");
    console.log(
      "adminConcurrency: ten simultaneous identical promotions change the state once and audit all ten"
    );

    // ==================== A BURST OF CONTRADICTORY CHANGES STILL SETTLES ====================
    // Twenty requests alternating between two roles. The final state is a race
    // and is not asserted - what IS asserted is that it is one of the two
    // legal values rather than a torn or absent row, and that the trail
    // accounts for every request.
    const beforeBurst = getAuditEntries().length;
    const burst = await Promise.all(
      Array.from({ length: 20 }, function (_unused, index) {
        return assignCall(survivorToken, {
          userId: "CUST-CC-2",
          role: index % 2 === 0 ? "advisor" : "customer",
        });
      })
    );
    for (const res of burst) {
      assert.strictEqual(res.status, 200);
    }

    const settled = resolveRole("CUST-CC-2", null);
    assert.ok(
      settled === "advisor" || settled === "customer",
      "a contradictory burst must settle on a legal role, not a torn one"
    );

    const burstEntries = getAuditEntries()
      .slice(beforeBurst)
      .filter(function (entry) {
        return entry.resource === "CUST-CC-2" && entry.event.startsWith("authz.role_assignment.");
      });
    const accounted = burstEntries.filter(function (entry) {
      // `attempted` is the write-ahead half of a change and pairs with a
      // `changed`, so it is not counted as a separate request.
      return entry.event !== "authz.role_assignment.attempted";
    });
    assert.strictEqual(accounted.length, 20, "every request in the burst must be on the record");
    console.log(
      "adminConcurrency: a contradictory burst settles on a legal role with all 20 accounted for"
    );
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }

  console.log("adminConcurrency: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
