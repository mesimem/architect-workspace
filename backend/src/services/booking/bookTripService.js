// STORY-001: pure booking logic — no I/O yet. Availability is an in-memory
// stand-in for a real inventory system, seeded for tests until one exists.
//
// IDEMPOTENCY (added 2026-08-28). bookTrip() now REQUIRES an idempotencyKey.
// Before this change it issued a fresh `TRIP-${nextTripId++}` on every call
// with no dedup at all, so booking the same trip twice produced two trip IDs
// and charged the client twice. That violated the blueprint's day-one
// guarantee ("no double-booking, no payment errors — every time") and
// CLAUDE.md's non-negotiable idempotency rule. The key pattern is the one
// already used correctly by ../africa/interactionLog.js.
//
// BREAKING CONTRACT CHANGE: idempotencyKey is required, and every result now
// carries a `replayed` flag. The only caller in the repo is
// bookTripService.test.js, updated in the same diff.
//
// Kept deliberately in step with the Python port at
// mcp/booking-desk/booking.py, which fronts this rule over MCP. If the rule
// changes here it must change there too. One intentional difference: the
// Python side rejects a malformed key via its published JSON schema before
// the body runs, so it has no `invalid_idempotency_key` status; this module
// has no schema layer and therefore guards at runtime.
//
// Failure-first notes (required by CLAUDE.md):
//   1. What happens if this fails? Every path returns a typed `status`
//      rather than throwing. Nothing is logged as confirmed unless payment
//      succeeded.
//   2. Retry strategy? None here — every dependency is in-process. When the
//      real Supplier API and payment processor land, retry and circuit
//      breaking belong at those call sites, and retrying is safe precisely
//      because of the key below.
//   3. Recovery if exhausted? The caller retries with the SAME
//      idempotencyKey. A confirmed booking replays; a failed one re-runs.
//   4. Handled vs not handled. HANDLED: missing/malformed key, blank
//      customer, unavailable inventory, declined payment, exact replay, key
//      reuse with different arguments. NOT HANDLED: concurrent calls racing
//      on one key (single process, in-memory Maps — a real deployment needs
//      a unique constraint in Postgres), partial supplier failure, refunds.

const { logTransaction } = require("./crmTransactionLog");
const { processPayment } = require("./paymentService");

const AVAILABILITY = {
  flights: new Set(["FL-100"]),
  hotels: new Set(["HT-200"]),
  safaris: new Set(["SF-300"]),
};

const KEY_MIN_LENGTH = 8;
const KEY_MAX_LENGTH = 128;

// idempotencyKey -> the confirmed booking it produced.
const BOOKINGS_BY_KEY = new Map();
// idempotencyKey -> the request that produced it, so reusing a key for a
// different trip is caught instead of silently returning someone else's
// booking.
const FINGERPRINT_BY_KEY = new Map();

let nextTripId = 1;

function fingerprintOf({ customerId, flightId, hotelId, safariId }) {
  return JSON.stringify([customerId, flightId, hotelId, safariId]);
}

function isUsableKey(idempotencyKey) {
  return (
    typeof idempotencyKey === "string" &&
    idempotencyKey.trim().length >= KEY_MIN_LENGTH &&
    idempotencyKey.length <= KEY_MAX_LENGTH
  );
}

function bookTrip({ customerId, flightId, hotelId, safariId, idempotencyKey }) {
  if (!isUsableKey(idempotencyKey)) {
    return {
      status: "invalid_idempotency_key",
      message:
        "An idempotencyKey of " +
        KEY_MIN_LENGTH +
        "-" +
        KEY_MAX_LENGTH +
        " characters is required so a retry cannot double-book.",
      replayed: false,
    };
  }

  const fingerprint = fingerprintOf({ customerId, flightId, hotelId, safariId });

  // Checked FIRST, before any validation or side effect — the ordering the
  // blueprint's booking sequence diagram specifies.
  const existing = BOOKINGS_BY_KEY.get(idempotencyKey);
  if (existing) {
    if (FINGERPRINT_BY_KEY.get(idempotencyKey) !== fingerprint) {
      return {
        status: "idempotency_conflict",
        message:
          "This idempotencyKey was already used for a different booking. " +
          "Use a new key, or resend the original arguments.",
        replayed: false,
      };
    }
    // Exact replay: hand back the original booking. No second charge.
    return Object.assign({}, existing, { replayed: true });
  }

  if (typeof customerId !== "string" || customerId.trim() === "") {
    return {
      status: "invalid_customer",
      message: "Customer details are invalid.",
      replayed: false,
    };
  }

  const unavailable =
    !AVAILABILITY.flights.has(flightId) ||
    !AVAILABILITY.hotels.has(hotelId) ||
    !AVAILABILITY.safaris.has(safariId);

  if (unavailable) {
    return {
      status: "unavailable",
      message: "One or more selections are not available.",
      replayed: false,
    };
  }

  const payment = processPayment({ customerId });
  if (!payment.success) {
    // Deliberately NOT recorded against the key. A declined card is a
    // retryable condition — the agent fixes payment and retries with the
    // same key. Storing it would wedge that key permanently.
    return {
      status: "payment_failed",
      message: payment.message,
      replayed: false,
    };
  }

  const tripId = `TRIP-${nextTripId++}`;
  const booking = {
    tripId,
    customerId,
    status: "confirmed",
    legs: { flightId, hotelId, safariId },
  };

  BOOKINGS_BY_KEY.set(idempotencyKey, booking);
  FINGERPRINT_BY_KEY.set(idempotencyKey, fingerprint);
  logTransaction(booking);

  return Object.assign({}, booking, { replayed: false });
}

module.exports = { bookTrip, AVAILABILITY };
