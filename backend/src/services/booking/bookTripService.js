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
// STORY-003: an unavailable selection is handed to a travel advisor, who can
// find the alternative the customer cannot. Declined payments and invalid
// customer details are deliberately NOT routed - see the inclusion test in
// advisorRouting.js.
const { routeOutcomeToAdvisor } = require("../advisor/advisorRouting");
// STORY-004: every completed booking is a financial transaction, and every
// attempted one is an audit fact. The recorder owns both - see
// ../accounting/transactionRecorder.js for why they are two stores.
const { recordTransaction } = require("../accounting/transactionRecorder");
const { deriveAuditKey } = require("../audit/auditLog");

// STORY-004: Maps rather than Sets, because a leg now carries a price. `.has()`
// works identically on both, so every availability check below is unchanged -
// this is additive, not a reshape. Availability and pricing being one structure
// here is a convenience of the stand-in; in a real agency they are separate
// systems (inventory vs. rate card) and will separate again when either becomes
// real.
const AVAILABILITY = {
  flights: new Map([["FL-100", { priceCents: 128000 }]]),
  hotels: new Map([["HT-200", { priceCents: 76000 }]]),
  safaris: new Map([["SF-300", { priceCents: 245000 }]]),
};

// Single-currency on purpose. The platform is U.S.-based and nothing in r0
// prices in anything else; multi-currency means FX rates, rounding rules and a
// reporting currency, which is a story of its own, not a constant.
const CURRENCY = "USD";

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

// The trip price is the sum of its legs. Only ever called after the
// availability check above has passed, so every leg is present; the `|| 0`
// guards a leg that is listed as available but unpriced, which would otherwise
// make the total NaN and be rejected further down as an invalid amount rather
// than charging something nonsensical.
function priceTrip({ flightId, hotelId, safariId }) {
  const leg = function (inventory, id) {
    const row = inventory.get(id);
    return row && Number.isSafeInteger(row.priceCents) ? row.priceCents : 0;
  };
  return (
    leg(AVAILABILITY.flights, flightId) +
    leg(AVAILABILITY.hotels, hotelId) +
    leg(AVAILABILITY.safaris, safariId)
  );
}

// STORY-004: bookkeeping must never un-confirm a booking.
//
// By the time this runs the customer's payment has gone through. recordTransaction
// is written not to throw, but "written not to throw" is not the same as "cannot
// throw", and the cost of being wrong here is a confirmed, paid booking that
// surfaces to the customer as a crash. So the exception is caught, classified and
// logged - never swallowed - and the booking stands. The audit gap is visible in
// the log rather than inferred from a missing entry.
async function recordTransactionSafely(args) {
  try {
    return await recordTransaction(args);
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        service: "booking",
        event: "transaction_recording_threw",
        outcome: "failure",
        error_class: error && error.errorClass ? error.errorClass : "UnknownError",
        context: { auditKey: args.auditKey },
      })
    );
    return { status: "audit_failed", audited: false, posted: false, accounting: null };
  }
}

// The accounting-shaped view of a booking. `transactionId` is the booking's own
// idempotency key: it is already unique per booking attempt and already bounded
// to the length the accounting boundary accepts, so inventing a second
// identifier would only create something else to keep in step.
function transactionFor(booking, idempotencyKey) {
  return {
    transactionId: idempotencyKey,
    customerId: booking.customerId,
    entryType: "sale",
    amountCents: booking.amountCents,
    currency: booking.currency,
    occurredAt: booking.bookedAt,
    memo: "Trip " + booking.tripId,
  };
}

// Callers get the outcome, not the recorder's internals - a booking response is
// not the place to leak the shape of our bookkeeping.
function accountingSummary(result) {
  return {
    status: result.status,
    posted: Boolean(result.posted),
    reference: result.reference || null,
  };
}

function isUsableKey(idempotencyKey) {
  return (
    typeof idempotencyKey === "string" &&
    idempotencyKey.trim().length >= KEY_MIN_LENGTH &&
    idempotencyKey.length <= KEY_MAX_LENGTH
  );
}

// ASYNC as of STORY-003: an unavailable selection is now handed to a travel
// advisor, and notifying one is an external call. Everything before that point
// is still synchronous logic; the await is only on the routing hop.
async function bookTrip({ customerId, flightId, hotelId, safariId, idempotencyKey }) {
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
    //
    // STORY-004: the accounting post IS re-attempted here, deliberately. If the
    // first run confirmed the booking but could not reach the accounting API,
    // the books are missing an entry and a replay is the natural moment to fix
    // that. It cannot double-post - the recorder dedups on transactionId - so
    // the cost of a replay that already posted is one map lookup.
    const replayAccounting = await recordTransactionSafely({
      auditKey: deriveAuditKey(idempotencyKey, "confirmed"),
      transaction: transactionFor(existing, idempotencyKey),
      completed: true,
      actor: existing.customerId,
      correlationId: idempotencyKey,
    });
    return Object.assign({}, existing, {
      replayed: true,
      accounting: accountingSummary(replayAccounting),
    });
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
    // STORY-003: this is the one booking outcome a human can actually change -
    // a full-service agency finds the other lodge when the first is full. The
    // review is keyed on the idempotencyKey, so a retried booking attempt
    // produces one advisor task, not one per retry.
    const advisor = await routeOutcomeToAdvisor({
      source: "booking",
      outcome: "unavailable",
      requestId: idempotencyKey,
      customerId: customerId,
      context: { flightId: flightId, hotelId: hotelId, safariId: safariId },
    });
    return {
      status: "unavailable",
      message: "One or more selections are not available.",
      replayed: false,
      advisor: advisor,
    };
  }

  const amountCents = priceTrip({ flightId, hotelId, safariId });
  const payment = processPayment({ customerId, amountCents, currency: CURRENCY });
  if (!payment.success) {
    // Deliberately NOT recorded against the key. A declined card is a
    // retryable condition — the agent fixes payment and retries with the
    // same key. Storing it would wedge that key permanently.
    //
    // STORY-004, ACCEPTANCE CRITERION 2: this is a failed transaction, so it
    // must NOT reach the accounting software - and criterion 3 says it must
    // still be audited. `completed: false` is exactly that instruction: the
    // recorder writes the audit entry and never calls the accounting API.
    //
    // The audit key carries the outcome because the audit log is
    // first-write-wins and this key can legitimately be reused: the declined
    // attempt and the later successful retry are two different facts, and
    // keying both on the bare booking key would record only the decline.
    const declined = await recordTransactionSafely({
      auditKey: deriveAuditKey(idempotencyKey, "payment_failed"),
      transaction: {
        transactionId: idempotencyKey,
        customerId: customerId,
        entryType: "sale",
        amountCents: amountCents,
        currency: CURRENCY,
        occurredAt: new Date().toISOString(),
        memo: "Declined booking attempt",
      },
      completed: false,
      reason: "payment_declined",
      actor: customerId,
      correlationId: idempotencyKey,
    });
    return {
      status: "payment_failed",
      message: payment.message,
      replayed: false,
      accounting: accountingSummary(declined),
    };
  }

  const tripId = `TRIP-${nextTripId++}`;
  const booking = {
    tripId,
    customerId,
    status: "confirmed",
    legs: { flightId, hotelId, safariId },
    // Taken from what the processor says it charged, not from what we asked it
    // to charge. If those ever disagree, the books should follow the money.
    amountCents: payment.amountCents,
    currency: payment.currency,
    bookedAt: new Date().toISOString(),
  };

  BOOKINGS_BY_KEY.set(idempotencyKey, booking);
  FINGERPRINT_BY_KEY.set(idempotencyKey, fingerprint);
  logTransaction(booking);

  // STORY-004, ACCEPTANCE CRITERIA 1 AND 3. Last, after the booking is durable:
  // a bookkeeping failure must leave a confirmed booking confirmed, and the
  // recorder writes its audit entry before it calls the accounting API, so the
  // attempt is on record even if that call never lands.
  const recorded = await recordTransactionSafely({
    auditKey: deriveAuditKey(idempotencyKey, "confirmed"),
    transaction: transactionFor(booking, idempotencyKey),
    completed: true,
    actor: customerId,
    correlationId: idempotencyKey,
  });

  return Object.assign({}, booking, {
    replayed: false,
    accounting: accountingSummary(recorded),
  });
}

module.exports = { bookTrip, AVAILABILITY, CURRENCY };
