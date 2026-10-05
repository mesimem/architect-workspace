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
  assert.deepStrictEqual(ROLES.slice().sort(), [
    "admin",
    "advisor",
    "customer",
    "operations_manager",
    "product_manager",
    "sales",
  ]);
  console.log("permissions: catalog and grant table agree, with no orphans on either side");

  // STORY-014: the CRM grants, stated as the blast radius of a leaked token
  // rather than as a list of features. Each negative below is a rule from this
  // module's header that a later story could undo by accident.
  assert.strictEqual(can("sales", PERMISSIONS.CRM_LEADS_READ), true);
  assert.strictEqual(can("sales", PERMISSIONS.CRM_LEADS_WRITE), true);
  assert.strictEqual(can("sales", PERMISSIONS.CRM_CUSTOMERS_READ), true);

  // Nobody else reaches the CRM. Written out per role, because "no other role
  // has it" is the claim, and a loop over ROLES would silently pass the day a
  // fifth role is added with CRM access.
  for (const permission of [
    PERMISSIONS.CRM_LEADS_READ,
    PERMISSIONS.CRM_LEADS_WRITE,
    PERMISSIONS.CRM_CUSTOMERS_READ,
  ]) {
    assert.strictEqual(can("customer", permission), false, "customer must not hold " + permission);
    assert.strictEqual(can("advisor", permission), false, "advisor must not hold " + permission);
    assert.strictEqual(can("admin", permission), false, "admin must not hold " + permission);
    // STORY-015 is the fifth role this block's comment above predicted. Added
    // by hand, for the reason stated there: a loop over ROLES would have passed
    // silently while the claim "the CRM is reachable by sales alone" quietly
    // stopped being proven.
    assert.strictEqual(
      can("product_manager", permission),
      false,
      "product_manager must not hold " + permission
    );
  }

  // And sales does not drift into everyone else's job.
  assert.strictEqual(can("sales", PERMISSIONS.ADMIN_AUDIT_READ), false);
  assert.strictEqual(can("sales", PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  assert.strictEqual(can("sales", PERMISSIONS.ADVISOR_REVIEWS_READ), false);
  assert.strictEqual(can("sales", PERMISSIONS.PORTAL_TRIPS_READ), false);
  console.log("permissions: the CRM is reachable by sales alone, and sales reaches nothing else");

  // STORY-015: the product grants, stated as blast radius. The read/write split
  // is the whole point of having two permissions, so it is asserted rather than
  // described: an advisor sells from the book, a product manager authors it.
  assert.strictEqual(can("product_manager", PERMISSIONS.PRODUCTS_READ), true);
  assert.strictEqual(can("product_manager", PERMISSIONS.PRODUCTS_WRITE), true);
  assert.strictEqual(can("advisor", PERMISSIONS.PRODUCTS_READ), true);
  assert.strictEqual(
    can("advisor", PERMISSIONS.PRODUCTS_WRITE),
    false,
    "an advisor must not be able to reprice a package"
  );

  // A product record carries pricing.internal - our supplier cost and our
  // margin - so a customer holding either grant would be reading our margin.
  // Written per role rather than as a loop, for the reason the CRM block above
  // gives: a loop would pass the day a sixth role arrives with product access.
  for (const permission of [PERMISSIONS.PRODUCTS_READ, PERMISSIONS.PRODUCTS_WRITE]) {
    assert.strictEqual(can("customer", permission), false, "customer must not hold " + permission);
    assert.strictEqual(can("sales", permission), false, "sales must not hold " + permission);
    // An admin administers the system; it does not author the inventory. See
    // "ADMIN IS NOT A SUPERUSER" in the module header.
    assert.strictEqual(can("admin", permission), false, "admin must not hold " + permission);
  }

  // And a product manager does not drift into everyone else's job.
  assert.strictEqual(can("product_manager", PERMISSIONS.ADMIN_AUDIT_READ), false);
  assert.strictEqual(can("product_manager", PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  assert.strictEqual(can("product_manager", PERMISSIONS.QUOTES_WRITE), false);
  assert.strictEqual(can("product_manager", PERMISSIONS.PROPOSALS_WRITE), false);
  assert.strictEqual(can("product_manager", PERMISSIONS.ADVISOR_REVIEWS_READ), false);
  assert.strictEqual(can("product_manager", PERMISSIONS.PORTAL_TRIPS_READ), false);
  console.log("permissions: an advisor sells from the product book, a product manager authors it");

  // STORY-017. The package grants, and the LINE THEY DRAW AGAINST the product
  // grants above: an advisor may combine the Masai Mara package into an
  // offering and may not change what the Masai Mara package costs. Those two
  // facts sitting next to each other are the whole argument for packages.write
  // being its own permission rather than part of products.write.
  assert.strictEqual(can("advisor", PERMISSIONS.PACKAGES_READ), true);
  assert.strictEqual(can("advisor", PERMISSIONS.PACKAGES_WRITE), true);
  assert.strictEqual(
    can("advisor", PERMISSIONS.PRODUCTS_WRITE),
    false,
    "an advisor composes packages but must not reprice the products inside them"
  );
  assert.strictEqual(can("product_manager", PERMISSIONS.PACKAGES_READ), true);
  assert.strictEqual(can("product_manager", PERMISSIONS.PACKAGES_WRITE), true);

  // A package carries pricing.internal - the combined cost and margin across
  // every product in it - so the same roles that are kept away from a product's
  // margin are kept away from a package's. Written per role rather than as a
  // loop, for the reason the CRM block above gives.
  for (const permission of [PERMISSIONS.PACKAGES_READ, PERMISSIONS.PACKAGES_WRITE]) {
    assert.strictEqual(can("customer", permission), false, "customer must not hold " + permission);
    assert.strictEqual(can("sales", permission), false, "sales must not hold " + permission);
    assert.strictEqual(can("admin", permission), false, "admin must not hold " + permission);
  }
  console.log("permissions: packages are composed by advisors and product managers alone");

  // STORY-010: the supplier grants, stated as blast radius. The advisor is the
  // ONLY role holding either half, which is a stronger claim than the product
  // block above makes and so is asserted against every other role by name.
  assert.strictEqual(can("advisor", PERMISSIONS.SUPPLIERS_READ), true);
  assert.strictEqual(can("advisor", PERMISSIONS.SUPPLIERS_WRITE), true);

  // A supplier record carries the COST BASE every margin is computed from, for
  // every package that supplier appears in - a wider exposure than any single
  // product's pricing.internal. Written per role rather than as a loop, for the
  // reason the two blocks above give: a loop over ROLES would pass silently the
  // day a sixth role arrives holding supplier access.
  for (const permission of [PERMISSIONS.SUPPLIERS_READ, PERMISSIONS.SUPPLIERS_WRITE]) {
    // The one that matters most. A customer holding this reads what we pay,
    // which is the single figure that makes every quote we have issued
    // negotiable.
    assert.strictEqual(can("customer", permission), false, "customer must not hold " + permission);
    assert.strictEqual(can("sales", permission), false, "sales must not hold " + permission);
    // An admin administers the system. It holds ADMIN_AUDIT_READ, and the trail
    // is what records who changed a supplier's terms - a role that can both
    // alter a contract and read the record of having altered it is the conflict
    // of interest this table keeps breaking up.
    assert.strictEqual(can("admin", permission), false, "admin must not hold " + permission);
    // Arguable, and deliberately refused: a product manager prices packages
    // against supplier cost, so a read here could be justified. It was not
    // granted, because arguable is not a reason to grant. If a later story asks
    // for it, that is one row and this assertion is the thing that will make
    // the change deliberate rather than accidental.
    assert.strictEqual(
      can("product_manager", permission),
      false,
      "product_manager must not hold " + permission
    );
  }

  // The supplier grants did not drag the advisor into anyone else's job. Each
  // of these is a rule from this module's header that STORY-010 could have
  // undone by accident - notably "advisor: NOT customer data by default",
  // which a supplier grant has no reason to touch and must not.
  assert.strictEqual(can("advisor", PERMISSIONS.CRM_CUSTOMERS_READ), false);
  assert.strictEqual(can("advisor", PERMISSIONS.ADMIN_AUDIT_READ), false);
  assert.strictEqual(can("advisor", PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  assert.strictEqual(can("advisor", PERMISSIONS.PRODUCTS_WRITE), false);
  console.log("permissions: the supplier book is reachable by the advisor alone");

  // STORY-018: the operations booking board, stated as blast radius. The read
  // is the dangerous half here - it returns every booking the agency holds in
  // one response - which is the opposite of the usual intuition and the reason
  // each negative below is worth writing out.
  assert.strictEqual(can("operations_manager", PERMISSIONS.OPS_BOOKINGS_READ), true);
  assert.strictEqual(can("operations_manager", PERMISSIONS.OPS_BOOKINGS_WRITE), true);

  // Nobody else reaches the booking board. Written out per role rather than as
  // a loop, for the reason the CRM block above gives: a loop would pass
  // silently the day a seventh role is added with booking access, and the claim
  // being made here is precisely "no other role has this".
  for (const permission of [PERMISSIONS.OPS_BOOKINGS_READ, PERMISSIONS.OPS_BOOKINGS_WRITE]) {
    assert.strictEqual(
      can("customer", permission),
      false,
      "a customer must not hold " + permission + " - it exposes every other customer's trips"
    );
    assert.strictEqual(can("advisor", permission), false, "advisor must not hold " + permission);
    assert.strictEqual(
      can("product_manager", permission),
      false,
      "product_manager must not hold " + permission
    );
    // Both deliberately refused, and both were the cheaper alternative to
    // adding this role at all. `sales` holds customer relationships, but the
    // board is EVERY customer's booking at once - strictly wider than the
    // relationship-scoped read CRM_CUSTOMERS_READ was argued for. `admin`
    // operates the system, and granting it here would mean the role that reads
    // the audit trail is also the role that can cancel a booking.
    assert.strictEqual(can("sales", permission), false, "sales must not hold " + permission);
    assert.strictEqual(can("admin", permission), false, "admin must not hold " + permission);
  }

  // And an operations manager does not drift into everyone else's job. The
  // first of these is the one that matters most: the trail records what an
  // operations manager did to a booking, so a role that could both change a
  // status and read the record of having changed it is a weaker control than
  // two people - the same conflict of interest this table keeps breaking up.
  assert.strictEqual(
    can("operations_manager", PERMISSIONS.ADMIN_AUDIT_READ),
    false,
    "an operations manager must not read the trail that records what they did"
  );
  assert.strictEqual(can("operations_manager", PERMISSIONS.ADMIN_ROLES_ASSIGN), false);
  // Operations DELIVER what was sold; they do not reprice or re-author it, and
  // they do not sell. The reads below are granted, the writes are not, and that
  // split is the whole shape of this role.
  assert.strictEqual(can("operations_manager", PERMISSIONS.PRODUCTS_READ), true);
  assert.strictEqual(can("operations_manager", PERMISSIONS.PACKAGES_READ), true);
  assert.strictEqual(
    can("operations_manager", PERMISSIONS.PRODUCTS_WRITE),
    false,
    "an operations manager arranges what was sold but must not reprice it"
  );
  assert.strictEqual(can("operations_manager", PERMISSIONS.PACKAGES_WRITE), false);
  assert.strictEqual(can("operations_manager", PERMISSIONS.QUOTES_WRITE), false);
  assert.strictEqual(can("operations_manager", PERMISSIONS.PROPOSALS_WRITE), false);
  // Arranging a trip does not require the lead pipeline or a customer's full
  // purchase history.
  assert.strictEqual(can("operations_manager", PERMISSIONS.CRM_LEADS_READ), false);
  assert.strictEqual(can("operations_manager", PERMISSIONS.CRM_CUSTOMERS_READ), false);
  assert.strictEqual(can("operations_manager", PERMISSIONS.ADVISOR_REVIEWS_READ), false);
  assert.strictEqual(can("operations_manager", PERMISSIONS.PORTAL_TRIPS_READ), false);
  console.log("permissions: the booking board is reachable by the operations manager alone");

  console.log("permissions: all tests passed");
}

main();
