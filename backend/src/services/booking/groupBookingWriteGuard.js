// STORY-008: the rule that no group booking exists without an audit entry.
//
// Split out of groupBookingService.js when that file came in at 599 lines,
// over CLAUDE.md's 500-line hard ceiling. The line the split follows is a real
// seam and not a line count - the same one quoteWriteGuard.js sits on next
// door, for the same reason. groupBookingService.js owns the LIFECYCLE of a
// group booking (what makes a group complete, what it costs, who is charged,
// what a replay means); this file owns the GUARANTEE that every confirmed
// group reaches the audit trail or does not happen at all.
//
// Worth separating because the two change for different reasons. New member
// fields, group rates and cancellation all land next door. The rule here
// should not move at all - and if it ever does, that change deserves to be
// reviewed on its own rather than buried in a diff about group pricing.
//
// THE GUARANTEE, IN ONE SENTENCE: after commitGroup returns ok, the group is
// stored AND audited; if it returns anything else, neither happened.
//
// WHY THAT NEEDS A ROLLBACK. The project guardrail is "the system must
// maintain audit logs for all transactions and changes". The obvious order -
// save, then audit - breaks it the moment auditing fails: a confirmed group
// trip with no record of who arranged it or who is on it, which is precisely
// the state an audit trail exists to make impossible. So a failed audit undoes
// the write. A group record is always new when it reaches here (the service's
// replay check runs first), so undoing it means deleting the row - there is no
// previous version to restore, which is the one way this differs from the
// quote guard.
//
// WHY THE WRITE IS READ BACK. "Booking confirmation failure" is one of this
// story's named failure paths, and the dangerous version is silent: the write
// returns, the organizer sees a confirmation for eight travellers, and the row
// is not there. A Map-shaped store backed by a file cannot be trusted to have
// persisted just because `set` returned. So we look.
//
// THE TWO AUDIT HELPERS ARE NOT SYMMETRICAL, ON PURPOSE.
//   commitGroup   - the audit entry is the thing being protected. If it fails,
//                   the write is undone and the caller is refused.
//   auditRefusal  - nothing was written, so there is nothing to protect. A
//                   failure is logged and the caller's outcome is unchanged.
// Turning an incomplete-group 400 into a 503 because the audit log hiccuped
// would be the worse trade: the refusal already left the system exactly as it
// was, and the organizer still needs to be told what is missing.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? commitGroup returns { ok: false, status,
//     message } and leaves no partial state. It never throws.
//  2. Will it retry? No. The only I/O is a local synchronous store write, and
//     an immediate retry of a failed local write generally fails again. The
//     caller retries safely instead, via the idempotency key next door.
//  3. Recovery path? A refused write needs no cleanup - that is the point of
//     the rollback. The one unrecoverable case (the rollback ITSELF fails) is
//     logged at error level with the groupId, because at that point only a
//     person can put it right.
//  4. Handled here: a store that throws on write, a store that accepts a write
//     and loses it, an audit that throws, and a rollback that throws. NOT
//     handled: another process writing the same row between our write and our
//     read-back (single-process store; the real fix is the database), and
//     crash-during-rollback, which leaves the unaudited row on disk.

const crypto = require("crypto");

const { deriveAuditKey } = require("../audit/auditLog");

const SERVICE_NAME = "group-booking";

const EVENTS = Object.freeze({
  CONFIRMED: "group_booking.confirmed",
  REFUSED: "group_booking.refused",
});

// Deliberately identical for both ways a save can fail. The caller is told the
// truth - no member was booked - without being told which internal component
// let us down, which is not their business and not actionable by them.
const NOT_CONFIRMED_MESSAGE =
  "The group booking could not be confirmed. No member was booked. Please try again.";

// Structured JSON to stderr, per CLAUDE.md's observability rules. Ids, counts
// and codes only - never a traveller's name.
function logGroupEvent(level, event, outcome, error, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: SERVICE_NAME,
      event: event,
      outcome: outcome,
      error_class: error ? error.errorClass || error.name || "Error" : undefined,
      context: context,
    })
  );
}

// The group's public identifier, derived from the idempotency key so it is
// stable across a restart and across a lost store row: a retry rebuilds the
// same id rather than minting a second group.
//
// A HASH RATHER THAN THE KEY ITSELF. The groupId is shown to people, written
// into the books and stored in the audit trail forever. The idempotency key is
// the caller's to choose, and callers put identifying things in keys - an email
// address, an internal reference. Hashing means none of that leaks into places
// it can never be removed from.
function groupIdFor(idempotencyKey) {
  return "group_" + crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
}

// Audits something that changed NO state - an incomplete group, a key
// conflict, an unavailable leg. Best effort; see the header on why this one is
// allowed to fail quietly and commitGroup is not.
function auditRefusal(audit, { idempotencyKey, reason, actor, context }) {
  const auditKey = deriveAuditKey(idempotencyKey, EVENTS.REFUSED + "." + reason);
  if (auditKey === "") {
    // No usable idempotency key means no key to dedup on. Recording under a
    // made-up key would put an entry in the trail that no later request could
    // ever match.
    return false;
  }
  try {
    audit({
      auditKey: auditKey,
      event: EVENTS.REFUSED,
      outcome: "failure",
      actor: typeof actor === "string" && actor.trim() !== "" ? actor : null,
      resource: groupIdFor(idempotencyKey),
      correlationId: idempotencyKey,
      // The reason and counts only. NEVER the submitted group: a rejected
      // booking carries travellers' names, and the audit trail persists to
      // disk forever. The `missing` list is not written either - it exists to
      // be shown to the organizer, not stored.
      context: Object.assign({ reason: reason }, context || {}),
    });
    return true;
  } catch (error) {
    // Swallowed deliberately, and deliberately not silent - the caller's
    // outcome does not change, but this does not vanish. Without the log line
    // this would be the empty catch CLAUDE.md forbids.
    logGroupEvent("warn", "group_booking.unaudited_refusal", "partial", error, {
      reason: reason,
      correlationId: idempotencyKey,
    });
    return false;
  }
}

// THE ONLY PATH THAT WRITES A GROUP BOOKING. Save, prove it saved, audit, and
// undo the write if the audit fails.
//
// Returns { ok: true } or { ok: false, status, message }. The service never
// writes to the store itself - a second write path would come with its own
// opinion about auditing, which is exactly the drift this centralises away.
function commitGroup(store, audit, { record, idempotencyKey, notConfirmedStatus }) {
  const failure = {
    ok: false,
    status: notConfirmedStatus,
    message: NOT_CONFIRMED_MESSAGE,
  };

  try {
    // Keyed BY the idempotency key, so the replay check next door survives a
    // restart - unlike bookTripService's in-memory BOOKINGS_BY_KEY, which is a
    // pre-existing limitation this module deliberately does not copy.
    store.set(idempotencyKey, record);
  } catch (error) {
    logGroupEvent("error", "group_booking.save_failed", "failure", error, {
      groupId: record.groupId,
    });
    return failure;
  }

  // The read-back. The groupId is compared as well as presence, so a store
  // that kept some OTHER row under this key is caught too - not just one that
  // kept nothing.
  const persisted = store.get(idempotencyKey);
  if (!persisted || persisted.groupId !== record.groupId) {
    logGroupEvent("error", "group_booking.save_not_durable", "failure", null, {
      groupId: record.groupId,
      memberCount: record.members.length,
    });
    return failure;
  }

  try {
    audit({
      auditKey: deriveAuditKey(record.groupId, EVENTS.CONFIRMED),
      event: EVENTS.CONFIRMED,
      outcome: "success",
      actor: record.organizerId,
      resource: record.groupId,
      correlationId: idempotencyKey,
      // Ids, counts and figures. The members are recorded as a count and their
      // IDS, never their names: the trail answers "who was on this booking" by
      // reference rather than holding a passenger manifest forever.
      context: {
        organizerId: record.organizerId,
        memberCount: record.members.length,
        memberIds: record.members.map(function (member) {
          return member.memberId;
        }),
        itinerary: record.itinerary,
        perPersonCents: record.perPersonCents,
        totalCents: record.totalCents,
        currency: record.currency,
      },
    });
  } catch (error) {
    // COMPENSATING ACTION. The group is stored but unaudited, the one state
    // this module refuses to leave behind. The record is new by construction,
    // so undoing it means deleting the row.
    try {
      store.delete(idempotencyKey);
      logGroupEvent("warn", "group_booking.rolled_back_unaudited", "success", error, {
        groupId: record.groupId,
      });
    } catch (rollbackError) {
      // An unaudited group we could not remove. Nothing further can be done in
      // process, so say it as loudly as the log allows: this one needs a person.
      logGroupEvent("error", "group_booking.rollback_failed", "failure", rollbackError, {
        groupId: record.groupId,
      });
    }
    return failure;
  }

  return { ok: true };
}

module.exports = {
  commitGroup,
  auditRefusal,
  logGroupEvent,
  groupIdFor,
  EVENTS,
  NOT_CONFIRMED_MESSAGE,
};
