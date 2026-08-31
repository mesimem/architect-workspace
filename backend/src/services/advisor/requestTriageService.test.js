const assert = require("assert");
const { triageRequest } = require("./requestTriageService");
const {
  getQueuedReviews,
  findReview,
  queueForReview,
  InvalidRequestIdError,
} = require("./advisorReviewQueue");

// A request with every structured field present and unambiguous notes. Each
// test below starts from this and breaks exactly one thing, so a failure names
// the rule that broke rather than leaving you to diff two blobs.
function completeRequest(overrides) {
  return Object.assign(
    {
      requestId: "REQ-COMPLETE-0001",
      customerId: "CUST-1",
      destination: "Tanzania",
      travelDates: { depart: "2026-10-12", return: "2026-10-23" },
      partySize: 2,
      notes: "We would like the Serengeti migration safari with a private guide.",
    },
    overrides
  );
}

async function main() {
  // Acceptance 2 (the negative case, and the one that catches an over-eager
  // rule): a complete request is NOT flagged and creates no review.
  const clear = await triageRequest(completeRequest());

  assert.strictEqual(clear.status, "clear");
  assert.deepStrictEqual(clear.reasons, []);
  assert.strictEqual(findReview("REQ-COMPLETE-0001"), undefined);

  console.log("requestTriage: complete request is not flagged");

  // Acceptance 1: an unclear request is flagged for advisor review.
  const unclear = await triageRequest(
    completeRequest({
      requestId: "REQ-UNCLEAR-0001",
      travelDates: { depart: "", return: "" },
      notes: "Somewhere in Africa sometime next year, we are not sure yet.",
    })
  );

  assert.strictEqual(unclear.status, "flagged");
  assert.ok(unclear.reasons.includes("missing_required_details"));
  assert.ok(unclear.reasons.includes("ambiguous_wording"));
  assert.strictEqual(
    unclear.message,
    "A travel advisor will review this request and follow up."
  );

  console.log("requestTriage: unclear request is flagged for advisor review");

  // Acceptance 3: the flag is written to the audit trail an advisor reads.
  const review = findReview("REQ-UNCLEAR-0001");
  assert.ok(review, "flagged request must be in the review queue");
  assert.strictEqual(review.status, "pending_review");
  assert.strictEqual(review.customerId, "CUST-1");
  assert.ok(review.reasons.includes("ambiguous_wording"));
  assert.ok(typeof review.flaggedAt === "string" && review.flaggedAt.length > 0);

  console.log("requestTriage: flagged request is logged for audit");

  // Each rule fires on its own, so a passing suite means five working rules
  // and not one rule doing all the work.
  const cases = [
    {
      name: "missing destination",
      overrides: { requestId: "REQ-RULE-MISSING1", destination: "   " },
      expect: "missing_required_details",
    },
    {
      name: "missing party size",
      overrides: { requestId: "REQ-RULE-MISSING2", partySize: undefined },
      expect: "missing_required_details",
    },
    {
      name: "vague notes",
      overrides: { requestId: "REQ-RULE-VAGUE001", notes: "Dates are flexible." },
      expect: "ambiguous_wording",
    },
    {
      name: "unreadable date",
      overrides: {
        requestId: "REQ-RULE-BADDATE1",
        travelDates: { depart: "next octoberish", return: "2026-10-23" },
      },
      expect: "unparseable_dates",
    },
    {
      name: "return before departure",
      overrides: {
        requestId: "REQ-RULE-BACKWARD",
        travelDates: { depart: "2026-10-23", return: "2026-10-12" },
      },
      expect: "conflicting_dates",
    },
    {
      name: "party of zero",
      overrides: { requestId: "REQ-RULE-PARTY000", partySize: 0 },
      expect: "party_size_out_of_range",
    },
    {
      name: "party too large to serve",
      overrides: { requestId: "REQ-RULE-PARTY013", partySize: 13 },
      expect: "party_size_out_of_range",
    },
    {
      name: "party size not a number",
      overrides: { requestId: "REQ-RULE-PARTYSTR", partySize: "two" },
      expect: "party_size_out_of_range",
    },
  ];

  for (const testCase of cases) {
    const result = await triageRequest(completeRequest(testCase.overrides));
    assert.strictEqual(result.status, "flagged", testCase.name + " should flag");
    assert.ok(
      result.reasons.includes(testCase.expect),
      testCase.name + " should report " + testCase.expect + ", got " + result.reasons.join(",")
    );
  }

  console.log("requestTriage: all " + cases.length + " rule cases fire individually");

  // Boundary: 1 and 12 are servable party sizes, 0 and 13 are not (checked
  // above). Off-by-one in either direction would either turn away a real
  // customer or accept a party we cannot book.
  for (const size of [1, 12]) {
    const result = await triageRequest(
      completeRequest({ requestId: "REQ-BOUNDARY-" + size, partySize: size })
    );
    assert.strictEqual(result.status, "clear", "party of " + size + " should be servable");
  }

  console.log("requestTriage: party-size boundaries 1 and 12 are accepted");

  // Idempotency: the same request triaged twice leaves ONE review. An advisor
  // must not find the same customer twice because a retry fired.
  const before = getQueuedReviews().length;
  const replay = await triageRequest(
    completeRequest({
      requestId: "REQ-UNCLEAR-0001",
      travelDates: { depart: "", return: "" },
      notes: "Somewhere in Africa sometime next year, we are not sure yet.",
    })
  );

  assert.strictEqual(replay.status, "flagged");
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.review.flaggedAt, review.flaggedAt); // the original row
  assert.strictEqual(getQueuedReviews().length, before);

  console.log("requestTriage: replaying a request does not queue it twice");

  // Fail-safe: input that is not a usable request is never reported clear.
  // This is the first named failure path - an unclear request going unflagged
  // is invisible, so the refusal has to be loud and must not look like a pass.
  const junkInputs = [
    undefined,
    null,
    "just a string",
    [],
    {},
    { customerId: "CUST-1" }, // no requestId
    { requestId: "REQ-NO-CUSTOMER-1" }, // no customerId
    { requestId: "short", customerId: "CUST-1" }, // id too short to audit
  ];

  const queuedBeforeJunk = getQueuedReviews().length;

  for (const junk of junkInputs) {
    const result = await triageRequest(junk);
    assert.notStrictEqual(result.status, "clear", "junk input must never read as clear");
    assert.strictEqual(result.status, "invalid_request");
    assert.deepStrictEqual(result.reasons, ["unrecognized_request"]);
  }

  assert.strictEqual(getQueuedReviews().length, queuedBeforeJunk);

  console.log("requestTriage: unusable input is refused, never reported clear");

  // The audit row is a copy: reading the queue cannot rewrite it.
  const row = findReview("REQ-UNCLEAR-0001");
  row.status = "MUTATED";
  row.reasons.push("MUTATED");
  const reread = findReview("REQ-UNCLEAR-0001");
  assert.strictEqual(reread.status, "pending_review");
  assert.ok(!reread.reasons.includes("MUTATED"));

  console.log("requestTriage: audit rows are copies, not references into the store");

  // Last line of defence: the queue itself refuses a key it cannot audit by.
  assert.throws(
    function () {
      queueForReview(undefined, { customerId: "CUST-1", reasons: [] });
    },
    function (error) {
      return error instanceof InvalidRequestIdError && error.errorClass === "ValidationError";
    }
  );

  console.log("requestTriage: the review queue rejects an unusable requestId");

  // FAILURE PATH: "unclear request not flagged". A rule that throws must count
  // as fired, never as passed - a broken rule is the quietest way for an
  // unclear request to be waved through. Simulated with a property that throws
  // when a rule reads it, which is as close to a genuinely broken rule as this
  // can get without shipping one.
  const explosive = completeRequest({ requestId: "REQ-RULE-EXPLODES" });
  Object.defineProperty(explosive, "travelDates", {
    get: function () {
      throw new Error("field read blew up");
    },
    enumerable: true,
  });

  const survived = await triageRequest(explosive);
  assert.strictEqual(survived.status, "flagged", "a throwing rule must flag, not pass");
  assert.ok(survived.reasons.length > 0);
  assert.ok(findReview("REQ-RULE-EXPLODES"), "the flag must still be recorded");

  console.log("requestTriage: a rule that throws flags the request instead of passing it");

  // FAILURE PATH: "flagged request not logged". If the audit write fails, the
  // call must NOT report success and must NOT page an advisor about a review
  // row that does not exist.
  let notifyCalls = 0;
  const notLogged = await triageRequest(
    completeRequest({ requestId: "REQ-STORE-BROKEN", partySize: 0 }),
    {
      queue: function () {
        throw new Error("review store unavailable");
      },
      notify: function () {
        notifyCalls += 1;
        return Promise.resolve({ delivered: true });
      },
    }
  );

  assert.strictEqual(notLogged.status, "flag_not_recorded");
  assert.notStrictEqual(notLogged.status, "clear");
  assert.notStrictEqual(notLogged.status, "flagged");
  assert.ok(notLogged.reasons.includes("party_size_out_of_range"));
  assert.strictEqual(notLogged.review, undefined);
  assert.strictEqual(notifyCalls, 0, "must not page an advisor about a row that was never written");
  assert.strictEqual(findReview("REQ-STORE-BROKEN"), undefined);

  console.log("requestTriage: a failed audit write is reported, not passed off as success");

  // A request can be perfectly well-formed and still be one we cannot serve.
  // Before the catalog check this read as `clear`, which is the "plausible but
  // wrong" hole: every field present, destination nobody sells.
  const narnia = await triageRequest(
    completeRequest({ requestId: "REQ-DEST-UNKNOWN", destination: "Narnia" })
  );
  assert.strictEqual(narnia.status, "flagged");
  assert.ok(narnia.reasons.includes("unsupported_destination"));

  console.log("requestTriage: a destination we do not sell is flagged, not passed as clear");

  // The catalog is matched on id, name OR country, so a customer does not have
  // to know our internal identifiers to be understood.
  const byId = await triageRequest(
    completeRequest({ requestId: "REQ-DEST-BYID001", destination: "SF-300" })
  );
  const byName = await triageRequest(
    completeRequest({ requestId: "REQ-DEST-BYNAME1", destination: "serengeti migration safari" })
  );
  assert.strictEqual(byId.status, "clear");
  assert.strictEqual(byName.status, "clear"); // case-insensitive

  console.log("requestTriage: destination matches on id, name or country");

  // When the catalog cannot be read we do not know whether we sell the place.
  // "We do not know" is the definition of a request that needs a human, so it
  // flags rather than passing.
  const unverified = await triageRequest(
    completeRequest({ requestId: "REQ-DEST-NOCHECK" }),
    {
      destinationSource: function () {
        return new Promise(function () {}); // catalog hangs
      },
      timeoutMs: 20,
      maxAttempts: 2,
    }
  );
  assert.strictEqual(unverified.status, "flagged");
  assert.ok(unverified.reasons.includes("destination_unverified"));

  const brokenCatalog = await triageRequest(
    completeRequest({ requestId: "REQ-DEST-BROKEN1" }),
    {
      destinationSource: function () {
        return Promise.reject(new Error("catalog connection refused"));
      },
      timeoutMs: 20,
    }
  );
  assert.strictEqual(brokenCatalog.status, "flagged");
  assert.ok(brokenCatalog.reasons.includes("destination_unverified"));

  console.log("requestTriage: an unreadable catalog flags rather than passing the request");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
