// STORY-003: tell a travel advisor that a request is waiting for them.
//
// NOTHING HERE SENDS A REAL MESSAGE. The default notifier appends to an
// in-memory outbox. Wiring a real channel (Mandrill, Basecamp, a queue) needs
// credentials this repo deliberately does not hold, and CLAUDE.md forbids
// workers sending real communications during tests. When a real channel is
// added it goes in behind the same injected `notify` argument, so everything
// below - timeout, retries, idempotency, the failure contract - applies to it
// unchanged.
//
// THE RULE THAT MATTERS: A FAILED NOTIFICATION MUST NOT LOSE THE FLAG.
// The review row is the source of truth and it is written before we ever try
// to notify. Notification is best-effort on top of it. If every attempt fails,
// the row stays `pending_review` and is marked so an advisor (or a later
// sweep) can see the page never landed - the request does not vanish just
// because a mail server was down.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? The flag survives, the row is marked
//     `failed` with a stable error class, and the caller is told plainly. No
//     exception escapes to the customer-facing path.
//  2. Will it retry? Only on timeout, capped - the shared policy in
//     shared/callWithRetry.js. A notifier that throws is not retried.
//  3. Recovery when retries are exhausted? The queue itself. A failed
//     notification is NOT recorded as delivered, so a later call for the same
//     request will try again; and the row carries `notificationStatus:
//     "failed"` so a sweep can find everything that needs re-paging. There is
//     no dead-letter store yet, and inventing one before there is a real
//     channel to fail against would be pretend machinery.
//  4. Handled here: notifier too slow, notifier throwing, the same request
//     being notified twice, and an unusable request id. NOT handled: a
//     notifier that reports success while silently dropping the message (we
//     cannot detect that without delivery receipts from a real channel), and
//     two processes notifying concurrently for one request - this store is
//     in-memory and single-process, so the real fix is a unique constraint in
//     Postgres, same as everywhere else in this repo.

const { recordNotification, isValidRequestId } = require("./advisorReviewQueue");
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  callWithRetry,
  classifyFailure,
  logFailure,
} = require("../shared/callWithRetry");

const SERVICE_NAME = "advisor-notify";

// Stand-in for a real channel. Exported so tests and the demo can read what
// would have been sent.
const OUTBOX = [];

// Requests already successfully notified. This is what stops a retry paging an
// advisor twice for one request.
const NOTIFIED = new Set();

async function defaultAdvisorNotifier(message) {
  OUTBOX.push(message);
  return { delivered: true, channel: "in-memory-outbox" };
}

function getOutbox() {
  return OUTBOX.map(function (m) {
    return Object.assign({}, m, { reasons: (m.reasons || []).slice() });
  });
}

// Only the facts an advisor needs to pick the work up. No free-text customer
// prose: it is unsanitised input, and the advisor reads the full request in
// the queue anyway.
function buildMessage(review) {
  return {
    requestId: review.requestId,
    customerId: review.customerId,
    reasons: (review.reasons || []).slice(),
    flaggedAt: review.flaggedAt,
    subject: "Customer request needs advisor review: " + review.requestId,
  };
}

async function notifyAdvisor({
  review,
  notify = defaultAdvisorNotifier,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (!review || !isValidRequestId(review.requestId)) {
    logFailure(SERVICE_NAME, "advisor_notification_refused", "ValidationError", 0, {
      reason: "unusable_review",
    });
    return { status: "invalid_request", notified: false };
  }

  // Idempotency: a request already paged is not paged again. Checked before
  // the call, so a retry cannot reach the channel at all.
  if (NOTIFIED.has(review.requestId)) {
    return { status: "already_notified", notified: true, replayed: true, attempts: 0 };
  }

  const result = await callWithRetry(notify, buildMessage(review), timeoutMs, maxAttempts);

  if (!result.ok) {
    const failure = classifyFailure(result);
    logFailure(SERVICE_NAME, "advisor_notification_failed", failure.errorClass, result.attempts, {
      requestId: review.requestId,
    });
    // Marked, not deleted. The flag stands and stays in the queue.
    recordNotification(review.requestId, "failed", failure.errorClass);
    return {
      status: "notification_failed",
      notified: false,
      replayed: false,
      errorClass: failure.errorClass,
      attempts: result.attempts,
    };
  }

  NOTIFIED.add(review.requestId);
  recordNotification(review.requestId, "notified", null);
  return { status: "notified", notified: true, replayed: false, attempts: result.attempts };
}

module.exports = {
  notifyAdvisor,
  defaultAdvisorNotifier,
  getOutbox,
};
