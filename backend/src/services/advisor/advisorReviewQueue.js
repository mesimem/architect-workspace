// STORY-003: the queue of customer requests flagged for travel advisor review,
// and the audit trail of those flags (REQ-005, plus the project guardrail
// "the system must maintain audit logs for all transactions and changes").
//
// In-memory stand-in, same as the other stores in this repo - it will become a
// table. The shape is chosen so that swap is a storage change and not a
// redesign: one row per request, keyed by the caller's requestId.
//
// Idempotent by requestId: queueing the same request twice returns the
// existing review rather than creating a second one. An advisor must not open
// their queue and find the same customer three times because a retry fired.
//
// WHY THE KEY IS GUARDED. Same defect class that was found in
// backend/src/services/africa/interactionLog.js: if `undefined` is an
// acceptable key, the first flag is stored and every later flag silently
// matches it and is dropped. For an audit log that is the worst failure
// available - it looks healthy and is quietly wrong. Bounds mirror that module
// and bookTripService.js so all three agree.

const MIN_ID_LENGTH = 8;
const MAX_ID_LENGTH = 128;

const REVIEWS = new Map();

class InvalidRequestIdError extends Error {
  constructor(requestId) {
    // Reports the shape of the bad id, never a value that might have come
    // from somewhere untrusted.
    const shape =
      typeof requestId === "string"
        ? "a string of length " + requestId.length
        : "type " + typeof requestId;
    super(
      "requestId must be a string of " +
        MIN_ID_LENGTH +
        "-" +
        MAX_ID_LENGTH +
        " characters; received " +
        shape
    );
    this.name = "InvalidRequestIdError";
    this.errorClass = "ValidationError";
  }
}

function isValidRequestId(requestId) {
  return (
    typeof requestId === "string" &&
    requestId.length >= MIN_ID_LENGTH &&
    requestId.length <= MAX_ID_LENGTH
  );
}

// Returns the stored review. `replayed` tells the caller whether this call
// created the row or found one already there - which is what lets the service
// above decide not to notify an advisor a second time.
function queueForReview(requestId, review) {
  if (!isValidRequestId(requestId)) {
    throw new InvalidRequestIdError(requestId);
  }

  const existing = REVIEWS.get(requestId);
  if (existing) {
    return { review: existing, replayed: true };
  }

  const entry = Object.assign({ requestId: requestId, status: "pending_review" }, review);
  REVIEWS.set(requestId, entry);
  return { review: entry, replayed: false };
}

// Records what happened when we tried to tell an advisor about this review.
//
// The review's own `status` is deliberately NOT changed by this: whether an
// advisor was successfully paged has no bearing on whether the request still
// needs reviewing. A flag whose notification failed is still a flag, and it
// stays `pending_review` so it is still in the queue an advisor reads. That is
// the whole defence against the "advisor notification failure" failure path -
// the notification is best-effort, the queue row is the source of truth.
//
// Returns undefined if there is no such review; it will never create one,
// because a notification record without a flag would be a row nobody asked
// for.
function recordNotification(requestId, notificationStatus, detail) {
  const entry = REVIEWS.get(requestId);
  if (!entry) {
    return undefined;
  }
  entry.notificationStatus = notificationStatus;
  entry.notificationDetail = detail || null;
  entry.notificationUpdatedAt = new Date().toISOString();
  return findReview(requestId);
}

function findReview(requestId) {
  const entry = REVIEWS.get(requestId);
  // A copy, so a caller cannot reach through the return value and rewrite the
  // stored audit row. The nested reasons array is copied too - a shallow copy
  // would leave it shared, which is the leak found in mcp/booking-desk.
  return entry ? Object.assign({}, entry, { reasons: (entry.reasons || []).slice() }) : undefined;
}

function getQueuedReviews() {
  return Array.from(REVIEWS.keys()).map(findReview);
}

module.exports = {
  queueForReview,
  recordNotification,
  findReview,
  getQueuedReviews,
  isValidRequestId,
  InvalidRequestIdError,
  MIN_ID_LENGTH,
  MAX_ID_LENGTH,
};
