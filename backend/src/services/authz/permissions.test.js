const assert = require("assert");

const {
  can,
  isKnownRole,
  isKnownPermission,
  assertKnownPermission,
  permissionsFor,
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLES,
  UnknownPermissionError,
} = require("./permissions");

function main() {
  // HAPPY PATH: each role can do its own work.
  assert.strictEqual(can("customer", PERMISSIONS.PORTAL_TRIPS_READ), true);
  assert.strictEqual(can("advisor", PERMISSIONS.ADVISOR_REVIEWS_READ), true);
  assert.strictEqual(can("admin", PERMISSIONS.ADMIN_ROLES_ASSIGN), true);
  console.log("permissions: each role holds the permissions its job needs");

  // ACCEPTANCE CRITERION 2, at the level of the model: customer rights reach
  // customer features ONLY. Every admin permission is denied to a customer.
  for (const adminPermission of [
    PERMISSIONS.ADMIN_ROLES_READ,
    PERMISSIONS.ADMIN_ROLES_ASSIGN,
    PERMISSIONS.ADMIN_AUDIT_READ,
  ]) {
    assert.strictEqual(
      can("customer", adminPermission),
      false,
      "a customer must not hold " + adminPermission
    );
    assert.strictEqual(
      can("advisor", adminPermission),
      false,
      "an advisor must not hold " + adminPermission
    );
  }
  console.log("permissions: no admin permission is reachable from customer or advisor");

  // NO INHERITANCE, AND THE TEST SAYS SO. If someone later makes admin
  // inherit from customer or advisor "for convenience", this fails - which is
  // the entire point of writing the grants out longhand.
  assert.strictEqual(can("admin", PERMISSIONS.PORTAL_TRIPS_READ), false);
  assert.strictEqual(can("admin", PERMISSIONS.ADVISOR_REVIEWS_READ), false);
  assert.strictEqual(can("advisor", PERMISSIONS.PORTAL_TRIPS_READ), false);
  console.log("permissions: admin is not a superuser and advisor is not a customer");

  // PERMISSION ESCALATION, as far as this pure module can be made to show it:
  // there is no input to can() that turns a customer into an admin.
  assert.strictEqual(can("customer admin", PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  assert.strictEqual(can("ADMIN", PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  assert.strictEqual(can(["customer", "admin"], PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  console.log("permissions: no near-miss role string is treated as admin");

  // FAILURE PATH - unknown role. Deny, do not throw: an unknown role reaches
  // here from data, and a request must get a 403, not a 500.
  assert.strictEqual(can("supplier", PERMISSIONS.CATALOG_READ), false);
  assert.strictEqual(can(undefined, PERMISSIONS.CATALOG_READ), false);
  assert.strictEqual(can(null, PERMISSIONS.CATALOG_READ), false);
  assert.strictEqual(can(42, PERMISSIONS.CATALOG_READ), false);

  // FAILURE PATH - unknown permission. Also deny. A renamed permission must
  // close a route, never open one.
  assert.strictEqual(can("admin", "admin.everything"), false);
  assert.strictEqual(can("admin", ""), false);
  assert.strictEqual(can("admin", undefined), false);
  console.log("permissions: unknown roles and unknown permissions are both denied");

  // PROTOTYPE-CHAIN KEYS. { role: "constructor" } off a request body must not
  // produce a truthy lookup.
  for (const poison of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.strictEqual(isKnownRole(poison), false, poison + " must not be a role");
    assert.strictEqual(can(poison, PERMISSIONS.CATALOG_READ), false);
    assert.deepStrictEqual(permissionsFor(poison), []);
  }
  console.log("permissions: prototype-chain keys are not roles");

  // The table a caller is handed is a COPY. Mutating it must not reach the
  // real grants - otherwise one careless caller escalates everybody.
  const customerPermissions = permissionsFor("customer");
  customerPermissions.push(PERMISSIONS.ADMIN_ROLES_ASSIGN);
  assert.strictEqual(
    can("customer", PERMISSIONS.ADMIN_ROLES_ASSIGN),
    false,
    "mutating the returned list must not grant a permission"
  );
  console.log("permissions: the live table cannot be mutated through permissionsFor");

  // Startup validation throws, so a route typo stops the server.
  assert.throws(
    function () {
      assertKnownPermission("admin.everythng", "GET /api/admin/roles");
    },
    function (error) {
      assert.ok(error instanceof UnknownPermissionError);
      // The message has to name the offending route, or a startup failure in a
      // table of 20 routes is a hunt.
      assert.ok(error.message.includes("GET /api/admin/roles"));
      assert.ok(error.message.includes("admin.everythng"));
      return true;
    }
  );
  assert.doesNotThrow(function () {
    assertKnownPermission(PERMISSIONS.CATALOG_READ, "GET /api/africa/destinations");
  });
  console.log("permissions: an unknown permission on a route is a startup error");

  // CONSISTENCY: every permission in the catalog is granted to at least one
  // role, and every granted permission is in the catalog. A permission nobody
  // holds is dead config that reads like a live rule; a granted string that is
  // not in the catalog can never be asked for by a route.
  const granted = new Set();
  for (const role of ROLES) {
    for (const permission of permissionsFor(role)) {
      assert.ok(
        isKnownPermission(permission),
        role + " is granted " + permission + ", which is not in the catalog"
      );
      granted.add(permission);
    }
  }
  for (const permission of ALL_PERMISSIONS) {
    assert.ok(granted.has(permission), permission + " is granted to no role");
  }
  assert.deepStrictEqual(ROLES.slice().sort(), ["admin", "advisor", "customer"]);
  console.log("permissions: catalog and grant table agree, with no orphans on either side");

  console.log("permissions: all tests passed");
}

main();
