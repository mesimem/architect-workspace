// STORY-009: the orchestration. One customer request in; an audited, possibly
// flagged set of trip suggestions out.
//
// THIS MODULE DECIDES NOTHING ABOUT TRAVEL. It does not score, it does not know
// what a safari is, and it never looks at a price. What it owns is everything
// that must be true WHATEVER engine produced the suggestions:
//
//   - the request is well-formed, or it is refused with a readable reason;
//   - the engine is called behind an explicit timeout and capped retries;
//   - every outcome - suggested, refused, or broken - lands in the audit log;
//   - a request we answered badly, or could not answer, reaches a human.
//
// That split is what makes the engine swappable. Drop a model-backed engine in
// through the `engine` option and it inherits this file's timeout, retry,
// audit trail and advisor flag without a line of it changing.
//
// THE THREE FAILURE PATHS THE STORY NAMES, AND WHERE EACH LANDS:
//   No suggestions generated -> FLAG_REASONS.NO_MATCH / NO_TRIPS below. An
//                               empty list is audited and queued for an
//                               advisor; the customer is told a human is
//                               coming, not shown an empty page.
//   Irrelevant suggestions   -> prevented in suggestionEngine.js (the
//                               relevance floor and the interest filter), and
//                               caught here as LOW_CONFIDENCE: a match we are
//                               not sure of is shown AND flagged, because the
//                               customer is better served by something to look
//                               at plus a human who will correct it.
//   AI processing error      -> the retry envelope below. A throw or a timeout
//                               is refused, audited as a failure, classified
//                               with a stable error_class, and flagged. It is
//                               never reported as "no trips matched", which
//                               would be a platform fault wearing a travel
//                               answer's clothes.
//
// WHY A `popular` RESULT IS NOT FLAGGED. REQ-005 asks us to flag UNCERTAIN
// customer requests. Somebody who stated no preferences has not made an
// uncertain request - they are browsing, and there is nothing about them we
// could have misunderstood. Flagging every browse would bury the queue the
// guardrail depends on, which is the failure mode requestTriageService.js's
// header warns about: a queue nobody reads protects nobody. An empty popular
// result IS flagged, because that one is about us, not them.
//
// WHY NO ADVISOR IS PAGED. Unlike triage, a flag here does not call
// notifyAdvisor. The queue row is the source of truth in both (see that
// module's header), and a suggestion request is not an incident - paging a
// human the moment a browse returns a thin match is how an on-call rota stops
// being answered. The row is in the queue an advisor reads.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Never a throw and never a silent empty
//     list. Every path returns a tagged result object: ok with suggestions, or
//     ok:false with a reason the route maps to a status. The one unrecoverable
//     case - the audit write itself failing - is handled in auditOutcome
//     below: we refuse to serve rather than suggest unauditably.
//  2. Will it retry? The engine call does, via shared/callWithRetry: timeouts
//     only, capped, fixed backoff. A throw is NOT retried - a malformed
//     request or a rejected credential does not fix itself. Nothing else
//     retries; the audit and queue writes are keyed and the caller may safely
//     resubmit the whole request instead.
//  3. Recovery path? A travel advisor. Every outcome a customer would call
//     disappointing leaves a row in the review queue with the reason attached.
//  4. Handled: a request we cannot identify or audit, malformed preferences,
//     an empty corpus, an engine that throws, hangs, or returns a shape we do
//     not recognise, a thin match, and a replayed request. NOT handled:
//     notifying the advisor (see above), pagination beyond `limit`, caching a
//     previous answer for the same customer, and personalisation from history.

const {
  suggestTrips,
  validatePreferences,
  hasAnyPreference,
  statedDimensions,
} = require("./suggestionEngine");
const { listTripCorpus } = require("./tripCorpus");
const { recordAudit, deriveAuditKey, isValidAuditKey } = require("../audit/auditLog");
const { queueForReview } = require("../advisor/advisorReviewQueue");
const { callWithRetry, classifyFailure, logFailure } = require("../shared/callWithRetry");

const SERVICE_NAME = "trip-suggestions";

// A matched result at or below this is shown AND flagged. 0.6 is a judgement
// call: with two stated dimensions it means "matched one of the two things you
// said, not both".
const ADVISOR_REVIEW_CONFIDENCE = 0.6;

const FLAG_REASONS = Object.freeze({
  NO_MATCH: "no_suggestions_for_stated_preferences",
  NO_TRIPS: "no_trips_available_to_suggest",
  LOW_CONFIDENCE: "low_confidence_suggestions",
  ENGINE_ERROR: "suggestion_engine_error",
});

const REFUSALS = Object.freeze({
  UNIDENTIFIED: "unidentified_request",
  MISSING_CORRELATION_ID: "missing_correlation_id",
  INVALID_PREFERENCES: "invalid_preferences",
  ENGINE_ERROR: "suggestion_engine_error",
  NOT_AUDITABLE: "suggestions_not_auditable",
});

// One sentence, the same whichever way we failed. A customer does not need to
// know whether the engine timed out or returned nonsense, and telling them
// leaks our internals; they need to know a person is coming.
const FAILURE_MESSAGE =
  "We couldn't put trip ideas together just now — a travel advisor will follow up.";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function logEvent(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: SERVICE_NAME,
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

// The review row is keyed on a DERIVED id, not the bare requestId.
//
// advisorReviewQueue is keyed on requestId and is first-write-wins, and
// requestTriageService already writes to it. Sharing the key would mean a
// request that was triaged and then asked for suggestions could only ever hold
// ONE of the two flags - whichever got there first - and the other would vanish
// with no error. The prefix keeps the two kinds of flag separate while leaving
// the original id readable in the queue.
function reviewIdFor(requestId) {
  return "sugg:" + requestId;
}

// What a suggestion result looks like, checked before we believe it.
//
// This is here for the engine we have NOT written yet. Today's engine is pure
// and returns a known shape; a model-backed one can return anything at all,
// and "the engine returned something odd" must fail like an error rather than
// become a 200 with `undefined` in it. ContractViolation is the error_class
// CLAUDE.md names for exactly this.
function isUsableEngineResult(result) {
  return (
    isPlainObject(result) &&
    Array.isArray(result.suggestions) &&
    typeof result.strategy === "string" &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence)
  );
}

// Writes the audit row, and converts a failure to write it into a refusal.
//
// REQ-017 and this story's trust criterion both say the suggestions are
// logged. If that write fails there is no honest way to also hand the customer
// the suggestions: we would be claiming a record we do not have. So this
// returns null and the caller refuses - the same posture safariProductStore
// takes on an unauditable mutation.
function auditOutcome(audit, { requestId, outcome, event, actor, correlationId, context }) {
  const auditKey = deriveAuditKey(requestId, event);
  if (!isValidAuditKey(auditKey)) {
    return null;
  }
  try {
    return audit({
      auditKey: auditKey,
      event: event,
      outcome: outcome,
      actor: actor,
      resource: requestId,
      correlationId: correlationId,
      context: context,
    });
  } catch (error) {
    logFailure(SERVICE_NAME, "suggestions_not_auditable", error.errorClass || "UpstreamUnavailable", 1, {
      requestId: requestId,
      event: event,
    });
    return null;
  }
}

// Which flags this outcome earns. Returns [] for a result that needs no human.
function flagReasonsFor(result, preferences) {
  if (result.suggestions.length === 0) {
    return [hasAnyPreference(preferences) ? FLAG_REASONS.NO_MATCH : FLAG_REASONS.NO_TRIPS];
  }
  if (result.strategy === "matched" && result.confidence <= ADVISOR_REVIEW_CONFIDENCE) {
    return [FLAG_REASONS.LOW_CONFIDENCE];
  }
  return [];
}

// Best-effort by design: a queue write that fails must not lose the
// suggestions we already audited. It IS logged at error, so a queue that has
// started refusing writes is visible rather than quietly empty.
function flagForAdvisor(queue, { requestId, customerId, reasons }) {
  try {
    const queued = queue(reviewIdFor(requestId), {
      customerId: isNonBlankString(customerId) ? customerId : null,
      reasons: reasons,
      flaggedAt: new Date().toISOString(),
    });
    logEvent("info", "suggestions_flagged_for_review", {
      requestId: requestId,
      reasons: reasons,
      replayed: queued.replayed,
    });
    return { flagged: true, replayed: queued.replayed };
  } catch (error) {
    logFailure(SERVICE_NAME, "flag_not_recorded", error.errorClass || "UpstreamUnavailable", 1, {
      requestId: requestId,
      reasons: reasons,
    });
    return { flagged: false, replayed: false };
  }
}

// Audit context: IDs, counts and codes only.
//
// NOT the preference VALUES. Only which dimensions were stated. An audit row is
// append-only and permanent, and a customer's budget is not something that
// needs to live there forever to answer the question this log exists to answer
// ("why was this suggested?"). The dimension names plus the per-trip scores
// answer it. Kept flat, too: auditLog truncates past MAX_CONTEXT_DEPTH, so an
// array of suggestion objects would audit as "<truncated>".
function auditContextFor(result, preferences, attempts, flagReasons) {
  return {
    strategy: result.strategy,
    confidence: result.confidence,
    confidenceBasis: result.confidenceBasis || null,
    suggestionCount: result.suggestions.length,
    tripIds: result.suggestions.map(function (s) { return s.tripId; }),
    scores: result.suggestions.map(function (s) { return s.score; }),
    preferenceDimensions: statedDimensions(preferences),
    engineAttempts: attempts,
    flagged: flagReasons.length > 0,
    flagReasons: flagReasons,
  };
}

// `engine`, `corpusSource`, `timeoutMs`, `maxAttempts`, `queue` and `audit` are
// injected so a test can supply an engine that is slow, broken, or lying, and
// so the model-backed engine of a later story needs no change here.
async function suggestTripsForRequest(request, {
  engine = suggestTrips,
  corpusSource = listTripCorpus,
  timeoutMs,
  maxAttempts,
  queue = queueForReview,
  audit = recordAudit,
} = {}) {
  // A request we cannot identify cannot be audited, and an unauditable
  // suggestion is one we are not allowed to make. Refuse rather than invent an
  // id - a generated one would also destroy the replay safety below.
  if (!isPlainObject(request) || !isValidAuditKey(request.requestId)) {
    logEvent("error", "suggestions_refused", { reason: REFUSALS.UNIDENTIFIED });
    return { ok: false, reason: REFUSALS.UNIDENTIFIED, problems: ["requestId is missing or unusable."], message: FAILURE_MESSAGE };
  }
  if (!isNonBlankString(request.correlationId)) {
    logEvent("error", "suggestions_refused", {
      requestId: request.requestId,
      reason: REFUSALS.MISSING_CORRELATION_ID,
    });
    return { ok: false, reason: REFUSALS.MISSING_CORRELATION_ID, problems: ["correlationId is required."], message: FAILURE_MESSAGE };
  }

  const preferences = request.preferences;
  const problems = validatePreferences(preferences);
  if (problems.length > 0) {
    // Audited as a failure. A log of only the answers we managed to give
    // cannot tell you about the customer whose request we kept rejecting.
    auditOutcome(audit, {
      requestId: request.requestId,
      outcome: "failure",
      event: "suggestions.refused",
      actor: request.customerId,
      correlationId: request.correlationId,
      context: { reason: REFUSALS.INVALID_PREFERENCES, problemCount: problems.length },
    });
    logEvent("error", "suggestions_refused", {
      requestId: request.requestId,
      reason: REFUSALS.INVALID_PREFERENCES,
      problemCount: problems.length,
    });
    return { ok: false, reason: REFUSALS.INVALID_PREFERENCES, problems: problems, message: FAILURE_MESSAGE };
  }

  const trips = corpusSource();

  // THE PORT CALL. Pointless against today's synchronous engine, and that is
  // the point: this is the envelope a remote engine inherits for free.
  const call = await callWithRetry(
    engine,
    { preferences: preferences, trips: trips, limit: request.limit },
    timeoutMs,
    maxAttempts
  );

  // FAILURE PATH: "AI processing error". A hang, a throw, or a shape we do not
  // recognise all arrive here and are treated identically from the customer's
  // side - refused, audited, flagged.
  if (!call.ok || !isUsableEngineResult(call.value)) {
    const failure = call.ok
      ? { status: "contract", errorClass: "ContractViolation" }
      : classifyFailure(call);
    logFailure(SERVICE_NAME, "suggestion_engine_failed", failure.errorClass, call.attempts, {
      requestId: request.requestId,
      status: failure.status,
    });
    auditOutcome(audit, {
      requestId: request.requestId,
      outcome: "failure",
      event: "suggestions.failed",
      actor: request.customerId,
      correlationId: request.correlationId,
      context: {
        reason: REFUSALS.ENGINE_ERROR,
        errorClass: failure.errorClass,
        engineAttempts: call.attempts,
        preferenceDimensions: statedDimensions(preferences),
      },
    });
    const flag = flagForAdvisor(queue, {
      requestId: request.requestId,
      customerId: request.customerId,
      reasons: [FLAG_REASONS.ENGINE_ERROR],
    });
    return {
      ok: false,
      reason: REFUSALS.ENGINE_ERROR,
      errorClass: failure.errorClass,
      flagged: flag.flagged,
      flagReasons: [FLAG_REASONS.ENGINE_ERROR],
      message: FAILURE_MESSAGE,
    };
  }

  const result = call.value;
  const flagReasons = flagReasonsFor(result, preferences);

  // AUDIT BEFORE THE FLAG AND BEFORE THE RETURN. Same ordering rule as
  // safariProductStore: audited-but-unflagged is a traceable gap, flagged or
  // answered but unaudited is a suggestion with no record of why it was made.
  const audited = auditOutcome(audit, {
    requestId: request.requestId,
    outcome: "success",
    event: "suggestions.generated",
    actor: request.customerId,
    correlationId: request.correlationId,
    context: auditContextFor(result, preferences, call.attempts, flagReasons),
  });
  if (audited === null) {
    return { ok: false, reason: REFUSALS.NOT_AUDITABLE, problems: ["The suggestion could not be recorded."], message: FAILURE_MESSAGE };
  }

  const flag = flagReasons.length > 0
    ? flagForAdvisor(queue, {
        requestId: request.requestId,
        customerId: request.customerId,
        reasons: flagReasons,
      })
    : { flagged: false, replayed: false };

  logEvent("info", "suggestions_generated", {
    requestId: request.requestId,
    strategy: result.strategy,
    suggestionCount: result.suggestions.length,
    confidence: result.confidence,
    flagged: flag.flagged,
    replayedAudit: audited.replayed,
  });

  return {
    ok: true,
    strategy: result.strategy,
    confidence: result.confidence,
    confidenceBasis: result.confidenceBasis || null,
    suggestions: result.suggestions,
    // Reported honestly rather than hidden: a thin answer tells the customer a
    // human is looking at it, which is the only reason flagging helps them.
    flagged: flag.flagged,
    flagReasons: flagReasons,
    // True when this exact request had already been answered and audited. A
    // client retrying a request it is unsure of can tell.
    replayed: audited.replayed,
  };
}

module.exports = {
  suggestTripsForRequest,
  reviewIdFor,
  ADVISOR_REVIEW_CONFIDENCE,
  FLAG_REASONS,
  REFUSALS,
  FAILURE_MESSAGE,
};
