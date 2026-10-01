// STORY-009, the orchestration half. All three acceptance criteria are marked
// below, and all three named failure paths are exercised with an injected
// engine - one that throws, one that hangs, and one that lies about its shape.
//
// The rule these tests hold the service to: NOTHING LEAVES WITHOUT A RECORD.
// Every path through this module either writes an audit row or refuses to
// serve, and every outcome a customer would call disappointing also leaves a
// row in the advisor queue. A test that only checked the returned object would
// pass against a service that answered beautifully and recorded nothing, which
// is the one thing the trust criterion rules out.

const assert = require("assert");

const {
  suggestTripsForRequest,
  reviewIdFor,
  FLAG_REASONS,
  REFUSALS,
  FAILURE_MESSAGE,
} = require("./tripSuggestionService");
const { findAuditEntry, deriveAuditKey } = require("../audit/auditLog");
const { findReview } = require("../advisor/advisorReviewQueue");

const MARA = Object.freeze({
  tripId: "T-MARA",
  name: "Masai Mara Big Five",
  country: "Kenya",
  durationDays: 6,
  currency: "USD",
  pricePerPersonCents: 310000,
  interests: Object.freeze(["wildlife"]),
  popularityRank: 0,
  source: "product_book",
});
const SERENGETI = Object.freeze({
  tripId: "T-SERENGETI",
  name: "Serengeti Migration",
  country: "Tanzania",
  durationDays: 8,
  currency: "USD",
  pricePerPersonCents: 480000,
  interests: Object.freeze(["wildlife"]),
  popularityRank: 1,
  source: "product_book",
});
const TRIPS = Object.freeze([MARA, SERENGETI]);

// The audit log and the review queue are process-wide and append-only, with no
// reset by design. Unique ids per case keep the cases independent, which is
// also how the real system behaves - two customers are not each other's replay.
let sequence = 0;
function nextRequest(overrides) {
  sequence += 1;
  return Object.assign(
    {
      requestId: "REQ-SUGG-" + String(sequence).padStart(4, "0"),
      customerId: "CUST-1",
      correlationId: "corr-sugg-" + sequence,
    },
    overrides || {}
  );
}

function corpus(trips) {
  return function () {
    return trips;
  };
}

function auditFor(requestId, event) {
  return findAuditEntry(deriveAuditKey(requestId, event));
}

async function main() {
  // --- CRITERION 1: preferences in, relevant suggestions out -------------
  const wanted = nextRequest({ preferences: { countries: ["Kenya"], interests: ["wildlife"] } });
  const matched = await suggestTripsForRequest(wanted, { corpusSource: corpus(TRIPS) });

  assert.strictEqual(matched.ok, true);
  assert.strictEqual(matched.strategy, "matched");
  assert.deepStrictEqual(
    matched.suggestions.map(function (s) { return s.tripId; }),
    ["T-MARA"]
  );
  assert.strictEqual(matched.confidence, 1);
  // A confident, relevant answer does not trouble an advisor.
  assert.strictEqual(matched.flagged, false);
  assert.strictEqual(findReview(reviewIdFor(wanted.requestId)), undefined);
  console.log("tripSuggestionService: CRITERION 1 - stated preferences return relevant trips");

  // --- CRITERION 3 (TRUST): the suggestion is logged for review ----------
  //
  // Asserted on CONTENT, not just existence. The question this log exists to
  // answer is "why was this suggested?", and a row saying only "suggestions
  // happened" cannot answer it.
  const entry = auditFor(wanted.requestId, "suggestions.generated");
  assert.ok(entry, "a generated suggestion must be audited");
  assert.strictEqual(entry.outcome, "success");
  assert.strictEqual(entry.resource, wanted.requestId);
  assert.strictEqual(entry.actor, "CUST-1");
  assert.strictEqual(entry.correlationId, wanted.correlationId);
  assert.strictEqual(entry.context.strategy, "matched");
  assert.deepStrictEqual(entry.context.tripIds, ["T-MARA"]);
  assert.deepStrictEqual(entry.context.scores, [1]);
  assert.deepStrictEqual(entry.context.preferenceDimensions, ["countries", "interests"]);
  assert.strictEqual(entry.context.flagged, false);
  console.log("tripSuggestionService: CRITERION 3 - every suggestion is audited with its reasons");

  // The row records WHICH dimensions were stated, never their values. An audit
  // log is permanent, and a customer's budget does not need to live in one
  // forever to explain a ranking.
  assert.strictEqual(JSON.stringify(entry.context).indexOf("maxBudget"), -1);

  // Replay safety: the same request twice audits ONCE and says so. Without
  // this, a client retrying a request it was unsure of would double the log.
  const again = await suggestTripsForRequest(wanted, { corpusSource: corpus(TRIPS) });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.replayed, true);
  assert.deepStrictEqual(auditFor(wanted.requestId, "suggestions.generated"), entry);
  console.log("tripSuggestionService: the same request twice leaves one audit row, flagged as a replay");

  // --- CRITERION 2: no preferences -> popular trips ----------------------
  const browsing = nextRequest({});
  const popular = await suggestTripsForRequest(browsing, { corpusSource: corpus(TRIPS) });
  assert.strictEqual(popular.ok, true);
  assert.strictEqual(popular.strategy, "popular");
  assert.deepStrictEqual(
    popular.suggestions.map(function (s) { return s.tripId; }),
    ["T-MARA", "T-SERENGETI"]
  );
  // Not flagged: a customer who stated nothing has not made an uncertain
  // request, and flagging every browse would bury the queue the guardrail
  // depends on.
  assert.strictEqual(popular.flagged, false);
  assert.strictEqual(auditFor(browsing.requestId, "suggestions.generated").context.strategy, "popular");
  console.log("tripSuggestionService: CRITERION 2 - no preferences returns popular trips, unflagged");

  // --- FAILURE PATH: no suggestions generated ----------------------------
  //
  // Two ways to get here, and they are flagged differently on purpose: one is
  // about the customer's request, the other is about us having nothing to sell.
  const unmatchable = nextRequest({ preferences: { countries: ["Iceland"] } });
  const noMatch = await suggestTripsForRequest(unmatchable, { corpusSource: corpus(TRIPS) });
  assert.strictEqual(noMatch.ok, true);
  assert.deepStrictEqual(noMatch.suggestions, []);
  assert.strictEqual(noMatch.flagged, true);
  assert.deepStrictEqual(noMatch.flagReasons, [FLAG_REASONS.NO_MATCH]);
  const noMatchReview = findReview(reviewIdFor(unmatchable.requestId));
  assert.deepStrictEqual(noMatchReview.reasons, [FLAG_REASONS.NO_MATCH]);
  assert.strictEqual(noMatchReview.status, "pending_review");
  assert.strictEqual(noMatchReview.customerId, "CUST-1");
  console.log("tripSuggestionService: FAILURE PATH - nothing matched is flagged for an advisor");

  const emptyShelf = nextRequest({});
  const noTrips = await suggestTripsForRequest(emptyShelf, { corpusSource: corpus([]) });
  assert.deepStrictEqual(noTrips.suggestions, []);
  assert.deepStrictEqual(noTrips.flagReasons, [FLAG_REASONS.NO_TRIPS]);
  assert.strictEqual(auditFor(emptyShelf.requestId, "suggestions.generated").context.flagged, true);
  console.log("tripSuggestionService: FAILURE PATH - an empty corpus is flagged, not shown as 'no matches'");

  // --- FAILURE PATH: irrelevant suggestions (the thin match) -------------
  //
  // One of two stated interests matched, which clears the relevance floor and
  // nothing more. The customer still gets the trip - something to look at
  // beats a blank page - AND a human is told to check it.
  const thin = nextRequest({ preferences: { interests: ["wildlife", "beach"] } });
  const lowConfidence = await suggestTripsForRequest(thin, { corpusSource: corpus([MARA]) });
  assert.strictEqual(lowConfidence.ok, true);
  assert.strictEqual(lowConfidence.suggestions.length, 1);
  assert.strictEqual(lowConfidence.confidence, 0.5);
  assert.strictEqual(lowConfidence.flagged, true);
  assert.deepStrictEqual(lowConfidence.flagReasons, [FLAG_REASONS.LOW_CONFIDENCE]);
  assert.deepStrictEqual(
    findReview(reviewIdFor(thin.requestId)).reasons,
    [FLAG_REASONS.LOW_CONFIDENCE]
  );
  console.log("tripSuggestionService: FAILURE PATH - a thin match is shown AND flagged");

  // --- FAILURE PATH: AI processing error ---------------------------------
  //
  // (a) The engine throws. Not retried - a broken engine does not fix itself -
  // and reported as an error, never as "nothing matched", which would be a
  // platform fault wearing a travel answer's clothes.
  let calls = 0;
  const broken = nextRequest({ preferences: { countries: ["Kenya"] } });
  const thrown = await suggestTripsForRequest(broken, {
    corpusSource: corpus(TRIPS),
    engine: function () {
      calls += 1;
      const error = new Error("model exploded");
      error.name = "UpstreamUnavailable";
      throw error;
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(thrown.ok, false);
  assert.strictEqual(thrown.reason, REFUSALS.ENGINE_ERROR);
  assert.strictEqual(thrown.errorClass, "UpstreamUnavailable");
  assert.strictEqual(thrown.message, FAILURE_MESSAGE);
  assert.ok(thrown.suggestions === undefined, "a failed run must not return suggestions");
  // Audited as a failure, and flagged. A log of only the answers we managed to
  // give cannot tell you about the customer we kept failing.
  const failedEntry = auditFor(broken.requestId, "suggestions.failed");
  assert.strictEqual(failedEntry.outcome, "failure");
  assert.strictEqual(failedEntry.context.errorClass, "UpstreamUnavailable");
  assert.deepStrictEqual(
    findReview(reviewIdFor(broken.requestId)).reasons,
    [FLAG_REASONS.ENGINE_ERROR]
  );
  console.log("tripSuggestionService: FAILURE PATH - an engine that throws is refused, audited and flagged");

  // (b) The engine hangs. THIS is what the retry envelope is for: today's
  // engine is synchronous and could never time out, but the port exists so a
  // remote one can be dropped in, and it must already be wrapped when it is.
  let hangs = 0;
  const slow = nextRequest({ preferences: { countries: ["Kenya"] } });
  const timedOut = await suggestTripsForRequest(slow, {
    corpusSource: corpus(TRIPS),
    timeoutMs: 20,
    maxAttempts: 2,
    engine: function () {
      hangs += 1;
      return new Promise(function () {});
    },
  });
  // Retried once, then capped. An unbounded retry is explicitly prohibited.
  assert.strictEqual(hangs, 2);
  assert.strictEqual(timedOut.ok, false);
  assert.strictEqual(timedOut.errorClass, "TimeoutError");
  assert.strictEqual(auditFor(slow.requestId, "suggestions.failed").context.engineAttempts, 2);
  console.log("tripSuggestionService: FAILURE PATH - an engine that hangs times out, retries once, stops");

  // (c) The engine answers, but not in a shape we recognise. For the engine we
  // have not written yet: a model-backed one can return anything, and odd must
  // fail like an error rather than become a 200 with undefined in it.
  const lying = nextRequest({});
  const garbage = await suggestTripsForRequest(lying, {
    corpusSource: corpus(TRIPS),
    engine: function () {
      return { suggestions: "three lovely safaris" };
    },
  });
  assert.strictEqual(garbage.ok, false);
  assert.strictEqual(garbage.errorClass, "ContractViolation");
  assert.strictEqual(garbage.flagged, true);
  console.log("tripSuggestionService: FAILURE PATH - an engine returning the wrong shape is a failure");

  // --- REFUSALS: a request we cannot identify or audit --------------------
  const unidentified = await suggestTripsForRequest({ correlationId: "corr-x" });
  assert.strictEqual(unidentified.ok, false);
  assert.strictEqual(unidentified.reason, REFUSALS.UNIDENTIFIED);
  assert.strictEqual((await suggestTripsForRequest(null)).reason, REFUSALS.UNIDENTIFIED);
  assert.strictEqual((await suggestTripsForRequest("REQ-1234567")).reason, REFUSALS.UNIDENTIFIED);
  console.log("tripSuggestionService: a request with no usable id is refused, not answered");

  const uncorrelated = nextRequest({ correlationId: "   " });
  assert.strictEqual(
    (await suggestTripsForRequest(uncorrelated, { corpusSource: corpus(TRIPS) })).reason,
    REFUSALS.MISSING_CORRELATION_ID
  );
  console.log("tripSuggestionService: a request with no correlationId is refused");

  // Malformed preferences are a caller bug, refused with the problem list -
  // and audited, so a client failing this way repeatedly is discoverable.
  const malformed = nextRequest({ preferences: "somewhere warm" });
  const refused = await suggestTripsForRequest(malformed, { corpusSource: corpus(TRIPS) });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, REFUSALS.INVALID_PREFERENCES);
  assert.ok(refused.problems.length > 0);
  assert.strictEqual(auditFor(malformed.requestId, "suggestions.refused").outcome, "failure");
  console.log("tripSuggestionService: malformed preferences are refused with a readable problem list");

  // THE ONE WE WILL NOT SERVE THROUGH. If the audit write fails there is no
  // honest way to hand over the suggestions - we would be claiming a record we
  // do not have. So the customer is refused, exactly as safariProductStore
  // refuses an unauditable change.
  const unauditable = nextRequest({});
  const notAudited = await suggestTripsForRequest(unauditable, {
    corpusSource: corpus(TRIPS),
    audit: function () {
      throw new Error("disk full");
    },
  });
  assert.strictEqual(notAudited.ok, false);
  assert.strictEqual(notAudited.reason, REFUSALS.NOT_AUDITABLE);
  assert.ok(notAudited.suggestions === undefined);
  console.log("tripSuggestionService: suggestions that cannot be audited are not served");

  // A queue that refuses a write must not lose the suggestions we already
  // audited: the flag is best-effort ON TOP of the answer, never a gate on it.
  const unflaggable = nextRequest({ preferences: { countries: ["Iceland"] } });
  const stillAnswered = await suggestTripsForRequest(unflaggable, {
    corpusSource: corpus(TRIPS),
    queue: function () {
      throw new Error("queue unavailable");
    },
  });
  assert.strictEqual(stillAnswered.ok, true);
  assert.strictEqual(stillAnswered.flagged, false);
  assert.deepStrictEqual(stillAnswered.flagReasons, [FLAG_REASONS.NO_MATCH]);
  assert.ok(auditFor(unflaggable.requestId, "suggestions.generated"));
  console.log("tripSuggestionService: a failing review queue is logged, and does not lose the answer");

  console.log("tripSuggestionService: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
