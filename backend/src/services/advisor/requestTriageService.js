// STORY-003: decide whether a customer request is clear enough to act on, or
// whether it must go to a human travel advisor first (REQ-005).
//
// THE RULES ARE DETERMINISTIC ON PURPOSE. CLAUDE.md's core principle is that
// probabilistic components do not decide production outcomes, and a safety
// requirement is the last place to put a coin flip. Every rule below is a
// plain check a junior developer can read, reproduce and argue with. No model
// is consulted, so the same request always triages the same way.
//
// THE GOVERNING BIAS IS: WHEN IN DOUBT, FLAG. The two possible mistakes are
// not equal. Flagging a clear request costs an advisor a few seconds' glance.
// Failing to flag an unclear one is invisible - nobody is looking, because the
// system said it was fine - and it is the first failure path this story names.
// So anything unrecognised, unparseable or unexpected flags rather than
// passes, and a request is only ever reported `clear` when it has passed every
// rule explicitly.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A request is never silently dropped. Either
//     it is `clear`, or it is `flagged` and written to the review queue, or
//     the call is refused as `invalid_request` - and `invalid_request` is
//     deliberately NOT `clear`, so a platform bug can never be mistaken for a
//     customer whose request was fine.
//  2. Will it retry? Nothing to retry here - triage is a pure function over
//     the request. The retryable part is advisor notification, which lands in
//     the next step of this story.
//  3. Recovery path? The review queue IS the recovery path: a flagged request
//     sits there until an advisor picks it up, whether or not anything
//     downstream succeeded.
//  4. Handled here: missing required details, vague wording, contradictory or
//     unparseable dates, party sizes we cannot serve, and input that is not a
//     usable request at all. NOT handled here: judging whether a request that
//     is well-formed is also *sensible* (a plausible but wrong destination
//     reads as clear), spelling correction, translation, or any semantic
//     understanding of the notes beyond the explicit marker list below.

const { queueForReview, isValidRequestId } = require("./advisorReviewQueue");
const { notifyAdvisor, defaultAdvisorNotifier } = require("./advisorNotifier");
// Read-only use of the catalog's raw list source, deliberately NOT
// africanSectionService.listAfricanDestinations(): that function logs a
// customer interaction with the African section, and triaging a request is
// not the customer browsing it. Borrowing it would put fictional rows in an
// audit log.
const { defaultCatalogListSource } = require("../africa/catalogSource");
const { callWithRetry, classifyFailure } = require("../shared/callWithRetry");

const MIN_PARTY_SIZE = 1;
// 12 is not invented here - it is the party-size ceiling mcp/trip-quotes
// already enforces on a quote. One bound, one place to change it.
const MAX_PARTY_SIZE = 12;

// Explicit and small, deliberately. A broad "sounds vague" regex would flag
// ordinary sentences, and every false flag trains an advisor to stop reading
// the queue - at which point the real flags are lost too. These are phrases
// that state uncertainty outright.
const VAGUENESS_MARKERS = [
  "not sure",
  "unsure",
  "no idea",
  "maybe",
  "possibly",
  "sometime",
  "some time",
  "somewhere",
  "anywhere",
  "whenever",
  "flexible",
  "something like",
  "or something",
];

// Word-boundary matching so "flexible" does not fire inside another word.
const VAGUENESS_PATTERN = new RegExp(
  "\\b(" + VAGUENESS_MARKERS.map(function (m) { return m.replace(/ /g, "\\s+"); }).join("|") + ")\\b",
  "i"
);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUsableRequest(request) {
  return (
    request !== null &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    isNonEmptyString(request.customerId)
  );
}

// Structured JSON to stderr, per CLAUDE.md's observability rules. stderr and
// not stdout so this stays usable if a service is ever driven over a stdio
// protocol. IDs and reason codes only - never the customer's own words, which
// are free text we have not sanitised and do not need in a log line.
function logTriageEvent(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: "advisor-triage",
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

// A bare `new Error(...)` reports its name as "Error", which CLAUDE.md rules
// out as a classification because it says nothing. Anything thrown without
// naming itself is classified by what it means where it was caught.
function classifyThrown(error, fallback) {
  const name = error && error.name;
  return !name || name === "Error" ? fallback : name;
}

// Each rule returns a reason code or null. Kept as one list so adding a rule
// is one entry, and so the reasons an advisor sees are always in a stable
// order regardless of which fired.
const RULES = [
  {
    reason: "missing_required_details",
    // Notes alone never make a request actionable: an advisor cannot book
    // against prose. The structured fields have to be there.
    test: function (r) {
      return (
        !isNonEmptyString(r.destination) ||
        !r.travelDates ||
        !isNonEmptyString(r.travelDates.depart) ||
        !isNonEmptyString(r.travelDates.return) ||
        r.partySize === undefined ||
        r.partySize === null
      );
    },
  },
  {
    reason: "ambiguous_wording",
    test: function (r) {
      return isNonEmptyString(r.notes) && VAGUENESS_PATTERN.test(r.notes);
    },
  },
  {
    reason: "unparseable_dates",
    test: function (r) {
      if (!r.travelDates) return false;
      const depart = Date.parse(r.travelDates.depart);
      const back = Date.parse(r.travelDates.return);
      // Only complains when a date was supplied but cannot be read. A missing
      // date is already `missing_required_details`; reporting both would tell
      // an advisor the same thing twice.
      const suppliedButBad =
        (isNonEmptyString(r.travelDates.depart) && Number.isNaN(depart)) ||
        (isNonEmptyString(r.travelDates.return) && Number.isNaN(back));
      return suppliedButBad;
    },
  },
  {
    reason: "conflicting_dates",
    test: function (r) {
      if (!r.travelDates) return false;
      const depart = Date.parse(r.travelDates.depart);
      const back = Date.parse(r.travelDates.return);
      if (Number.isNaN(depart) || Number.isNaN(back)) return false; // covered above
      return back < depart;
    },
  },
  {
    reason: "party_size_out_of_range",
    test: function (r) {
      if (r.partySize === undefined || r.partySize === null) return false; // missing, not out of range
      return (
        typeof r.partySize !== "number" ||
        !Number.isInteger(r.partySize) ||
        r.partySize < MIN_PARTY_SIZE ||
        r.partySize > MAX_PARTY_SIZE
      );
    },
  },
];

// Is this somewhere we actually sell? Exact, case-insensitive match against a
// catalog row's id, name or country.
//
// WHY EXACT AND NOT FUZZY: a substring match would let "a" match everything,
// and a clever similarity score would reintroduce exactly the guessing this
// service exists to avoid. A customer who writes "Tanzania" matches the
// country; one who writes "Africa" does not, and being asked which country is
// a reasonable thing for an advisor to do.
function matchesCatalogRow(row, needle) {
  return [row.destinationId, row.name, row.country]
    .filter(isNonEmptyString)
    .some(function (field) {
      return field.trim().toLowerCase() === needle;
    });
}

// The rule that closes the "well-formed but not sensible" hole: before this,
// a request naming a destination we do not sell read as `clear`, because every
// structured field was present. Async because it reads the catalog, so it is
// separate from the synchronous rule list above.
//
// Both failure modes flag rather than pass. If the catalog cannot be reached
// we do not know whether we sell the place, and "we do not know" is the
// definition of a request that needs a human.
async function checkDestination(request, source, timeoutMs, maxAttempts) {
  if (!isNonEmptyString(request.destination)) {
    return []; // already covered by missing_required_details; do not say it twice
  }

  const read = await callWithRetry(source, undefined, timeoutMs, maxAttempts);

  if (!read.ok) {
    const failure = classifyFailure(read);
    logTriageEvent("error", "destination_check_failed", {
      requestId: request.requestId,
      error_class: failure.errorClass,
      attempts: read.attempts,
    });
    return ["destination_unverified"];
  }

  if (!Array.isArray(read.value)) {
    logTriageEvent("error", "destination_check_failed", {
      requestId: request.requestId,
      error_class: "ContractViolation",
      attempts: read.attempts,
    });
    return ["destination_unverified"];
  }

  const needle = request.destination.trim().toLowerCase();
  const known = read.value.some(function (row) {
    return row && matchesCatalogRow(row, needle);
  });

  return known ? [] : ["unsupported_destination"];
}

// Runs every rule. A rule that throws counts as FIRED, not as passed - a
// broken rule must never be the reason a request slips through unflagged.
function collectReasons(request) {
  const reasons = [];
  for (const rule of RULES) {
    let fired;
    try {
      fired = rule.test(request);
    } catch (error) {
      logTriageEvent("error", "triage_rule_threw", {
        rule: rule.reason,
        error_class: classifyThrown(error, "RuleEvaluationError"),
      });
      fired = true; // fail toward review
    }
    if (fired) {
      reasons.push(rule.reason);
    }
  }
  return reasons;
}

// `notify`, `timeoutMs` and `maxAttempts` are injected so a caller (and a
// test) can supply a channel that is slow, broken, or simply counting calls.
// The default notifier writes to an in-memory outbox and sends nothing real.
async function triageRequest(request, {
  notify = defaultAdvisorNotifier,
  timeoutMs,
  maxAttempts,
  queue = queueForReview,
  destinationSource = defaultCatalogListSource,
} = {}) {
  // A request we cannot identify cannot be audited, and an audit row is the
  // whole point of flagging. Refuse loudly rather than inventing an id -
  // a generated id would also destroy the idempotency the queue depends on.
  if (!isUsableRequest(request) || !isValidRequestId(request.requestId)) {
    logTriageEvent("error", "triage_refused", {
      error_class: "ValidationError",
      reason: "unrecognized_request",
    });
    return {
      status: "invalid_request",
      reasons: ["unrecognized_request"],
      message: "This request could not be processed — an advisor will follow up.",
    };
  }

  // Synchronous rules first, then the catalog check. Reasons keep a stable
  // order - shape problems, then "we do not sell that" - so an advisor reading
  // two flags side by side sees them in the same sequence every time.
  const reasons = collectReasons(request).concat(
    await checkDestination(request, destinationSource, timeoutMs, maxAttempts)
  );

  if (reasons.length === 0) {
    logTriageEvent("info", "request_triaged_clear", { requestId: request.requestId });
    return { status: "clear", reasons: [] };
  }

  // FAILURE PATH: "flagged request not logged". If the audit write fails we
  // must not pretend the flag landed. Three deliberate choices here:
  //  - the reasons go into the error log line, so even when the row could not
  //    be written the decision still leaves a trace in the log stream;
  //  - no advisor is notified, because a page pointing at a review row that
  //    does not exist sends someone looking for nothing;
  //  - the status is `flag_not_recorded`, which is neither `clear` nor
  //    `flagged` - the caller must handle it, and cannot mistake it for
  //    either a healthy pass or a completed flag.
  let queued;
  try {
    queued = queue(request.requestId, {
      customerId: request.customerId,
      reasons: reasons,
      flaggedAt: new Date().toISOString(),
    });
  } catch (error) {
    logTriageEvent("error", "flag_not_recorded", {
      requestId: request.requestId,
      reasons: reasons,
      error_class: classifyThrown(error, "UpstreamUnavailable"),
    });
    return {
      status: "flag_not_recorded",
      reasons: reasons,
      message: "This request could not be processed — an advisor will follow up.",
    };
  }

  logTriageEvent("info", "request_flagged_for_review", {
    requestId: request.requestId,
    reasons: reasons,
    replayed: queued.replayed,
  });

  // ORDER MATTERS: the review row is already written by this point. Notifying
  // an advisor is best-effort ON TOP of the flag, never a precondition for it.
  // Whatever happens next, the request is in the queue.
  const notification = await notifyAdvisor({
    review: queued.review,
    notify: notify,
    timeoutMs: timeoutMs,
    maxAttempts: maxAttempts,
  });

  return {
    status: "flagged",
    reasons: reasons,
    review: queued.review,
    replayed: queued.replayed,
    notification: notification,
    message: "A travel advisor will review this request and follow up.",
  };
}

module.exports = {
  triageRequest,
  VAGUENESS_MARKERS,
  MIN_PARTY_SIZE,
  MAX_PARTY_SIZE,
};
