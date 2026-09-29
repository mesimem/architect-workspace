// STORY-008: booking a trip for a group, on one shared itinerary.
//
// REQ-010: "the system must handle group travel bookings with shared itinerary
// information." The shared itinerary is not a convention here, it is the data
// model: ONE itinerary lives on ONE group record and the members are a field
// on it. There is no per-member copy, so there is nothing to keep in step and
// no way for two travellers on the same group booking to end up on different
// flights.
//
// THAT IS ALSO WHAT MAKES ACCEPTANCE CRITERION 1 TRUE BY CONSTRUCTION.
// "Confirms the booking for all members" is not a loop that writes a row per
// traveller and hopes all of them land - a loop like that succeeds four times
// and fails the fifth, and now some of the group is flying and some is not.
// Instead the whole group is a SINGLE record with a single status, committed
// once. Either every member is confirmed or none is, because there is only one
// thing to confirm.
//
// WHY THE GROUP IS ONE PAYMENT, CHARGED TO THE ORGANIZER. A group organizer
// arranges and pays; that is what the role means in the story. Charging per
// member would mean N charges that can partially succeed, which is the same
// partial-confirmation problem wearing a different hat, and it would leave the
// agency deciding what to do about three paid travellers on a trip of five.
//
// BUT THE CRM RECORDS EACH MEMBER'S OWN SHARE, AND THAT DISTINCTION MATTERS
// MORE THAN IT LOOKS. crm/customerRecord.js sums `amountCents` across booking
// log rows into a lifetime value. Writing the GROUP total onto every member's
// row would multiply the group's revenue by its size across the CRM's book -
// a five-person safari would read as five full safaris sold. So:
//
//   booking log (per member) -> their share.  "what did this person travel on,
//                                              and what did it cost them"
//   accounting  (once)       -> the group total against the organizer. "what
//                                              money actually moved, and from whom"
//
// Two different questions, two different figures, neither of them wrong.
//
// IDEMPOTENCY. Keyed on a caller-supplied idempotencyKey, exactly as
// bookTripService.js is, and for a sharper reason: a retried group booking
// charges five fares rather than one. The store is keyed BY that key, so the
// replay check survives a restart - unlike bookTripService's in-memory
// BOOKINGS_BY_KEY, which is a pre-existing limitation this module deliberately
// does not copy. The groupId is derived from the key by hash, so even a retry
// that somehow found no stored row would rebuild the same id rather than mint
// a second group.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every path returns a typed `status` and
//     nothing throws. No member is ever confirmed unless the group record is
//     stored AND audited - see commitGroup below, which undoes the write if
//     the audit fails, the same rule quoteWriteGuard.js enforces for quotes.
//  2. Will it retry? Nothing here retries; every dependency is in-process.
//     The CALLER retries with the same idempotencyKey, which is safe by
//     construction. When a real supplier API lands, retry and circuit breaking
//     belong at that call site - see openclawCircuitBreaker.ts for the pattern.
//  3. Recovery if it fails anyway? Resubmit with the SAME key. A confirmed
//     group replays without a second charge; anything else re-runs from the
//     start, because nothing partial was left behind to clean up.
//  4. HANDLED: a missing or malformed key, a key reused for a different group,
//     an exact replay, incomplete group details (delegated to
//     groupValidation.js), an unavailable leg, a declined payment, a store that
//     accepts a write and loses it, an audit that fails, and a CRM or
//     accounting write that throws after the group is already paid for.
//     NOT HANDLED: two calls racing on one key (single process, same limit as
//     everywhere else in this repo - the real fix is a unique constraint in
//     Postgres), cancelling or amending a confirmed group, adding a member to
//     an existing group, refunds, per-member payment, and group rates - the
//     price is the single-trip price times the head count, because the backend
//     has no rate card to give a group a discount from.

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");
const { logTransaction } = require("./crmTransactionLog");
const { processPayment } = require("./paymentService");
const { recordTransaction } = require("../accounting/transactionRecorder");
const { routeOutcomeToAdvisor } = require("../advisor/advisorRouting");
// One itinerary is priced by ONE function, whether it carries one traveller or
// twenty - see the note on bookTripService's export list.
const { priceTrip, AVAILABILITY, CURRENCY } = require("./bookTripService");
const { validateGroupRequest, ITINERARY_LEGS } = require("./groupValidation");
// The write path and its audit guarantee. Nothing in this file writes to the
// store directly - see groupBookingWriteGuard.js for why there is one door.
const {
  commitGroup,
  auditRefusal,
  logGroupEvent,
  groupIdFor,
  EVENTS,
} = require("./groupBookingWriteGuard");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise - the bargain
// every store in this repo makes. See shared/jsonFileStore.js.
const GROUPS = createJsonFileStore("group-bookings");

// Same bounds as the booking idempotency key and the audit key, so one key can
// be passed through all three.
const KEY_MIN_LENGTH = 8;
const KEY_MAX_LENGTH = 128;

const STATUSES = Object.freeze({
  CONFIRMED: "confirmed",
  INCOMPLETE_GROUP: "incomplete_group",
  INVALID_IDEMPOTENCY_KEY: "invalid_idempotency_key",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  UNAVAILABLE: "unavailable",
  PAYMENT_FAILED: "payment_failed",
  NOT_CONFIRMED: "not_confirmed",
});

function isUsableKey(idempotencyKey) {
  return (
    typeof idempotencyKey === "string" &&
    idempotencyKey.trim().length >= KEY_MIN_LENGTH &&
    idempotencyKey.length <= KEY_MAX_LENGTH
  );
}

// What "the same request" means. Members are sorted, because a group of the
// same people submitted in a different order is the same group - treating it
// as a conflict would reject a legitimate retry from a client that does not
// preserve list order.
function fingerprintOf(group) {
  return JSON.stringify([
    group.organizerId,
    ITINERARY_LEGS.map(function (leg) {
      return group.itinerary[leg];
    }),
    group.members
      .map(function (member) {
        return member.memberId;
      })
      .sort(),
  ]);
}

// One booking-log row per member, at THEIR share - see the header on why the
// group total must not go on every row.
//
// Runs AFTER the group is confirmed and paid for, and a failure here never
// un-confirms it. That is the rule bookTripService.js already states at its
// recordTransactionSafely: bookkeeping must never turn a paid booking into a
// crash the customer sees. The gap is visible in the log rather than inferred
// from a missing row, and a retry with the same key rewrites these rows
// harmlessly because logTransaction is idempotent on tripId.
function logMemberTransactions(record) {
  let logged = 0;
  record.members.forEach(function (member) {
    try {
      logTransaction({
        // Deterministic, so a retry updates the same row rather than adding
        // one. Derived from the groupId, which is itself derived from the
        // idempotency key.
        tripId: member.tripId,
        customerId: member.memberId,
        status: record.status,
        legs: record.itinerary,
        amountCents: record.perPersonCents,
        currency: record.currency,
        bookedAt: record.bookedAt,
        // How a member's row points back at the group they travelled with.
        groupId: record.groupId,
      });
      logged += 1;
    } catch (error) {
      logGroupEvent("error", "group_booking.member_not_logged", "failure", error, {
        groupId: record.groupId,
        tripId: member.tripId,
      });
    }
  });
  return logged;
}

// The accounting post, for the group total, once. Wrapped for the same reason
// bookTripService wraps it: by the time this runs the organizer has been
// charged, and a bookkeeping exception must not surface to them as a failed
// booking they have already paid for.
async function recordGroupTransaction(record, idempotencyKey) {
  try {
    const result = await recordTransaction({
      auditKey: deriveAuditKey(record.groupId, "confirmed"),
      transaction: {
        // The groupId, not the idempotency key: the key is the caller's to
        // choose and this id ends up in the books.
        transactionId: record.groupId,
        customerId: record.organizerId,
        entryType: "sale",
        amountCents: record.totalCents,
        currency: record.currency,
        occurredAt: record.bookedAt,
        memo: "Group " + record.groupId + " (" + record.members.length + " travellers)",
      },
      completed: true,
      actor: record.organizerId,
      correlationId: idempotencyKey,
    });
    return { status: result.status, posted: Boolean(result.posted), reference: result.reference || null };
  } catch (error) {
    logGroupEvent("error", "group_booking.accounting_threw", "failure", error, {
      groupId: record.groupId,
    });
    return { status: "audit_failed", posted: false, reference: null };
  }
}

// The caller's view of a confirmed group. Built field by field rather than
// spread, so a future internal field on the stored record stays invisible
// until someone decides who may see it - the allow-list rule quoteView.js
// makes the case for.
function confirmedResponse(record, { replayed, accounting }) {
  return {
    status: STATUSES.CONFIRMED,
    groupId: record.groupId,
    groupName: record.groupName,
    organizerId: record.organizerId,
    itinerary: record.itinerary,
    // Every member, each carrying their own booking reference. This IS the
    // "confirms the booking for all members" criterion, answered in the
    // response rather than left for the caller to infer.
    members: record.members.map(function (member) {
      return {
        memberId: member.memberId,
        fullName: member.fullName,
        tripId: member.tripId,
        status: record.status,
      };
    }),
    memberCount: record.members.length,
    perPersonCents: record.perPersonCents,
    totalCents: record.totalCents,
    currency: record.currency,
    bookedAt: record.bookedAt,
    replayed: replayed,
    accounting: accounting,
  };
}

// Books a group. Returns a typed status; never throws.
//
// `store`, `audit` and `now` are injected with real defaults because the tests
// need a store that drops writes and an audit that fails, and there is no
// honest way to exercise "booking confirmation failure" without them.
async function bookGroupTrip(
  { organizerId, groupName, itinerary, members, idempotencyKey },
  { store = GROUPS, audit = recordAudit, now = null } = {}
) {
  if (!isUsableKey(idempotencyKey)) {
    // Not audited: with no usable key there is no key to record it under, and
    // an entry under a made-up key is one no later request could ever match.
    return {
      status: STATUSES.INVALID_IDEMPOTENCY_KEY,
      message:
        "An idempotencyKey of " +
        KEY_MIN_LENGTH +
        "-" +
        KEY_MAX_LENGTH +
        " characters is required so a retry cannot double-book the group.",
      replayed: false,
    };
  }

  // VALIDATION RUNS BEFORE THE REPLAY CHECK, unlike bookTripService, and the
  // difference is deliberate: the fingerprint is built from validated,
  // normalized values, so an untrimmed resubmission of the same group still
  // matches rather than reading as a conflict.
  const validation = validateGroupRequest({ organizerId, groupName, itinerary, members });
  if (!validation.ok) {
    auditRefusal(audit, {
      idempotencyKey: idempotencyKey,
      reason: STATUSES.INCOMPLETE_GROUP,
      actor: organizerId,
      context: { problemCount: validation.missing.length },
    });
    // CRITERION 2. The whole list, so the organizer fixes the form in one pass.
    return {
      status: STATUSES.INCOMPLETE_GROUP,
      message: "This group booking is missing information.",
      missing: validation.missing,
      replayed: false,
    };
  }
  const group = validation.group;
  const fingerprint = fingerprintOf(group);

  const existing = store.get(idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      auditRefusal(audit, {
        idempotencyKey: idempotencyKey,
        reason: STATUSES.IDEMPOTENCY_CONFLICT,
        actor: group.organizerId,
        context: { groupId: existing.groupId },
      });
      return {
        status: STATUSES.IDEMPOTENCY_CONFLICT,
        message:
          "This idempotencyKey was already used for a different group booking. " +
          "Use a new key, or resend the original group.",
        replayed: false,
      };
    }
    // Exact replay: the same group, already confirmed and already paid for.
    // Hand it back. No second charge, no second set of rows, no second
    // accounting entry - recordTransaction dedups on transactionId, so
    // re-attempting the post is safe and closes the gap where the first run
    // confirmed the group but could not reach the accounting API.
    const replayAccounting = await recordGroupTransaction(existing, idempotencyKey);
    return confirmedResponse(existing, { replayed: true, accounting: replayAccounting });
  }

  const unavailable = ITINERARY_LEGS.some(function (leg) {
    const inventory =
      leg === "flightId"
        ? AVAILABILITY.flights
        : leg === "hotelId"
          ? AVAILABILITY.hotels
          : AVAILABILITY.safaris;
    return !inventory.has(group.itinerary[leg]);
  });

  if (unavailable) {
    // Routed to a human, for the reason advisorRouting.js calls the strongest
    // case in the system: a known customer is actively trying to give us money
    // and an advisor can find the other lodge. Reusing the existing
    // "booking:unavailable" pairing rather than adding a group-specific one -
    // the advisor's job is identical, and the group size is in the context so
    // they know what they are rebooking.
    const advisor = await routeOutcomeToAdvisor({
      source: "booking",
      outcome: "unavailable",
      requestId: idempotencyKey,
      customerId: group.organizerId,
      context: Object.assign({ memberCount: group.members.length }, group.itinerary),
    });
    auditRefusal(audit, {
      idempotencyKey: idempotencyKey,
      reason: STATUSES.UNAVAILABLE,
      actor: group.organizerId,
      context: { memberCount: group.members.length },
    });
    return {
      status: STATUSES.UNAVAILABLE,
      message: "One or more selections are not available for this group.",
      replayed: false,
      advisor: advisor,
    };
  }

  const perPersonCents = priceTrip(group.itinerary);
  const totalCents = perPersonCents * group.members.length;

  // ONE charge, to the organizer, for the whole group - see the header.
  const payment = processPayment({
    customerId: group.organizerId,
    amountCents: totalCents,
    currency: CURRENCY,
  });
  if (!payment.success) {
    // Deliberately NOT stored against the key. A declined card is retryable -
    // the organizer fixes payment and resubmits with the same key - and
    // storing it would wedge that key permanently. Same reasoning as
    // bookTripService.
    //
    // Audited all the same: a failed transaction is still a transaction, and
    // the trust criterion says all group booking transactions are logged.
    // `completed: false` is what stops it reaching the accounting software.
    try {
      await recordTransaction({
        auditKey: deriveAuditKey(groupIdFor(idempotencyKey), "payment_failed"),
        transaction: {
          transactionId: groupIdFor(idempotencyKey),
          customerId: group.organizerId,
          entryType: "sale",
          amountCents: totalCents,
          currency: CURRENCY,
          occurredAt: new Date().toISOString(),
          memo: "Declined group booking attempt (" + group.members.length + " travellers)",
        },
        completed: false,
        reason: "payment_declined",
        actor: group.organizerId,
        correlationId: idempotencyKey,
      });
    } catch (error) {
      logGroupEvent("error", "group_booking.decline_not_recorded", "failure", error, {
        groupId: groupIdFor(idempotencyKey),
      });
    }
    return {
      status: STATUSES.PAYMENT_FAILED,
      message: payment.message,
      replayed: false,
    };
  }

  const groupId = groupIdFor(idempotencyKey);
  const bookedAt = typeof now === "function" ? now() : new Date().toISOString();

  const record = Object.freeze({
    groupId: groupId,
    groupName: group.groupName,
    organizerId: group.organizerId,
    status: "confirmed",
    // THE SHARED ITINERARY. One object, on the group, for everyone.
    itinerary: group.itinerary,
    members: Object.freeze(
      group.members.map(function (member, index) {
        return Object.freeze({
          memberId: member.memberId,
          fullName: member.fullName,
          // Deterministic per member, so a retry addresses the same booking
          // log row instead of creating a second one. Position-based because
          // the member list is frozen at this point and cannot be reordered.
          tripId: groupId + "-M" + (index + 1),
        });
      })
    ),
    perPersonCents: perPersonCents,
    // Taken from what the processor says it charged, not from what we asked
    // it to charge. If those ever disagree, the books follow the money.
    totalCents: payment.amountCents,
    currency: payment.currency,
    bookedAt: bookedAt,
    fingerprint: fingerprint,
  });

  // Store, read back, audit - or undo and refuse. Nothing below this line runs
  // unless the group is genuinely confirmed.
  const committed = commitGroup(store, audit, {
    record: record,
    idempotencyKey: idempotencyKey,
    // The guard reports the refusal; this module owns the vocabulary of
    // statuses, so the status it should report is passed in rather than
    // restated there. Two lists of statuses that must agree is one list that
    // will not.
    notConfirmedStatus: STATUSES.NOT_CONFIRMED,
  });
  if (!committed.ok) {
    return { status: committed.status, message: committed.message, replayed: false };
  }

  // Bookkeeping, after the fact. Neither of these can un-confirm the group.
  logMemberTransactions(record);
  const accounting = await recordGroupTransaction(record, idempotencyKey);

  return confirmedResponse(record, { replayed: false, accounting: accounting });
}

// Reads. Scoped by organizer, for the same reason every read in this repo is:
// a read that can return anyone's group is one forgotten argument away from
// returning everyone's.
function getGroupBooking({ groupId, organizerId }, { store = GROUPS } = {}) {
  if (typeof groupId !== "string" || groupId === "") {
    return null;
  }
  const found =
    Array.from(store.values()).find(function (record) {
      return record && record.groupId === groupId;
    }) || null;
  // A stranger's group is reported exactly as one that does not exist. The
  // difference between "not yours" and "no such thing" is what maps out the
  // book - see itineraryService.js.
  if (!found || (organizerId !== undefined && found.organizerId !== organizerId)) {
    return null;
  }
  return found;
}

// Tests only. Not reachable over HTTP - erasing the group book is not an
// operation this system offers.
function __resetGroupsForTests() {
  for (const key of Array.from(GROUPS.keys())) {
    GROUPS.delete(key);
  }
}

module.exports = {
  bookGroupTrip,
  getGroupBooking,
  __resetGroupsForTests,
  STATUSES,
  EVENTS,
};
