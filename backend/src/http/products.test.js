// STORY-015: the safari product book, tested over real HTTP.
//
// The service suites prove the DECISIONS - safariProductValidation.test.js that
// an itinerary conflict and a bad price are caught, safariProductStore.test.js
// that a change is stored, audited and immediately readable. This suite proves
// the WIRING, which is where an access-control bug actually lives: that the
// permission each route DECLARES is the one enforced, that no other role can
// author or reprice a package however it presents itself, and that the audit
// entry a change writes is really readable afterwards through the API rather
// than only in a unit test.
//
// All three acceptance criteria are marked below. "Unauthorized product
// modification" - the story's third failure path - is tested here and only
// here, because it is a property of the boundary, not of the services. The
// sharpest case is the advisor: a role that can read every package and change
// none. A test that only checked "customer gets 403" would pass even if
// products.write had been handed to everyone who can log in.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { hashPassword } = require("../services/portal/portalCredentials");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { __resetProductsForTests } = require("../services/products/safariProductStore");

const PM_TOKEN = "test-pm-token-products";
const ADVISOR_TOKEN = "test-advisor-token-products";
const CUSTOMER_TOKEN = "test-customer-token-products";
const SALES_TOKEN = "test-sales-token-products";
const ADMIN_TOKEN = "test-admin-token-products";

const PM_USER = "PM-PRODUCTS-1";
const ADVISOR_USER = "ADV-PRODUCTS-1";

const TOKENS = [
  PM_TOKEN + ":product_manager:" + PM_USER,
  ADVISOR_TOKEN + ":advisor:" + ADVISOR_USER,
  CUSTOMER_TOKEN + ":customer:CUST-PRODUCTS-1",
  SALES_TOKEN + ":sales:SALES-PRODUCTS-1",
  ADMIN_TOKEN + ":admin:ADMIN-PRODUCTS-1",
].join(",");

const SESSION_CUSTOMER = "CUST-PRODUCTS-SESSION";
const PASSWORD = "ngorongoro-crater-2026";

function samplePackage(overrides) {
  return Object.assign(
    {
      name: "Serengeti Migration Safari",
      country: "Tanzania",
      summary: "Follow the wildebeest migration across the Serengeti plains.",
      durationDays: 3,
      itinerary: [
        { day: 1, title: "Arrive Arusha", location: "Arusha" },
        { day: 2, title: "Central Serengeti", detail: "Full day game drive.", location: "Seronera" },
        { day: 3, title: "Depart Kilimanjaro", location: "Kilimanjaro" },
      ],
      pricing: {
        currency: "USD",
        perPersonCents: 520000,
        costPerPersonCents: 420000,
        singleSupplementCents: 90000,
      },
    },
    overrides || {}
  );
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  __resetProductsForTests();
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

  // The audit trail as an admin can actually read it. Criterion 3 is about an
  // entry EXISTING, and reading it back through the API is a stronger proof
  // than reading the module's own store.
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

  const bodies = [];
  async function readBody(res) {
    const text = await res.text();
    bodies.push(text);
    return text === "" ? null : JSON.parse(text);
  }

  try {
    // ================================================= ACCEPTANCE CRITERION 1
    // "Given a new safari product, when it is created, then it should include
    // itineraries and pricing."
    const createRes = await call("/api/products/safari", {
      method: "POST",
      token: PM_TOKEN,
      body: samplePackage(),
    });
    assert.strictEqual(createRes.status, 201, "a new package is authored, so 201");
    const created = await readBody(createRes);
    assert.strictEqual(created.replayed, false);

    const productId = created.product.productId;
    assert.strictEqual(created.product.version, 1);
    // Authored by the RESOLVED principal, not by anything in the body.
    assert.strictEqual(created.product.createdBy, PM_USER);

    // The itinerary came back in full, one entry per day of the duration.
    assert.strictEqual(created.product.durationDays, 3);
    assert.deepStrictEqual(
      created.product.itinerary.map((day) => day.day),
      [1, 2, 3]
    );
    assert.strictEqual(created.product.itinerary[1].title, "Central Serengeti");
    // And so did the pricing, with the margin derived: 520000 - 420000.
    assert.strictEqual(created.product.pricing.perPersonCents, 520000);
    assert.strictEqual(created.product.pricing.internal.marginPerPersonCents, 100000);

    const getRes = await call("/api/products/safari/" + productId, { token: PM_TOKEN });
    assert.strictEqual(getRes.status, 200);
    const fetched = await readBody(getRes);
    assert.deepStrictEqual(fetched.product, created.product);

    const listRes = await call("/api/products/safari", { token: PM_TOKEN });
    const listed = await readBody(listRes);
    assert.strictEqual(listed.count, 1);
    assert.strictEqual(listed.products[0].productId, productId);
    // The editable field list ships with the response, so a client needs no
    // copy of the store's allow-list to keep in step.
    assert.ok(listed.editable.includes("itinerary"));
    assert.ok(listed.editable.includes("pricing"));
    console.log("products http: a posted package carries its itinerary and pricing, and is listed");

    // ================================================= ACCEPTANCE CRITERION 3
    // "Given any safari product, when it is created or updated, then an audit
    // log entry must be created." Read back through GET /api/admin/audit.
    const afterCreate = await auditEntries();
    const createEntry = findEntry(afterCreate, "products.safari.created", productId);
    assert.ok(createEntry, "authoring a package over HTTP must write a readable audit entry");
    assert.strictEqual(createEntry.outcome, "success");
    assert.strictEqual(createEntry.actor, PM_USER);
    assert.deepStrictEqual(createEntry.context.itinerary, { days: 3 });
    assert.strictEqual(createEntry.context.pricing.perPersonCents, 520000);
    console.log("products http: the create is in the audit trail, readable through the API");

    // ================================================= ACCEPTANCE CRITERION 2
    // "Given an existing safari product, when its itinerary is updated, then
    // the changes should be reflected immediately."
    const editCorrelation = "products-http-edit-0001";
    const patchRes = await call("/api/products/safari/" + productId, {
      method: "PATCH",
      token: PM_TOKEN,
      correlationId: editCorrelation,
      body: {
        itinerary: [
          { day: 1, title: "Arrive Arusha", location: "Arusha" },
          { day: 2, title: "Ngorongoro Crater rim", location: "Ngorongoro" },
          { day: 3, title: "Depart Kilimanjaro", location: "Kilimanjaro" },
        ],
      },
    });
    assert.strictEqual(patchRes.status, 200);
    const patched = await readBody(patchRes);
    assert.deepStrictEqual(patched.changed, ["itinerary"]);
    assert.strictEqual(patched.unchanged, false);
    assert.strictEqual(patched.product.version, 2);
    assert.strictEqual(patched.product.updatedBy, PM_USER);

    // IMMEDIATELY: the very next request, through both the single read and the
    // list. A stale copy in either one is the defect this criterion is about.
    const afterEdit = await readBody(
      await call("/api/products/safari/" + productId, { token: PM_TOKEN })
    );
    assert.strictEqual(afterEdit.product.itinerary[1].title, "Ngorongoro Crater rim");
    assert.strictEqual(afterEdit.product.version, 2);
    const afterEditList = await readBody(await call("/api/products/safari", { token: PM_TOKEN }));
    assert.strictEqual(afterEditList.products[0].itinerary[1].title, "Ngorongoro Crater rim");
    // The days that were not edited are untouched.
    assert.strictEqual(afterEdit.product.itinerary[0].title, "Arrive Arusha");
    console.log("products http: an itinerary edit is visible on the very next request");

    const updateEntry = findEntry(await auditEntries(), "products.safari.updated", productId);
    assert.ok(updateEntry, "the edit must write a readable audit entry");
    assert.deepStrictEqual(updateEntry.context.fields, ["itinerary"]);
    assert.deepStrictEqual(updateEntry.context.daysChanged, [2]);
    assert.strictEqual(updateEntry.actor, PM_USER);
    assert.strictEqual(updateEntry.correlationId, editCorrelation);
    console.log("products http: the edit is in the audit trail, naming the day that moved");

    // ========================================== FAILURE PATH: UNAUTHORIZED
    // MODIFICATION. The sharpest case first: an advisor READS the whole book
    // and cannot change a thing. If products.write ever drifted onto advisor,
    // this is the assertion that fails.
    assert.strictEqual((await call("/api/products/safari", { token: ADVISOR_TOKEN })).status, 200);
    assert.strictEqual(
      (await call("/api/products/safari/" + productId, { token: ADVISOR_TOKEN })).status,
      200
    );

    const advisorPatch = await call("/api/products/safari/" + productId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      correlationId: "products-http-advisor-patch",
      body: { pricing: { currency: "USD", perPersonCents: 100000, costPerPersonCents: 420000 } },
    });
    assert.strictEqual(advisorPatch.status, 403, "an advisor must not be able to reprice a package");
    await readBody(advisorPatch);
    assert.strictEqual(
      (
        await call("/api/products/safari", {
          method: "POST",
          token: ADVISOR_TOKEN,
          body: samplePackage({ name: "Advisor's own package", country: "Kenya" }),
        })
      ).status,
      403,
      "an advisor must not be able to author a package"
    );
    console.log("products http: an advisor reads the whole book and can change none of it");

    // No other role reaches these routes at all - not the customer whose trip
    // it is, not sales, and not an admin. Written out per role rather than as a
    // loop, because "no other role" is the claim.
    for (const token of [CUSTOMER_TOKEN, SALES_TOKEN, ADMIN_TOKEN]) {
      assert.strictEqual((await call("/api/products/safari", { token: token })).status, 403);
      assert.strictEqual(
        (await call("/api/products/safari/" + productId, { token: token })).status,
        403
      );
      assert.strictEqual(
        (
          await call("/api/products/safari", {
            method: "POST",
            token: token,
            body: samplePackage({ name: "Someone else's package", country: "Kenya" }),
          })
        ).status,
        403
      );
      assert.strictEqual(
        (
          await call("/api/products/safari/" + productId, {
            method: "PATCH",
            token: token,
            body: { name: "Renamed by the wrong role" },
          })
        ).status,
        403
      );
    }

    // And no credential at all is 401, not 403: "we do not know who you are" is
    // a different answer from "we know, and no".
    assert.strictEqual((await call("/api/products/safari")).status, 401);
    assert.strictEqual(
      (
        await call("/api/products/safari", { method: "POST", token: "not-a-real-token", body: {} })
      ).status,
      401
    );

    // EVERY ONE OF THOSE REFUSALS LEFT THE PACKAGE EXACTLY AS IT WAS. A 403
    // that half-applies the change is the bug this asserts against.
    const untouched = await readBody(
      await call("/api/products/safari/" + productId, { token: PM_TOKEN })
    );
    assert.deepStrictEqual(untouched.product, afterEdit.product);
    assert.strictEqual(untouched.product.version, 2);
    console.log("products http: no other role reaches the book, and no refusal changed anything");

    // ========================================= FAILURE PATH: BAD PRICING DATA
    // Over HTTP the refusal must be a 400 with the problem list, not a 500 and
    // not a silently stored package.
    const belowCost = await call("/api/products/safari", {
      method: "POST",
      token: PM_TOKEN,
      body: samplePackage({
        name: "Underpriced Safari",
        pricing: { currency: "USD", perPersonCents: 5200, costPerPersonCents: 420000 },
      }),
    });
    assert.strictEqual(belowCost.status, 400);
    const belowCostBody = await readBody(belowCost);
    assert.strictEqual(belowCostBody.error, "invalid_product");
    assert.ok(
      belowCostBody.problems.some((p) => p.includes("must not be below costPerPersonCents")),
      "the problem list must say what is wrong: " + JSON.stringify(belowCostBody.problems)
    );

    const fractional = await call("/api/products/safari", {
      method: "POST",
      token: PM_TOKEN,
      body: samplePackage({
        name: "Fractional Safari",
        pricing: { currency: "USD", perPersonCents: 520000.5, costPerPersonCents: 420000 },
      }),
    });
    assert.strictEqual(fractional.status, 400);
    await readBody(fractional);
    // Neither was stored.
    assert.strictEqual(
      (await readBody(await call("/api/products/safari", { token: PM_TOKEN }))).count,
      1
    );
    console.log("products http: a package priced below cost or in fractional cents is a 400");

    // ====================================== FAILURE PATH: ITINERARY CONFLICTS
    // Shortening the duration alone orphans day 3, which the stored itinerary
    // still describes. A legal-looking patch, refused on the merged record.
    const conflict = await call("/api/products/safari/" + productId, {
      method: "PATCH",
      token: PM_TOKEN,
      correlationId: "products-http-conflict-0001",
      body: { durationDays: 2 },
    });
    assert.strictEqual(conflict.status, 400);
    const conflictBody = await readBody(conflict);
    assert.strictEqual(conflictBody.error, "invalid_product");
    assert.ok(
      conflictBody.problems.some(
        (p) => p === "itinerary describes day 3 but the product runs 2 days"
      ),
      "the conflict must be named: " + JSON.stringify(conflictBody.problems)
    );
    // Refused means unchanged, and the refusal is itself in the trail.
    const stillThere = await readBody(
      await call("/api/products/safari/" + productId, { token: PM_TOKEN })
    );
    assert.deepStrictEqual(stillThere.product, afterEdit.product);
    const refusalEntry = findEntry(await auditEntries(), "products.safari.refused", productId);
    assert.ok(refusalEntry, "a refused edit must still leave a trace");
    assert.strictEqual(refusalEntry.outcome, "failure");
    console.log("products http: an itinerary conflict is a 400, changes nothing, and is audited");

    // ================================================== IDEMPOTENCY AND SHAPE
    // The same package posted twice is one product, and the status code says
    // which happened.
    const replay = await call("/api/products/safari", {
      method: "POST",
      token: PM_TOKEN,
      body: samplePackage(),
    });
    assert.strictEqual(replay.status, 200, "a replay is 200, not 201");
    const replayBody = await readBody(replay);
    assert.strictEqual(replayBody.replayed, true);
    assert.strictEqual(replayBody.product.productId, productId);
    assert.strictEqual(
      (await readBody(await call("/api/products/safari", { token: PM_TOKEN }))).count,
      1
    );

    // A second, genuinely different package, then an edit that would collide
    // with the first: 409, because the submission was well-formed and simply
    // lost to a package that already exists.
    const second = await readBody(
      await call("/api/products/safari", {
        method: "POST",
        token: PM_TOKEN,
        body: samplePackage({ name: "Okavango Delta Safari", country: "Botswana" }),
      })
    );
    const collide = await call("/api/products/safari/" + second.product.productId, {
      method: "PATCH",
      token: PM_TOKEN,
      correlationId: "products-http-collide-0001",
      body: { name: "Serengeti Migration Safari", country: "Tanzania" },
    });
    assert.strictEqual(collide.status, 409);
    await readBody(collide);
    console.log("products http: a replayed post is 200, and a colliding rename is 409");

    // Envelope faults. A body that is not a JSON object, a patch naming a field
    // that is not editable, an empty patch, an unknown product, and a path
    // parameter that cannot be decoded - each with its own status.
    for (const badBody of [[], "a string", 42]) {
      const res = await call("/api/products/safari", {
        method: "POST",
        token: PM_TOKEN,
        body: badBody,
      });
      assert.strictEqual(res.status, 400, "a non-object body must be a 400");
      assert.strictEqual((await readBody(res)).error, "invalid_request_body");
    }

    const notEditable = await call("/api/products/safari/" + productId, {
      method: "PATCH",
      token: PM_TOKEN,
      correlationId: "products-http-noteditable-1",
      body: { productId: "safari_someone_elses", version: 99 },
    });
    assert.strictEqual(notEditable.status, 400);
    assert.strictEqual((await readBody(notEditable)).error, "unknown_fields");

    const emptyPatch = await call("/api/products/safari/" + productId, {
      method: "PATCH",
      token: PM_TOKEN,
      correlationId: "products-http-empty-0001",
      body: {},
    });
    assert.strictEqual(emptyPatch.status, 400);
    assert.strictEqual((await readBody(emptyPatch)).error, "empty_update");

    const unknownGet = await call("/api/products/safari/safari_nope", { token: PM_TOKEN });
    assert.strictEqual(unknownGet.status, 404);
    assert.strictEqual((await readBody(unknownGet)).error, "unknown_product");

    const unknownPatch = await call("/api/products/safari/safari_nope", {
      method: "PATCH",
      token: PM_TOKEN,
      correlationId: "products-http-unknown-0001",
      body: { name: "Anything" },
    });
    assert.strictEqual(unknownPatch.status, 404);
    await readBody(unknownPatch);

    // "%" is not a valid percent-encoding sequence. Unguarded this is a 500 on
    // a URL a scanner finds within the hour.
    const malformed = await call("/api/products/safari/%", { token: PM_TOKEN });
    assert.strictEqual(malformed.status, 400);
    assert.strictEqual((await readBody(malformed)).error, "invalid_product_id");
    console.log("products http: malformed bodies, patches, ids and unknown products all 4xx");

    // ============================================ NO CREDENTIAL IN A RESPONSE
    for (const secret of [PM_TOKEN, ADVISOR_TOKEN, CUSTOMER_TOKEN, SALES_TOKEN, ADMIN_TOKEN, PASSWORD]) {
      assert.ok(
        !bodies.join("").includes(secret),
        "a credential leaked into a product response"
      );
    }
    console.log("products http: no credential appears in any product response");

    // ============================================= the role model integrates
    // A role change takes effect on the product book without a restart: the
    // advisor token that was 403 above can author once an admin grants it
    // product_manager, and is 403 again when it is taken away. This is why the
    // routes name a permission rather than a role.
    //
    // Done LAST, because it changes a principal the assertions above rely on.
    const grant = await call("/api/admin/roles", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { userId: ADVISOR_USER, role: "product_manager", reason: "STORY-015 wiring test" },
    });
    assert.ok(grant.status === 200 || grant.status === 201, "the grant must be accepted");
    await readBody(grant);
    const nowAllowed = await call("/api/products/safari/" + productId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      correlationId: "products-http-granted-0001",
      body: { summary: "Migration timed for the Grumeti crossing." },
    });
    assert.strictEqual(nowAllowed.status, 200);
    const grantedEdit = await readBody(nowAllowed);
    assert.deepStrictEqual(grantedEdit.changed, ["summary"]);
    // The edit is attributed to the advisor's own user id, not to the product
    // manager who authored the package.
    assert.strictEqual(grantedEdit.product.updatedBy, ADVISOR_USER);
    assert.strictEqual(grantedEdit.product.createdBy, PM_USER);

    const revoke = await call("/api/admin/roles", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { userId: ADVISOR_USER, role: "advisor", reason: "STORY-015 wiring test, undo" },
    });
    assert.ok(revoke.status === 200 || revoke.status === 201);
    await readBody(revoke);
    assert.strictEqual(
      (
        await call("/api/products/safari/" + productId, {
          method: "PATCH",
          token: ADVISOR_TOKEN,
          correlationId: "products-http-revoked-0001",
          body: { summary: "Changed after the grant was taken away." },
        })
      ).status,
      403
    );
    console.log("products http: granting and revoking product_manager takes effect with no restart");

    console.log("products http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetProductsForTests();
    __resetAssignmentsForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
