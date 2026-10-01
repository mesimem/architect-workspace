// STORY-009: trip suggestions, tested over real HTTP.
//
// The service suites prove the DECISIONS - suggestionEngine.test.js that a
// relevant trip ranks first and an irrelevant one is dropped,
// tripSuggestionService.test.js that every outcome is audited and the thin
// ones reach an advisor. This suite proves the WIRING, which is where the
// bugs that matter actually live:
//
//   - the permission the route DECLARES is the one enforced, for every role;
//   - the audit row is really readable afterwards through the API, by an
//     admin, rather than only in a unit test;
//   - the advisor flag really lands in the queue an advisor reads;
//   - the actor on the audit row is the AUTHENTICATED caller, not whatever
//     the body claimed.
//
// All three acceptance criteria are marked below. The product book is left
// empty on purpose, so the corpus falls back to the seeded catalog and the
// expected list is exactly one known trip - SF-300, the Serengeti Migration
// Safari. A test that asserted "some suggestions came back" would pass against
// a service returning the whole catalog to everybody.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { __resetProductsForTests } = require("../services/products/safariProductStore");
const { REFUSALS } = require("../services/suggestions/tripSuggestionService");
const {
  REFUSAL_STATUS,
  NO_SUGGESTIONS_MESSAGE,
} = require("./routes/suggestionRoutes");

const CUSTOMER_TOKEN = "test-customer-token-suggestions";
const ADVISOR_TOKEN = "test-advisor-token-suggestions";
const SALES_TOKEN = "test-sales-token-suggestions";
const PM_TOKEN = "test-pm-token-suggestions";
const ADMIN_TOKEN = "test-admin-token-suggestions";

const CUSTOMER_USER = "CUST-SUGG-1";

const TOKENS = [
  CUSTOMER_TOKEN + ":customer:" + CUSTOMER_USER,
  ADVISOR_TOKEN + ":advisor:ADV-SUGG-1",
  SALES_TOKEN + ":sales:SALES-SUGG-1",
  PM_TOKEN + ":product_manager:PM-SUGG-1",
  ADMIN_TOKEN + ":admin:ADMIN-SUGG-1",
].join(",");

// The one complete record in the seeded catalog - see the header.
const SEEDED_TRIP = "SF-300";

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  __resetProductsForTests();
  clearFailureTracking();

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
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  function suggest(body, token) {
    return call("/api/suggestions/trips", {
      method: "POST",
      token: token || CUSTOMER_TOKEN,
      body: body,
    });
  }

  async function auditEntries() {
    const res = await call("/api/admin/audit", { token: ADMIN_TOKEN });
    assert.strictEqual(res.status, 200);
    return (await res.json()).entries;
  }

  try {
    // ================================================= ACCEPTANCE CRITERION 1
    // "Given a customer provides preferences, when AI processes them, then it
    // suggests relevant trips."
    const matchedRes = await suggest({
      requestId: "REQ-HTTP-SUGG-MATCHED",
      preferences: { countries: ["Tanzania"], interests: ["wildlife"] },
    });
    assert.strictEqual(matchedRes.status, 200);
    const matched = await matchedRes.json();
    assert.strictEqual(matched.strategy, "matched");
    assert.strictEqual(matched.count, 1);
    assert.strictEqual(matched.suggestions[0].tripId, SEEDED_TRIP);
    assert.strictEqual(matched.suggestions[0].score, 1);
    // The suggestion explains itself to the customer, in their terms.
    assert.deepStrictEqual(matched.suggestions[0].reasons, [
      "in Tanzania, which you asked for",
      "matches your interest in wildlife",
    ]);
    // A confident answer does not say a human is coming, because one is not.
    assert.strictEqual(matched.flagged, false);
    assert.strictEqual(matched.message, null);
    console.log("suggestions: CRITERION 1 - preferences return relevant trips over HTTP");

    // ================================================= ACCEPTANCE CRITERION 3
    // "The system logs all AI suggestions for review." Read back through the
    // admin API, which is a stronger proof than reading the module's store.
    const afterMatch = await auditEntries();
    const logged = afterMatch.find(function (entry) {
      return entry.resource === "REQ-HTTP-SUGG-MATCHED" && entry.event === "suggestions.generated";
    });
    assert.ok(logged, "the suggestion must be in the audit trail an admin can read");
    assert.strictEqual(logged.outcome, "success");
    assert.deepStrictEqual(logged.context.tripIds, [SEEDED_TRIP]);
    assert.strictEqual(logged.context.strategy, "matched");
    // THE ACTOR IS THE AUTHENTICATED CALLER. Not the body, which did not get
    // to nominate anybody.
    assert.strictEqual(logged.actor, CUSTOMER_USER);
    console.log("suggestions: CRITERION 3 - the suggestion is in the audit trail, attributed");

    // The same requestId twice is one record, and says so. A client retrying a
    // request it is unsure of must not double the log.
    const replayRes = await suggest({
      requestId: "REQ-HTTP-SUGG-MATCHED",
      preferences: { countries: ["Tanzania"], interests: ["wildlife"] },
    });
    const replayed = await replayRes.json();
    assert.strictEqual(replayed.replayed, true);
    const rows = (await auditEntries()).filter(function (entry) {
      return entry.resource === "REQ-HTTP-SUGG-MATCHED" && entry.event === "suggestions.generated";
    });
    assert.strictEqual(rows.length, 1);
    console.log("suggestions: a replayed requestId leaves one audit row, and reports the replay");

    // ================================================= ACCEPTANCE CRITERION 2
    // "Given a customer provides no preferences, when AI processes, then it
    // suggests popular trips."
    const popularRes = await suggest({ requestId: "REQ-HTTP-SUGG-POPULAR" });
    assert.strictEqual(popularRes.status, 200);
    const popular = await popularRes.json();
    assert.strictEqual(popular.strategy, "popular");
    assert.strictEqual(popular.count, 1);
    assert.strictEqual(popular.suggestions[0].tripId, SEEDED_TRIP);
    assert.deepStrictEqual(popular.suggestions[0].reasons, ["one of our most-booked trips"]);
    // Browsing is not an uncertain request - it must not reach the queue.
    assert.strictEqual(popular.flagged, false);
    console.log("suggestions: CRITERION 2 - no preferences returns popular trips, unflagged");

    // A request with no requestId at all still works and is still audited,
    // under an id derived from the correlation id.
    const anonymousRes = await suggest({});
    assert.strictEqual(anonymousRes.status, 200);
    const correlationId = anonymousRes.headers.get("X-Correlation-ID");
    assert.ok(
      (await auditEntries()).some(function (entry) {
        return entry.resource === "sugg-req-" + correlationId;
      }),
      "a request without a requestId is audited under the correlation id"
    );
    console.log("suggestions: a request with no requestId is still recorded, under its correlation id");

    // --- FAILURE PATH: no suggestions generated --------------------------
    //
    // 200, not 404: the request succeeded and was recorded, there is just
    // nothing to show. And the customer is TOLD a human is coming rather than
    // left to infer it from an empty array.
    const emptyRes = await suggest({
      requestId: "REQ-HTTP-SUGG-NOMATCH",
      preferences: { countries: ["Iceland"] },
    });
    assert.strictEqual(emptyRes.status, 200);
    const empty = await emptyRes.json();
    assert.strictEqual(empty.count, 0);
    assert.strictEqual(empty.flagged, true);
    assert.strictEqual(empty.message, NO_SUGGESTIONS_MESSAGE);

    // AND IT REALLY REACHED THE QUEUE AN ADVISOR READS. This is the guardrail
    // ("flag uncertain customer requests for travel advisor review") proved
    // end to end rather than asserted against an in-memory map.
    const reviewsRes = await call("/api/advisor/reviews", { token: ADVISOR_TOKEN });
    assert.strictEqual(reviewsRes.status, 200);
    const reviews = (await reviewsRes.json()).reviews;
    const flaggedReview = reviews.find(function (review) {
      return review.requestId === "sugg:REQ-HTTP-SUGG-NOMATCH";
    });
    assert.ok(flaggedReview, "an unanswerable request must be in the advisor queue");
    assert.strictEqual(flaggedReview.status, "pending_review");
    assert.deepStrictEqual(flaggedReview.reasons, ["no_suggestions_for_stated_preferences"]);
    console.log("suggestions: FAILURE PATH - an unanswerable request is flagged into the advisor queue");

    // --- MALFORMED INPUT --------------------------------------------------
    const badPrefsRes = await suggest({
      requestId: "REQ-HTTP-SUGG-BADPREFS",
      preferences: { interests: ["teleportation"] },
    });
    assert.strictEqual(badPrefsRes.status, 400);
    const badPrefs = await badPrefsRes.json();
    assert.strictEqual(badPrefs.error, REFUSALS.INVALID_PREFERENCES);
    assert.ok(badPrefs.problems.length > 0, "the caller is told what was wrong");
    // Refusals are audited too - a client failing this way repeatedly is
    // discoverable rather than invisible.
    assert.ok(
      (await auditEntries()).some(function (entry) {
        return entry.resource === "REQ-HTTP-SUGG-BADPREFS" && entry.event === "suggestions.refused";
      })
    );
    console.log("suggestions: unknown preferences are a 400 with a problem list, and are audited");

    for (const body of ["somewhere warm", 42, ["Kenya"]]) {
      const res = await suggest(body);
      assert.strictEqual(res.status, 400, JSON.stringify(body) + " is not a request body");
      assert.strictEqual((await res.json()).error, "invalid_request_body");
    }
    console.log("suggestions: a body that is not an object is refused at the boundary");

    // A requestId too short to key an audit row is the caller's problem, not a
    // 500. The floor exists because an audit key must be unambiguous.
    const shortIdRes = await suggest({ requestId: "x" });
    assert.strictEqual(shortIdRes.status, 400);
    assert.strictEqual((await shortIdRes.json()).error, REFUSALS.UNIDENTIFIED);
    console.log("suggestions: an unusable requestId is a 400, not a crash");

    // EVERY REFUSAL THE SERVICE CAN RETURN HAS A STATUS. This is the test that
    // catches the next person (or the next engine) adding a refusal and
    // forgetting the table - without it that refusal silently becomes a 500.
    Object.values(REFUSALS).forEach(function (reason) {
      assert.ok(
        REFUSAL_STATUS[reason] !== undefined,
        "refusal " + reason + " has no HTTP status mapped"
      );
    });
    console.log("suggestions: every service refusal maps to a deliberate status code");

    // --- THE GUARDRAIL: AUTH AND ROLES ------------------------------------
    //
    // The sharpest case is sales/product_manager/admin: roles that can log in,
    // hold real grants elsewhere, and must not be able to spend engine effort
    // or fill the advisor queue here. A test that only checked "no token gets
    // 401" would pass even if suggestions.request had been given to everyone.
    const anonRes = await call("/api/suggestions/trips", { method: "POST", body: {} });
    assert.strictEqual(anonRes.status, 401);

    for (const token of [SALES_TOKEN, PM_TOKEN, ADMIN_TOKEN]) {
      const res = await suggest({}, token);
      assert.strictEqual(res.status, 403, "only customers and advisors may ask for suggestions");
      assert.strictEqual((await res.json()).error, "forbidden");
    }

    // An advisor may ask - it is the same job as quoting, one step earlier.
    const advisorRes = await suggest({ requestId: "REQ-HTTP-SUGG-ADVISOR" }, ADVISOR_TOKEN);
    assert.strictEqual(advisorRes.status, 200);
    console.log("suggestions: GUARDRAIL - customers and advisors may ask; nobody else can");

    // A GET is not this route. Asking for suggestions writes an audit row, and
    // a GET that changes state is one something will eventually prefetch.
    const getRes = await call("/api/suggestions/trips", { token: CUSTOMER_TOKEN });
    assert.strictEqual(getRes.status, 405);
    console.log("suggestions: the route is POST only");

    console.log("suggestions: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
