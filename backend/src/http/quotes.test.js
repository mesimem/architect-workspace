// STORY-007: quotes, tested over real HTTP.
//
// The service suites prove the DECISIONS - quotePricing.test.js that the
// arithmetic is right, quoteView.test.js that no cost reaches a customer
// document, quoteStore.test.js that a revision is audited and rolls back if
// it cannot be. This suite proves the WIRING, which is where the leak would
// actually happen: that the customer ENDPOINT serves the customer projection,
// that the permission each route declares is the one enforced, and that the
// audit entries are really readable afterwards through the API rather than
// only in a unit test.
//
// All three acceptance criteria are marked below, as is each of the story's
// three named failure paths.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { __resetQuotesForTests } = require("../services/quotes/quoteStore");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");

const ADVISOR_TOKEN = "test-advisor-token-quotes";
const CUSTOMER_TOKEN = "test-customer-token-quotes";
const OTHER_CUSTOMER_TOKEN = "test-other-customer-token-quotes";
const ADMIN_TOKEN = "test-admin-token-quotes";
const SALES_TOKEN = "test-sales-token-quotes";

const ADVISOR_USER = "ADV-QUOTE-1";
const CUSTOMER_USER = "CUST-QUOTE-1";
const OTHER_CUSTOMER_USER = "CUST-QUOTE-2";

const TOKENS = [
  ADVISOR_TOKEN + ":advisor:" + ADVISOR_USER,
  CUSTOMER_TOKEN + ":customer:" + CUSTOMER_USER,
  OTHER_CUSTOMER_TOKEN + ":customer:" + OTHER_CUSTOMER_USER,
  ADMIN_TOKEN + ":admin:ADMIN-QUOTE-1",
  SALES_TOKEN + ":sales:SALES-QUOTE-1",
].join(",");

// Safari at cost $4,200 sold at $5,000 for two, plus a transfer at cost $140
// sold at $200. Subtotal $10,200, cost $8,540, margin $1,660.
function sampleBody(overrides = {}) {
  return {
    customerId: CUSTOMER_USER,
    tripReference: "TRIP-9",
    title: "Tanzania, two travellers",
    lines: [
      { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
      { label: "Airport transfer", unitCostCents: 14000, unitSellCents: 20000, quantity: 1 },
    ],
    currency: "USD",
    customerNote: "Prices hold for 14 days.",
    internalNotes: "Supplier may discount if confirmed by Friday.",
    ...overrides,
  };
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetQuotesForTests();
  __resetAssignmentsForTests();

  const server = createServer({ principals: loadPrincipals(TOKENS) });
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
  // about an entry EXISTING, and reading it back through the API is a stronger
  // proof than reading the module's own store.
  async function auditEntries() {
    const res = await call("/api/admin/audit", { token: ADMIN_TOKEN });
    assert.strictEqual(res.status, 200);
    return (await res.json()).entries;
  }

  function entriesFor(entries, event, resource) {
    return entries.filter(function (entry) {
      return entry.event === event && entry.resource === resource;
    });
  }

  try {
    // ========================================================== GENERATE
    const created = await call("/api/quotes", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: sampleBody(),
    });
    assert.strictEqual(created.status, 201);
    const createdBody = await created.json();
    const quoteId = createdBody.quote.quoteId;
    assert.strictEqual(createdBody.status, "generated");
    assert.strictEqual(created.headers.get("Location"), "/api/quotes/" + quoteId);
    // The advisor's own response is the INTERNAL view - costs included.
    assert.strictEqual(createdBody.quote.totalCents, 1020000);
    assert.strictEqual(createdBody.quote.costTotalCents, 854000);
    assert.strictEqual(createdBody.quote.marginCents, 166000);
    console.log("quotes http: an advisor generates a quote and gets back the costed version");

    // ============================================== ACCEPTANCE CRITERION 1
    // "Given a quote is generated, when a customer views it, then it displays
    // without internal costs."
    //
    // This is the test that matters most in this file: not that the projection
    // function hides costs (quoteView.test.js proves that), but that the
    // ENDPOINT a customer actually calls serves that projection.
    const customerRes = await call("/api/portal/quotes/" + quoteId, { token: CUSTOMER_TOKEN });
    assert.strictEqual(customerRes.status, 200);
    const customerPayload = await customerRes.text();

    assert.ok(!customerPayload.includes("854000"), "the cost total reached the customer");
    assert.ok(!customerPayload.includes("166000"), "the margin reached the customer");
    assert.ok(!customerPayload.includes("420000"), "a unit cost reached the customer");
    assert.ok(!customerPayload.includes("Supplier may discount"), "an internal note reached the customer");
    assert.ok(!/cost|margin|internal|supplier/i.test(customerPayload), "an internal-looking key reached the customer");

    const customerQuote = JSON.parse(customerPayload).quote;
    assert.strictEqual(customerQuote.quoteId, quoteId);
    assert.strictEqual(customerQuote.totalCents, 1020000);
    assert.strictEqual(customerQuote.lines.length, 2);
    assert.strictEqual(customerQuote.customerNote, "Prices hold for 14 days.");
    console.log("quotes http: the customer endpoint serves a complete quote with no costs in it");

    // It appears in their list too, in the same form.
    const listRes = await call("/api/portal/quotes", { token: CUSTOMER_TOKEN });
    assert.strictEqual(listRes.status, 200);
    const listPayload = await listRes.text();
    assert.strictEqual(JSON.parse(listPayload).count, 1);
    assert.ok(!/cost|margin|internal|supplier/i.test(listPayload));
    console.log("quotes http: the customer's quote list is clean too, not just the detail view");

    // ============================================== ACCEPTANCE CRITERION 2
    // "Given a quote is modified, when it is saved, then the system updates
    // the customer view."
    const modified = await call("/api/quotes/" + quoteId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: {
        lines: [sampleBody().lines[0]],
        discountBasisPoints: 1000,
        customerNote: "Transfer removed at your request.",
      },
    });
    assert.strictEqual(modified.status, 200);
    const modifiedBody = await modified.json();
    assert.strictEqual(modifiedBody.status, "modified");
    assert.strictEqual(modifiedBody.quote.version, 2);

    // Fetched fresh by the customer, AFTER the save - that is the criterion.
    const afterRes = await call("/api/portal/quotes/" + quoteId, { token: CUSTOMER_TOKEN });
    const afterPayload = await afterRes.text();
    const after = JSON.parse(afterPayload).quote;
    assert.strictEqual(after.version, 2);
    assert.strictEqual(after.lines.length, 1);
    assert.strictEqual(after.subtotalCents, 1000000);
    assert.strictEqual(after.discountCents, 100000);
    assert.strictEqual(after.totalCents, 900000);
    assert.strictEqual(after.customerNote, "Transfer removed at your request.");
    // And criterion 1 still holds after a revision, not only on a fresh quote.
    assert.ok(!/cost|margin|internal|supplier/i.test(afterPayload));
    console.log("quotes http: a saved revision is what the customer's next fetch returns");

    // ============================================== ACCEPTANCE CRITERION 3
    // "Trust: The system logs all quote generations and modifications."
    const entries = await auditEntries();
    const generations = entriesFor(entries, "quote.generated", quoteId);
    const modifications = entriesFor(entries, "quote.modified", quoteId);
    assert.strictEqual(generations.length, 1);
    assert.strictEqual(modifications.length, 1);
    assert.strictEqual(generations[0].actor, ADVISOR_USER);
    assert.strictEqual(modifications[0].actor, ADVISOR_USER);
    assert.strictEqual(modifications[0].context.totalCentsBefore, 1020000);
    assert.strictEqual(modifications[0].context.totalCentsAfter, 900000);
    // Both entries carry the correlation id of the request that caused them,
    // so a figure on a customer's quote can be traced back to one HTTP call.
    assert.ok(generations[0].correlationId);
    assert.notStrictEqual(generations[0].correlationId, modifications[0].correlationId);
    console.log("quotes http: both the generation and the modification are in the readable audit trail");

    // =================================================== UNAUTHORIZED ACCESS
    // A customer cannot reach the costed view, by any route.
    assert.strictEqual((await call("/api/quotes/" + quoteId, { token: CUSTOMER_TOKEN })).status, 403);
    assert.strictEqual(
      (await call("/api/quotes", { method: "POST", token: CUSTOMER_TOKEN, body: sampleBody() })).status,
      403
    );
    assert.strictEqual(
      (await call("/api/quotes/" + quoteId, { method: "PATCH", token: CUSTOMER_TOKEN, body: { title: "x" } }))
        .status,
      403
    );
    // An advisor has no quotes OF THEIR OWN - the portal route is the
    // customer's, and seniority does not grant it.
    assert.strictEqual((await call("/api/portal/quotes", { token: ADVISOR_TOKEN })).status, 403);
    assert.strictEqual((await call("/api/portal/quotes/" + quoteId, { token: ADVISOR_TOKEN })).status, 403);
    // Nor do admin or sales reach either surface.
    for (const token of [ADMIN_TOKEN, SALES_TOKEN]) {
      assert.strictEqual((await call("/api/quotes/" + quoteId, { token: token })).status, 403);
      assert.strictEqual((await call("/api/portal/quotes", { token: token })).status, 403);
    }
    // And no anonymous caller reaches anything.
    assert.strictEqual((await call("/api/portal/quotes/" + quoteId)).status, 401);
    assert.strictEqual((await call("/api/quotes", { method: "POST", body: sampleBody() })).status, 401);
    console.log("quotes http: the costed view is reachable by advisors alone, the portal view by customers alone");

    // ANOTHER CUSTOMER'S QUOTE IS 404, NOT 403. A 403 would confirm it exists,
    // and walking ids would then map out the quote book.
    const stranger = await call("/api/portal/quotes/" + quoteId, { token: OTHER_CUSTOMER_TOKEN });
    assert.strictEqual(stranger.status, 404);
    assert.strictEqual((await stranger.json()).error, "unknown_quote");
    assert.strictEqual((await call("/api/portal/quotes", { token: OTHER_CUSTOMER_TOKEN })).status, 200);
    assert.strictEqual(
      (await (await call("/api/portal/quotes", { token: OTHER_CUSTOMER_TOKEN })).json()).count,
      0
    );
    console.log("quotes http: another customer's quote is indistinguishable from one that does not exist");

    // =============================================== FAILURE: INCORRECT PRICING
    // A quote that would price wrongly is refused at the boundary with the
    // full problem list, and nothing is stored.
    const badPrice = await call("/api/quotes", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: sampleBody({
        lines: [{ label: "Guide", unitCostCents: 90000, unitSellCents: 900, quantity: 1 }],
      }),
    });
    assert.strictEqual(badPrice.status, 400);
    const badPriceBody = await badPrice.json();
    assert.strictEqual(badPriceBody.error, "invalid_quote");
    assert.ok(badPriceBody.problems.some((p) => p.includes("below cost")));
    assert.strictEqual((await (await call("/api/portal/quotes", { token: CUSTOMER_TOKEN })).json()).count, 1);
    console.log("quotes http: a mispriced quote is refused with its problems and never stored");

    // A revision that would price wrongly leaves the customer's copy alone -
    // the worst outcome here is a half-changed document.
    const badRevision = await call("/api/quotes/" + quoteId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: { lines: [{ label: "Guide", unitCostCents: -1, unitSellCents: 2, quantity: 1 }] },
    });
    assert.strictEqual(badRevision.status, 400);
    const unchanged = await (await call("/api/portal/quotes/" + quoteId, { token: CUSTOMER_TOKEN })).json();
    assert.strictEqual(unchanged.quote.version, 2);
    assert.strictEqual(unchanged.quote.totalCents, 900000);
    console.log("quotes http: a refused revision leaves the customer looking at the last agreed quote");

    // ============================================ FAILURE: CUSTOMER VIEW ERROR
    // An id that cannot exist, an id that is malformed, and a body that is not
    // an object. None of these may be a 500 - they are all the caller's.
    assert.strictEqual((await call("/api/portal/quotes/quote_nope", { token: CUSTOMER_TOKEN })).status, 404);
    assert.strictEqual((await call("/api/quotes/quote_nope", { token: ADVISOR_TOKEN })).status, 404);
    // Outside the id pattern entirely - the route does not match, so it is a 404
    // from the router rather than reaching a service.
    assert.strictEqual((await call("/api/portal/quotes/" + "x".repeat(200), { token: CUSTOMER_TOKEN })).status, 404);
    for (const body of ["not an object", 42, ["a", "b"], null]) {
      const res = await call("/api/quotes", { method: "POST", token: ADVISOR_TOKEN, body: body });
      assert.ok(res.status === 400, "a non-object body must be a 400, got " + res.status);
    }
    console.log("quotes http: unknown, malformed and non-object requests are all refused as 4xx");

    // ================================================== FAILURE: QUOTE NOT SAVED
    // The store-level failure is proven in quoteStore.test.js against an
    // injected store; what is checked HERE is the contract it produces at the
    // boundary - that "not saved" and "audit unavailable" are 503s a client
    // should retry, not 400s it should give up on.
    const { REFUSAL_STATUS } = require("./routes/quoteRoutes");
    assert.strictEqual(REFUSAL_STATUS.not_saved, 503);
    assert.strictEqual(REFUSAL_STATUS.audit_unavailable, 503);
    assert.strictEqual(REFUSAL_STATUS.unknown_quote, 404);
    console.log("quotes http: a save that did not persist is a 503 the client may retry");

    // ======================================================== IDEMPOTENCY
    // The client pins the correlation id, which is what a retried submission
    // does. The second call must not issue a second quote.
    const pinned = "corr-http-idempotent-0001";
    const firstPost = await call("/api/quotes", {
      method: "POST",
      token: ADVISOR_TOKEN,
      correlationId: pinned,
      body: sampleBody({ title: "Retry test" }),
    });
    const secondPost = await call("/api/quotes", {
      method: "POST",
      token: ADVISOR_TOKEN,
      correlationId: pinned,
      body: sampleBody({ title: "Retry test" }),
    });
    assert.strictEqual(firstPost.status, 201);
    assert.strictEqual(secondPost.status, 200);
    const firstBody = await firstPost.json();
    const secondBody = await secondPost.json();
    assert.strictEqual(secondBody.status, "replayed");
    assert.strictEqual(secondBody.quote.quoteId, firstBody.quote.quoteId);
    assert.strictEqual((await (await call("/api/portal/quotes", { token: CUSTOMER_TOKEN })).json()).count, 2);
    console.log("quotes http: a resubmitted quote is replayed, not issued twice");

    console.log("quotes http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetQuotesForTests();
    __resetAssignmentsForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
