// STORY-003: the bridge between "a service could not serve this customer" and
// "an advisor should look at it".
//
// requestTriageService.js handles requests that arrive unclear. This module
// handles the other direction: a request that looked fine until a service
// tried to fulfil it and could not. Both end in the same review queue, because
// an advisor does not care which code path gave up.
//
// WHAT IS ROUTED IS AN EXPLICIT LIST, AND THAT IS THE POINT.
// It would be easy to route every non-success outcome in the codebase. That
// would be wrong: within a week the queue would be mostly timeouts and
// declined cards, advisors would stop reading it, and the genuine
// "this customer needs help" flags would be lost inside the noise. A flag an
// advisor ignores is worse than no flag, because it looks like coverage.
//
// The test for inclusion is: WOULD A HUMAN ADVISOR CHANGE THIS OUTCOME?
//   - unsupported destination -> yes. An advisor can offer somewhere we do
//     sell, or arrange the trip specially. The customer wants something real.
//   - incomplete safari details -> yes. An advisor can quote it manually while
//     the catalog record is unfinished.
//   - a trip that cannot be assembled because a leg is unavailable -> yes,
//     and this is the strongest case in the system. A full-service agency
//     exists precisely to find the other lodge when the first one is full.
//     The customer is known and is actively trying to give us money.
//   - payment declined -> NO. An advisor cannot make a card work. That is
//     between the customer and their bank.
//   - invalid customer details -> NO, despite being tempting. If the customer
//     details are unusable there is nobody for an advisor to call, so the row
//     would be a task no human can action. It fails the test above.
//   - timeout / upstream unavailable -> NO. Nobody is helped by an advisor
//     reading about a network fault. That is an alerting concern, and routing
//     it here would mean one outage floods the queue with hundreds of rows.

const { queueForReview } = require("./advisorReviewQueue");
const { notifyAdvisor, defaultAdvisorNotifier } = require("./advisorNotifier");

// (source, outcome) -> the reason an advisor sees. Anything absent from this
// map is deliberately not routed.
const ROUTABLE_OUTCOMES = {
  "safari-details:unsupported": "unsupported_destination",
  "safari-details:incomplete": "details_incomplete",
  "booking:unavailable": "booking_selection_unavailable",
};

function routingReasonFor(source, outcome) {
  return ROUTABLE_OUTCOMES[source + ":" + outcome];
}

function logRoutingEvent(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: "advisor-routing",
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

// Never throws. A service calling this is in the middle of answering a
// customer; a problem creating the review must not turn a handled failure into
// an unhandled one. The customer still gets their "contact an advisor"
// message either way - what varies is whether we also queued the work.
async function routeOutcomeToAdvisor({
  source,
  outcome,
  requestId,
  customerId,
  context,
  notify = defaultAdvisorNotifier,
  timeoutMs,
  maxAttempts,
}) {
  const reason = routingReasonFor(source, outcome);
  if (!reason) {
    return { routed: false, skipped: true };
  }

  let queued;
  try {
    queued = queueForReview(requestId, {
      customerId: customerId,
      reasons: [reason],
      source: source,
      context: context || null,
      flaggedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Same contract as requestTriageService: a failed audit write is reported,
    // never swallowed, and nobody is paged about a row that does not exist.
    logRoutingEvent("error", "flag_not_recorded", {
      source: source,
      outcome: outcome,
      reason: reason,
      error_class: error && error.name && error.name !== "Error" ? error.name : "ValidationError",
    });
    return { routed: false, error: "flag_not_recorded" };
  }

  const notification = await notifyAdvisor({
    review: queued.review,
    notify: notify,
    timeoutMs: timeoutMs,
    maxAttempts: maxAttempts,
  });

  logRoutingEvent("info", "outcome_routed_to_advisor", {
    requestId: requestId,
    source: source,
    outcome: outcome,
    reason: reason,
    replayed: queued.replayed,
    notification: notification.status,
  });

  return {
    routed: true,
    reason: reason,
    review: queued.review,
    replayed: queued.replayed,
    notification: notification,
  };
}

module.exports = { routeOutcomeToAdvisor, ROUTABLE_OUTCOMES };
