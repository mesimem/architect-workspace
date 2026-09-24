// STORY-006: role-based permissions, tested over real HTTP.
//
// The service suites prove the DECISIONS - permissions.test.js that the table
// is right, roleAssignments.test.js that a role change is guarded and audited.
// This suite proves the WIRING, which is where an access-control bug actually
// lives: that the permission a route declares is the one enforced, that a
// customer's credential cannot reach an admin endpoint however it is
// presented, and that a role change made through the API takes effect on a
// session that was issued before it.
//
// Each of the story's three acceptance criteria is marked below, as is each of
// its three named failure paths.
//
// The tokens and passwords are test fixtures. They exist only in this process;
// the server reads its real tables from the environment.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { hashPassword } = require("../services/portal/portalCredentials");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests, resolveRole } = require("../services/authz/roleAssignments");
const { PERMISSIONS } = require("../services/authz/permissions");

const ADMIN_TOKEN = "test-admin-token-rbac";
const CUSTOMER_TOKEN = "test-customer-token-rbac";
const ADVISOR_TOKEN = "test-advisor-token-rbac";

const TOKENS = [
  ADMIN_TOKEN + ":admin:ADMIN-RBAC-1",
  CUSTOMER_TOKEN + ":customer:CUST-RBAC-1",
  ADVISOR_TOKEN + ":advisor:ADV-RBAC-1",
].join(",");

const SESSION_CUSTOMER = "CUST-RBAC-2";
const PASSWORD = "serengeti-migration-2026";

const ADMIN_PATHS = ["/api/admin/roles", "/api/admin/audit"];

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  clearFailureTracking();

  const credentials = new Map([[SESSION_CUSTOMER, await hashPassword(PASSWORD)]]);

  const server = createServer({
    principals: loadPrincipals(TOKENS),
    credentials: credentials,
  });
  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;

  function call(path, options = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (options.token) {
      headers.Authorization = "Bearer " + options.token;
    }
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  function assignCall(token, body) {
    return call("/api/admin/roles", { method: "POST", token: token, body: body });
  }

  async function auditEvents(token) {
    const res = await call("/api/admin/audit", { token: token });
    assert.strictEqual(res.status, 200);
    return (await res.json()).entries;
  }

  try {
    // =================================================== ACCEPTANCE CRITERION 1
    // "Given a user logs in, when they have admin rights, then they access
    // admin features." All three admin endpoints, because each names a
    // DIFFERENT permission - passing one proves nothing about the other two.
    const rolesRes = await call("/api/admin/roles", { token: ADMIN_TOKEN });
    assert.strictEqual(rolesRes.status, 200);
    const listed = await rolesRes.json();
    assert.deepStrictEqual(
      listed.roles.map(function (entry) {
        return [entry.userId, entry.role, entry.source];
      }),
      [
        ["ADMIN-RBAC-1", "admin", "directory"],
        ["ADV-RBAC-1", "advisor", "directory"],
        ["CUST-RBAC-1", "customer", "directory"],
      ]
    );

    // NO TOKEN IS EVER IN A RESPONSE. The directory is built from the same
    // principal list that holds the bearer tokens, so this is the assertion
    // that the projection in createServer actually dropped them.
    const rolesText = JSON.stringify(listed);
    for (const secret of [ADMIN_TOKEN, CUSTOMER_TOKEN, ADVISOR_TOKEN, PASSWORD]) {
      assert.ok(!rolesText.includes(secret), "a credential leaked into GET /api/admin/roles");
    }

    assert.strictEqual((await call("/api/admin/audit", { token: ADMIN_TOKEN })).status, 200);

    // Assigned to someone who is NOT in the directory - a real case, and the
    // one listRoles explicitly unions for: a role granted before the person's
    // credential has been provisioned. Their previous role is null, not
    // "customer", because the system had never heard of them.
    const promote = await assignCall(ADMIN_TOKEN, {
      userId: "CUST-RBAC-3",
      role: "advisor",
      reason: "covering the Nairobi desk",
    });
    assert.strictEqual(promote.status, 200);
    const promoted = await promote.json();
    assert.strictEqual(promoted.status, "assigned");
    assert.strictEqual(promoted.assignment.previousRole, null);
    assert.strictEqual(promoted.assignment.assignedBy, "ADMIN-RBAC-1");
    console.log("adminHttp: CRITERION 1 - an admin reaches all three admin features");

    // ==================================================== ACCEPTANCE CRITERION 2
    // "...when they have customer rights, then they access customer features
    // ONLY." Two halves, and the second is the one usually left untested: that
    // the customer can still do their own job. A permission layer that locks
    // everybody out passes the first half perfectly.
    for (const path of ADMIN_PATHS) {
      const denied = await call(path, { token: CUSTOMER_TOKEN });
      assert.strictEqual(denied.status, 403, "a customer must not read " + path);
      const body = await denied.json();
      assert.strictEqual(body.error, "forbidden");
      // The refusal does not name the permission it wanted. Telling a caller
      // exactly which permission to look for is a map of the admin surface.
      assert.ok(!JSON.stringify(body).includes("admin.roles"));
    }
    assert.strictEqual(
      (await assignCall(CUSTOMER_TOKEN, { userId: "ADV-RBAC-1", role: "customer" })).status,
      403
    );

    // The customer's own features still work.
    const trips = await call("/api/portal/trips", { token: CUSTOMER_TOKEN });
    assert.strictEqual(trips.status, 200, "a customer must still reach their own trips");
    assert.strictEqual(
      (await call("/api/africa/destinations", { token: CUSTOMER_TOKEN })).status,
      200
    );
    console.log("adminHttp: CRITERION 2 - a customer is refused admin features and keeps their own");

    // AN ADVISOR IS NOT AN ADMIN EITHER. The nearest role to the privilege is
    // still short of it - the case a hierarchy would have got wrong.
    for (const path of ADMIN_PATHS) {
      assert.strictEqual(
        (await call(path, { token: ADVISOR_TOKEN })).status,
        403,
        "an advisor must not read " + path
      );
    }
    assert.strictEqual((await call("/api/advisor/reviews", { token: ADVISOR_TOKEN })).status, 200);
    // ...and an ADMIN is not a customer or an advisor. Admin is not a superuser.
    assert.strictEqual((await call("/api/advisor/reviews", { token: ADMIN_TOKEN })).status, 403);
    assert.strictEqual((await call("/api/portal/trips", { token: ADMIN_TOKEN })).status, 403);
    console.log("adminHttp: no role reaches another role's features, in either direction");

    // ============================================ FAILURE PATH: UNAUTHORIZED ACCESS
    // 401, never 403. The difference matters: a 403 confirms the endpoint
    // exists and that the caller's credential was recognised. An anonymous
    // caller must learn neither.
    for (const path of ADMIN_PATHS) {
      assert.strictEqual((await call(path)).status, 401, "no credential must be 401 on " + path);
      assert.strictEqual(
        (await call(path, { token: "not-a-real-token-at-all" })).status,
        401,
        "an unknown credential must be 401 on " + path
      );
      assert.strictEqual(
        (await call(path, { headers: { Authorization: "Basic " + ADMIN_TOKEN } })).status,
        401,
        "the wrong auth scheme must be 401 on " + path
      );
    }
    console.log("adminHttp: FAILURE PATH - an unauthenticated caller gets 401, never 403");

    // ========================================== FAILURE PATH: PERMISSION ESCALATION
    // The direct attempt: a customer promoting themselves.
    const escalation = await assignCall(CUSTOMER_TOKEN, {
      userId: "CUST-RBAC-1",
      role: "admin",
    });
    assert.strictEqual(escalation.status, 403);
    assert.notStrictEqual(
      resolveRole("CUST-RBAC-1", "customer"),
      "admin",
      "a refused escalation must not change the role"
    );

    // The attempt cannot be laundered through the body. `actorRole` comes from
    // the resolved principal, never from what the caller sends - so nominating
    // your own authority does nothing.
    assert.strictEqual(
      (
        await assignCall(CUSTOMER_TOKEN, {
          userId: "CUST-RBAC-1",
          role: "admin",
          actorRole: "admin",
          principal: { role: "admin" },
        })
      ).status,
      403
    );
    console.log("adminHttp: FAILURE PATH - a customer cannot escalate, by body or by token");

    // A ROLE CHANGE REACHES AN ALREADY-ISSUED SESSION. The escalation guard
    // above is only half the story: the other half is that a legitimate change
    // takes effect NOW, not whenever a 12-hour session happens to expire.
    // CUST-RBAC-1 was promoted to advisor at the top of this suite.
    const login = await call("/api/portal/login", {
      method: "POST",
      body: { customerId: SESSION_CUSTOMER, password: PASSWORD },
    });
    assert.strictEqual(login.status, 200);
    const sessionToken = (await login.json()).token;

    // Issued as a customer: reaches their trips, refused the advisor queue.
    assert.strictEqual((await call("/api/portal/trips", { token: sessionToken })).status, 200);
    assert.strictEqual((await call("/api/advisor/reviews", { token: sessionToken })).status, 403);

    const sessionPromotion = await assignCall(ADMIN_TOKEN, {
      userId: SESSION_CUSTOMER,
      role: "advisor",
    });
    assert.strictEqual(sessionPromotion.status, 200);

    // SAME TOKEN, NO NEW LOGIN. The role flipped underneath it, in both
    // directions: the advisor queue opened and the customer trips closed.
    assert.strictEqual(
      (await call("/api/advisor/reviews", { token: sessionToken })).status,
      200,
      "the promotion must reach the session that was already issued"
    );
    assert.strictEqual(
      (await call("/api/portal/trips", { token: sessionToken })).status,
      403,
      "the old role's access must be withdrawn by the same change"
    );
    console.log("adminHttp: a role change takes effect on a live session, both ways");

    // ========================================= FAILURE PATH: ROLE ASSIGNMENT ERROR
    // Unknown role - the typo that would otherwise create a user holding
    // nothing, which reads in the store like a grant and behaves like a lockout.
    const typo = await assignCall(ADMIN_TOKEN, { userId: "CUST-RBAC-1", role: "admn" });
    assert.strictEqual(typo.status, 400);
    assert.strictEqual((await typo.json()).error, "unknown_role");

    // ...including the prototype-chain names, which arrive from a JSON body.
    for (const poison of ["constructor", "__proto__", "toString"]) {
      assert.strictEqual(
        (await assignCall(ADMIN_TOKEN, { userId: "CUST-RBAC-1", role: poison })).status,
        400,
        poison + " must not be assignable over HTTP"
      );
    }
    assert.strictEqual(
      resolveRole("CUST-RBAC-1", "customer"),
      "customer",
      "a refused assignment leaves the role exactly as it was"
    );

    // Malformed target, and a malformed envelope. Different codes, because one
    // is a rejected assignment and the other never became one.
    assert.strictEqual(
      (await assignCall(ADMIN_TOKEN, { userId: "CUST RBAC 1", role: "customer" })).status,
      400
    );
    const noBody = await assignCall(ADMIN_TOKEN, { role: "customer" });
    assert.strictEqual(noBody.status, 400);
    assert.strictEqual((await noBody.json()).error, "invalid_request_body");

    // SELF-ASSIGNMENT, including the case that looks like it should be 409.
    // ADMIN-RBAC-1 is the only admin, so demoting themselves would also trip
    // the last-admin guard - but self-assignment is checked first and wins.
    //
    // WHICH MEANS last_admin IS UNREACHABLE OVER HTTP, and that is worth
    // stating rather than leaving as a surprise: the only caller who could
    // demote the final admin is that admin, and self-assignment stops them
    // first. The guard still earns its place, because assignRole() is also
    // callable from a script with no HTTP boundary in front of it - which is
    // the path roleAssignments.test.js exercises for the 409.
    const self = await assignCall(ADMIN_TOKEN, { userId: "ADMIN-RBAC-1", role: "customer" });
    assert.strictEqual(self.status, 403);
    assert.strictEqual((await self.json()).error, "self_assignment");
    assert.strictEqual(resolveRole("ADMIN-RBAC-1", "admin"), "admin");
    console.log("adminHttp: FAILURE PATH - bad roles, bad targets and self-assignment are refused");

    // IDEMPOTENT: assigning a role the user already holds changes nothing.
    const again = await assignCall(ADMIN_TOKEN, { userId: "CUST-RBAC-3", role: "advisor" });
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await again.json()).status, "unchanged");
    console.log("adminHttp: re-assigning the same role is idempotent");

    // =================================================== ACCEPTANCE CRITERION 3
    // "Trust: the system logs all access attempts and changes in permissions."
    // Read through the API, so this is what an auditor would actually see.
    const entries = await auditEvents(ADMIN_TOKEN);

    // ...changes in permissions.
    const change = entries.find(function (entry) {
      return entry.event === "authz.role_assignment.changed" && entry.resource === "CUST-RBAC-3";
    });
    assert.ok(change, "the role change must be in the audit trail");
    assert.strictEqual(change.actor, "ADMIN-RBAC-1");
    assert.strictEqual(change.outcome, "success");
    assert.deepStrictEqual(change.context, {
      fromRole: null,
      toRole: "advisor",
      reason: "covering the Nairobi desk",
    });
    assert.ok(change.correlationId, "every entry is traceable to one request");

    // ...and the REFUSED change, which is the more interesting line.
    //
    // IT IS AUDITED AS AN ACCESS DENIAL, NOT AN ASSIGNMENT REFUSAL, and that
    // is the correct layering rather than a gap: POST /api/admin/roles
    // requires admin.roles.assign, so the pipeline refuses a customer before
    // the handler runs and assignRole() is never reached. Two guards, the
    // outer one firing first.
    //
    // Which means assignRole's own `not_permitted` refusal - like its
    // `last_admin` refusal - is unreachable over HTTP. Both still earn their
    // place: assignRole is also callable from a script with no boundary in
    // front of it, and roleAssignments.test.js exercises that path. A guard
    // that is only reachable one way must not be deleted because the other way
    // happens to be covered.
    const refused = entries.find(function (entry) {
      return (
        entry.event === "authz.access.denied" &&
        entry.actor === "CUST-RBAC-1" &&
        entry.resource === "/api/admin/roles"
      );
    });
    assert.ok(refused, "the refused escalation must be in the audit trail");
    assert.strictEqual(refused.outcome, "failure");
    assert.strictEqual(refused.context.method, "POST");
    assert.strictEqual(refused.context.requiredPermission, PERMISSIONS.ADMIN_ROLES_ASSIGN);
    assert.strictEqual(refused.context.role, "customer");

    // The refusals that DO come from the service are in the trail too - the
    // unknown-role typo, which an admin reached because they had the
    // permission and was refused on the merits.
    const badRole = entries.find(function (entry) {
      return (
        entry.event === "authz.role_assignment.refused" &&
        entry.context.reason === "unknown_role"
      );
    });
    assert.ok(badRole, "a refused role assignment must be in the audit trail");
    assert.strictEqual(badRole.actor, "ADMIN-RBAC-1");
    assert.strictEqual(badRole.outcome, "failure");

    // ...access attempts. A denied request by a known caller, with the
    // permission it wanted and the path it wanted it on.
    const denied = entries.find(function (entry) {
      return entry.event === "authz.access.denied" && entry.resource === "/api/admin/audit";
    });
    assert.ok(denied, "a denied access attempt must be in the audit trail");
    assert.strictEqual(denied.outcome, "failure");
    assert.strictEqual(denied.context.requiredPermission, PERMISSIONS.ADMIN_AUDIT_READ);
    assert.ok(["CUST-RBAC-1", "ADV-RBAC-1"].includes(denied.actor));

    // NO CREDENTIAL IS ANYWHERE IN THE TRAIL. The audit store is the one place
    // that keeps caller-supplied context on disk forever, so a leak here
    // outlives the incident that caused it.
    const trail = JSON.stringify(entries);
    for (const secret of [ADMIN_TOKEN, CUSTOMER_TOKEN, ADVISOR_TOKEN, PASSWORD, sessionToken]) {
      assert.ok(!trail.includes(secret), "a credential leaked into the audit trail");
    }
    console.log("adminHttp: CRITERION 3 - access attempts and permission changes are both audited");

    // The trail is read-only through the API: there is no route that edits it.
    assert.strictEqual(
      (await call("/api/admin/audit", { method: "POST", token: ADMIN_TOKEN, body: {} })).status,
      405,
      "the audit trail must not be writable over HTTP"
    );
    console.log("adminHttp: the audit trail is append-only from outside");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }

  // ============================================ THE STARTUP GUARD ACTUALLY FIRES
  // Without this the validation could be deleted and every other test here
  // would still pass - it only ever runs against a route table that is already
  // correct. Re-required in a child-free way by calling it through the module
  // it lives in would need an export; instead this asserts the two shapes it
  // must reject, using the real ROUTES table plus one bad entry.
  const { ROUTES } = require("./routes");
  const assertRoutes = require("./server").__assertRoutesDeclarePermissions;

  assert.throws(
    function () {
      assertRoutes(ROUTES.concat([{ method: "GET", pattern: /^\/x$/, permission: "admin.everythng" }]));
    },
    /Unknown permission/,
    "a route naming a permission that does not exist must stop the process"
  );
  assert.throws(
    function () {
      assertRoutes(ROUTES.concat([{ method: "GET", pattern: /^\/x$/ }]));
    },
    /declares no permission/,
    "a route that forgets its permission must stop the process"
  );
  assert.throws(
    function () {
      assertRoutes(
        ROUTES.concat([
          { method: "GET", pattern: /^\/x$/, public: true, permission: PERMISSIONS.CATALOG_READ },
        ])
      );
    },
    /public and also names a permission/,
    "a route cannot be both public and permissioned"
  );
  assert.doesNotThrow(function () {
    assertRoutes(ROUTES);
  }, "the real route table must be valid");
  console.log("adminHttp: the startup route guard rejects every malformed declaration");

  console.log("adminHttp: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
