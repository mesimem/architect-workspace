// STORY-017: the package book, tested over real HTTP.
//
// The service suites prove the DECISIONS - packageCompatibility.test.js that
// four kinds of incompatible product are caught, packagePricing.test.js that
// the money is right, packageStore.test.js that a package is stored, audited
// and rolled back when it cannot be. This suite proves the WIRING, which is
// where an access-control bug actually lives: that the permission each route
// DECLARES is the one enforced, that no other role can build or reprice an
// offering however it presents itself, and that the audit entry a change
// writes is really readable afterwards through the API rather than only in a
// unit test.
//
// All three acceptance criteria are marked below. "Unauthorized access to
// package creation" - the story's third failure path - is tested here and only
// here, because it is a property of the boundary, not of the services. The
// sharpest cases are the two that an over-broad grant would silently allow: a
// SALES manager, who holds customer data and might plausibly have been given
// the catalogue, and an ADMIN, who holds the audit trail and would be reading
// the margin on every offering at once. A test that only checked "customer
// gets 403" would pass even if packages.write had been handed to everyone who
// can log in.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { hashPassword } = require("../services/portal/portalCredentials");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { __resetProductsForTests } = require("../services/products/safariProductStore");
const { __resetPackagesForTests } = require("../services/packages/packageStore");

const PM_TOKEN = "test-pm-token-packages";
const ADVISOR_TOKEN = "test-advisor-token-packages";
const CUSTOMER_TOKEN = "test-customer-token-packages";
const SALES_TOKEN = "test-sales-token-packages";
const ADMIN_TOKEN = "test-admin-token-packages";

const PM_USER = "PM-PACKAGES-1";
const ADVISOR_USER = "ADV-PACKAGES-1";

const TOKENS = [
  PM_TOKEN + ":product_manager:" + PM_USER,
  ADVISOR_TOKEN + ":advisor:" + ADVISOR_USER,
  CUSTOMER_TOKEN + ":customer:CUST-PACKAGES-1",
  SALES_TOKEN + ":sales:SALES-PACKAGES-1",
  ADMIN_TOKEN + ":admin:ADMIN-PACKAGES-1",
].join(",");

const SESSION_CUSTOMER = "CUST-PACKAGES-SESSION";
const PASSWORD = "ngorongoro-crater-2026";

// The products a package is built from. Authored through the real product API
// by a real product_manager, not injected into a store - so this suite also
// proves the two books actually talk to each other.
//
// mara:      Kenya,    6 days, sells $4,450, costs $3,300
// amboseli:  Kenya,    5 days, sells $2,950, costs $2,200
// serengeti: Tanzania, 5 days, sells $5,200, costs $4,200
const PRODUCTS = [
  {
    name: "Masai Mara Classic",
    country: "Kenya",
    summary: "Six days in the Mara, timed for the river crossings.",
    durationDays: 6,
    itinerary: [
      { day: 1, title: "Arrive Nairobi", location: "Nairobi" },
      { day: 2, title: "Fly to the Mara", location: "Masai Mara" },
      { day: 3, title: "Game drives", location: "Masai Mara" },
      { day: 4, title: "Mara River", location: "Masai Mara" },
      { day: 5, title: "Conservancy walk", location: "Masai Mara" },
      { day: 6, title: "Return Nairobi", location: "Nairobi" },
    ],
    pricing: {
      currency: "USD",
      perPersonCents: 445000,
      costPerPersonCents: 330000,
      singleSupplementCents: 78000,
    },
  },
  {
    name: "Amboseli Under Kilimanjaro",
    country: "Kenya",
    summary: "Five days of elephants against the mountain.",
    durationDays: 5,
    itinerary: [
      { day: 1, title: "Drive to Amboseli", location: "Amboseli" },
      { day: 2, title: "Game drives", location: "Amboseli" },
      { day: 3, title: "Observation hill", location: "Amboseli" },
      { day: 4, title: "Maasai village", location: "Amboseli" },
      { day: 5, title: "Return Nairobi", location: "Nairobi" },
    ],
    pricing: {
      currency: "USD",
      perPersonCents: 295000,
      costPerPersonCents: 220000,
      singleSupplementCents: 46000,
    },
  },
  {
    name: "Serengeti Migration",
    country: "Tanzania",
    summary: "Five days following the herds across the Serengeti.",
    durationDays: 5,
    itinerary: [
      { day: 1, title: "Arrive Kilimanjaro", location: "Kilimanjaro" },
      { day: 2, title: "Fly to Seronera", location: "Seronera" },
      { day: 3, title: "Central Serengeti", location: "Seronera" },
      { day: 4, title: "Northern Serengeti", location: "Kogatende" },
      { day: 5, title: "Depart Kilimanjaro", location: "Kilimanjaro" },
    ],
    pricing: {
      currency: "USD",
      perPersonCents: 520000,
      costPerPersonCents: 420000,
      singleSupplementCents: 90000,
    },
  },
];

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  __resetProductsForTests();
  __resetPackagesForTests();
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
    if (options.correlationId) {
      headers["X-Correlation-ID"] = options.correlationId;
    }
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  // The audit trail as an admin can actually read it. The trust criterion is
  // about entries EXISTING, and reading them back through the API is a stronger
  // proof than reading the module's own store.
  async function auditEntries() {
    const res = await call("/api/admin/audit", { token: ADMIN_TOKEN });
    assert.strictEqual(res.status, 200);
    return (await res.json()).entries;
  }

  function findEntry(entries, event, resource) {
    return (
      entries.find(function (entry) {
        return entry.event === event && entry.resource === resource;
      }) || null
    );
  }

  function mentions(problems, fragment) {
    return (problems || []).some(function (problem) {
      return problem.includes(fragment);
    });
  }

  try {
    // ------------------------------------------------------------- the shelf
    const productIds = {};
    for (const product of PRODUCTS) {
      const res = await call("/api/products/safari", {
        method: "POST",
        token: PM_TOKEN,
        body: product,
      });
      assert.strictEqual(res.status, 201, "the product shelf must stock before packages are built");
      const created = await res.json();
      productIds[product.country + ":" + product.name] = created.product.productId;
    }
    const MARA = productIds["Kenya:Masai Mara Classic"];
    const AMBOSELI = productIds["Kenya:Amboseli Under Kilimanjaro"];
    const SERENGETI = productIds["Tanzania:Serengeti Migration"];
    console.log("packages http: the product shelf is stocked through the real product API");

    // ================================================= ACCEPTANCE CRITERION 1
    // "Given an advisor selects multiple travel products, when they create a
    // package, then the system combines them into a single offering."
    const createRes = await call("/api/packages", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: {
        name: "Kenya Grand Circuit",
        summary: "The Mara and Amboseli, combined into one journey.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: AMBOSELI, startDay: 8 },
        ],
      },
    });
    assert.strictEqual(createRes.status, 201, "a new offering is built, so 201");
    const created = await createRes.json();
    assert.strictEqual(created.replayed, false);

    const packageId = created.package.packageId;
    // ONE offering, out of two products.
    assert.strictEqual(created.package.components.length, 2);
    assert.strictEqual(created.package.version, 1);
    // Built by the RESOLVED principal, not by anything in the body.
    assert.strictEqual(created.package.createdBy, ADVISOR_USER);
    // The price is the sum of the parts: 445000 + 295000, written out by hand.
    assert.strictEqual(created.package.pricing.perPersonCents, 740000);
    assert.strictEqual(created.package.pricing.internal.costPerPersonCents, 550000);
    assert.strictEqual(created.package.pricing.internal.marginPerPersonCents, 190000);

    const getRes = await call("/api/packages/" + packageId, { token: ADVISOR_TOKEN });
    assert.strictEqual(getRes.status, 200);
    assert.deepStrictEqual((await getRes.json()).package, created.package);

    const listRes = await call("/api/packages", { token: ADVISOR_TOKEN });
    const listed = await listRes.json();
    assert.strictEqual(listed.count, 1);
    assert.strictEqual(listed.packages[0].packageId, packageId);
    // The editable list ships with the response, and `pricing` is NOT in it -
    // a derived figure is not something a client may offer to set.
    assert.ok(listed.editable.includes("components"));
    assert.ok(!listed.editable.includes("pricing"));
    console.log("packages http: an advisor combines two products into one priced offering");

    // IDEMPOTENT over HTTP: the same submission again is 200 (found) rather
    // than 201 (created), and the book still holds one offering.
    const replayRes = await call("/api/packages", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: {
        name: "Kenya Grand Circuit",
        summary: "The Mara and Amboseli, combined into one journey.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: AMBOSELI, startDay: 8 },
        ],
      },
    });
    assert.strictEqual(replayRes.status, 200, "a replay is 200, not a second 201");
    assert.strictEqual((await replayRes.json()).replayed, true);
    assert.strictEqual((await (await call("/api/packages", { token: ADVISOR_TOKEN })).json()).count, 1);
    console.log("packages http: re-posting the same offering is a 200 replay, not a duplicate");

    // ================================================= ACCEPTANCE CRITERION 3
    // "The system logs all package creation and modification details in the
    // audit trail." Read back through GET /api/admin/audit.
    const afterCreate = await auditEntries();
    const createEntry = findEntry(afterCreate, "packages.created", packageId);
    assert.ok(createEntry, "building a package over HTTP must write a readable audit entry");
    assert.strictEqual(createEntry.outcome, "success");
    assert.strictEqual(createEntry.actor, ADVISOR_USER);
    assert.deepStrictEqual(createEntry.context.components.productIds, [MARA, AMBOSELI]);
    // The MARGIN is in the trail, not just the sell price. A trail that
    // recorded what we charged but not what we made could not answer "was this
    // sold at a loss?".
    assert.strictEqual(createEntry.context.pricing.marginPerPersonCents, 190000);
    console.log("packages http: the creation is in the audit trail, readable through the API");

    // ================================================= ACCEPTANCE CRITERION 2
    // "Given an advisor tries to combine incompatible products, when they
    // attempt to save, then the system displays an error message."
    //
    // Two safaris that overlap on days 5 and 6. Both products are individually
    // sellable; the combination is not takeable.
    const overlapRes = await call("/api/packages", {
      method: "POST",
      token: ADVISOR_TOKEN,
      correlationId: "packages-http-overlap-01",
      body: {
        name: "Impossible Kenya Double",
        summary: "Two safaris a customer cannot both be on.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: AMBOSELI, startDay: 5 },
        ],
      },
    });
    assert.strictEqual(overlapRes.status, 400);
    const overlapBody = await overlapRes.json();
    assert.strictEqual(overlapBody.error, "invalid_package");
    // A MESSAGE, naming which components and which days - not a bare code.
    assert.ok(mentions(overlapBody.problems, "overlap"));
    assert.ok(mentions(overlapBody.problems, "days 1-6"));
    console.log("packages http: overlapping products are refused with a message that names the days");

    // The other three incompatibilities, over the wire. Cross-country with no
    // travel day is the one an advisor is most likely to build by accident.
    const borderRes = await call("/api/packages", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: {
        name: "Kenya Tanzania No Gap",
        summary: "Mara to Serengeti with no travel day.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: SERENGETI, startDay: 7 },
        ],
      },
    });
    assert.strictEqual(borderRes.status, 400);
    assert.ok(mentions((await borderRes.json()).problems, "cross-country components need a travel day"));

    const duplicateRes = await call("/api/packages", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: {
        name: "The Mara Twice",
        summary: "The same safari, sold to the same customer, twice.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: MARA, startDay: 20 },
        ],
      },
    });
    assert.strictEqual(duplicateRes.status, 400);
    assert.ok(mentions((await duplicateRes.json()).problems, "the same product is listed more than once"));
    console.log("packages http: cross-country and duplicate components are refused too");

    // A BELOW-COST DISCOUNT is a different error code from an incompatibility,
    // because it sends the advisor to a different part of the same form.
    const belowCostRes = await call("/api/packages", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: {
        name: "Loss Making Circuit",
        summary: "Discounted below what the lodges charge us.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: AMBOSELI, startDay: 8 },
        ],
        discountBasisPoints: 3000,
      },
    });
    assert.strictEqual(belowCostRes.status, 400);
    const belowCostBody = await belowCostRes.json();
    assert.strictEqual(belowCostBody.error, "invalid_pricing");
    assert.ok(mentions(belowCostBody.problems, "below the combined cost"));
    console.log("packages http: a below-cost discount is refused under its own error code");

    // NOTHING WAS STORED by any of those four refusals.
    assert.strictEqual((await (await call("/api/packages", { token: ADVISOR_TOKEN })).json()).count, 1);
    // And the refusal is IN THE TRAIL. A refused package that leaves no trace
    // is indistinguishable from a request that was never made - which is the
    // whole reason the route does not pre-reject these at the boundary.
    const refusal = findEntry(await auditEntries(), "packages.refused", "packages");
    assert.ok(refusal, "a refused package must still be recorded");
    assert.strictEqual(refusal.outcome, "failure");
    console.log("packages http: a refused package stores nothing and is still audited");

    // ------------------------------------------- modification, and its trail
    const patchRes = await call("/api/packages/" + packageId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      correlationId: "packages-http-edit-0001",
      body: { discountBasisPoints: 1000 },
    });
    assert.strictEqual(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.deepStrictEqual(patched.changed, ["discountBasisPoints"]);
    assert.strictEqual(patched.unchanged, false);
    assert.strictEqual(patched.package.version, 2);
    // Re-derived, not re-submitted: 740000 less 10% is 666000.
    assert.strictEqual(patched.package.pricing.perPersonCents, 666000);

    // Reflected immediately on the next read.
    const afterPatch = await (await call("/api/packages/" + packageId, { token: ADVISOR_TOKEN })).json();
    assert.strictEqual(afterPatch.package.pricing.perPersonCents, 666000);

    // MODIFICATION is in the trail as its own entry - the creation is still
    // there too, rather than having been overwritten.
    const entriesAfterPatch = await auditEntries();
    const updateEntry = findEntry(entriesAfterPatch, "packages.updated", packageId);
    assert.ok(updateEntry, "modifying a package must write its own audit entry");
    assert.deepStrictEqual(updateEntry.context.fields, ["discountBasisPoints"]);
    assert.strictEqual(updateEntry.context.pricing.perPersonCents, 666000);
    assert.ok(findEntry(entriesAfterPatch, "packages.created", packageId), "the creation entry survives");
    console.log("packages http: a modification is reflected immediately and audited separately");

    // A patch that names a DERIVED field is refused by name, not ignored.
    const derivedRes = await call("/api/packages/" + packageId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: { pricing: { perPersonCents: 1 } },
    });
    assert.strictEqual(derivedRes.status, 400);
    assert.strictEqual((await derivedRes.json()).error, "unknown_fields");
    console.log("packages http: a patch trying to set the derived price is refused");

    // ======================================= THE THIRD FAILURE PATH: ACCESS
    // "Unauthorized access to package creation feature."
    //
    // Written per role rather than as a loop over roles, deliberately: a loop
    // would keep passing the day a sixth role arrives holding the grant.
    const build = {
      method: "POST",
      body: {
        name: "Unauthorized Circuit",
        summary: "This must never be stored.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: AMBOSELI, startDay: 8 },
        ],
      },
    };

    // A CUSTOMER. The obvious case, and the least interesting one.
    assert.strictEqual((await call("/api/packages", { ...build, token: CUSTOMER_TOKEN })).status, 403);
    assert.strictEqual((await call("/api/packages", { token: CUSTOMER_TOKEN })).status, 403);

    // A SALES MANAGER. Holds customer data and the CRM, and might plausibly
    // have been handed the catalogue "because they sell". A package carries
    // pricing.internal, so this read would be our margin on every offering.
    assert.strictEqual((await call("/api/packages", { ...build, token: SALES_TOKEN })).status, 403);
    assert.strictEqual((await call("/api/packages", { token: SALES_TOKEN })).status, 403);

    // AN ADMIN. Holds the audit trail. A role that could both build an
    // offering and read the record of having built it is the conflict of
    // interest the permission table keeps breaking up - see its header.
    assert.strictEqual((await call("/api/packages", { ...build, token: ADMIN_TOKEN })).status, 403);
    assert.strictEqual((await call("/api/packages", { token: ADMIN_TOKEN })).status, 403);

    // NO CREDENTIAL AT ALL is 401, not 403 - the caller is unidentified rather
    // than identified and refused.
    assert.strictEqual((await call("/api/packages", { method: "POST", body: build.body })).status, 401);

    // And nothing any of them sent was stored.
    assert.strictEqual((await (await call("/api/packages", { token: ADVISOR_TOKEN })).json()).count, 1);
    console.log("packages http: customer, sales, admin and anonymous callers are all refused");

    // THE PAIR THAT PROVES THE GRANT IS DELIBERATE. A product manager may
    // build a package AND reprice a product; an advisor may build a package
    // and may NOT reprice the product inside it. Those two facts together are
    // the argument for packages.write existing separately from products.write,
    // so they are asserted together.
    const pmBuild = await call("/api/packages", {
      method: "POST",
      token: PM_TOKEN,
      body: {
        name: "Product Manager Circuit",
        summary: "Built by the role that authored the components.",
        components: [
          { kind: "safari", productId: MARA, startDay: 1 },
          { kind: "safari", productId: SERENGETI, startDay: 8 },
        ],
      },
    });
    assert.strictEqual(pmBuild.status, 201, "a product manager may combine the products they author");

    const advisorReprice = await call("/api/products/safari/" + MARA, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: { summary: "An advisor must not be able to edit the product book." },
    });
    assert.strictEqual(
      advisorReprice.status,
      403,
      "an advisor composes packages but must not edit the products inside them"
    );
    console.log("packages http: a product manager builds packages, an advisor cannot edit products");

    // ---------------------------------------------------- boundary handling
    // A malformed percent-encoded id is a 400, not the 500 an unguarded
    // decodeURIComponent would produce on a URL a scanner finds within the hour.
    assert.strictEqual((await call("/api/packages/%", { token: ADVISOR_TOKEN })).status, 400);
    assert.strictEqual((await call("/api/packages/package_nope", { token: ADVISOR_TOKEN })).status, 404);

    const badBody = await call("/api/packages", { method: "POST", token: ADVISOR_TOKEN, body: [] });
    assert.strictEqual(badBody.status, 400);
    assert.strictEqual((await badBody.json()).error, "invalid_request_body");
    console.log("packages http: malformed ids and non-object bodies are refused at the boundary");

    console.log("packages http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetPackagesForTests();
    __resetProductsForTests();
    __resetAssignmentsForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
