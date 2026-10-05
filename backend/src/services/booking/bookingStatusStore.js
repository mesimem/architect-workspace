// STORY-018: where an operations manager's status changes are written down,
// and the guarantee that none of them is written without an audit entry.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It persists "what
// operations last set this booking to, and who set it". It does NOT decide
// whether a change is legal (bookingStatusLifecycle.js), does NOT know what
// bookings exist (opsBookingBoard.js reads the ledger for that), and does NOT
// decide who may change one (the central permission gate). It is the write
// door, and it is deliberately too ignorant to be the rule book.
//
// WHY THIS IS AN OVERLAY AND NOT THE BOOKING RECORD ITSELF. This is the central
// design decision of the story, so it is written here where the write happens.
//
// Every booking in this system already lands durably in ONE place: the CRM
// transaction log (crmTransactionLog.js, store "crm-transactions"), one row per
// trip, keyed on tripId. A single booking writes a row (bookTripService.js); a
// group booking writes one row per member, each carrying a groupId back at the
// group (groupBookingService.js). That log is therefore already the centralised
// book of bookings REQ-012 asks for - it did not need building, it needed
// reading.
//
// What it could NOT do is carry an operations-managed status, for a reason that
// is a feature of it rather than a flaw: logTransaction is idempotent by
// returning the EXISTING row untouched when the tripId is already present. It
// cannot be updated through its own front door, by design, because it is a
// ledger - and a ledger that rewrites its rows is not a ledger. So the status
// lives beside it, keyed on the same tripId, and the dashboard joins the two.
//
// THE ALTERNATIVE, AND WHY IT WAS REFUSED. The obvious shape is a bookings
// table of our own: copy every ledger row into it, add a status column, let the
// dashboard read one place. That buys a simpler query and costs the thing the
// story's second failure path is about. A copy has to be kept in step, which
// means a sync step, which means a sync step that can fail - and "dashboard
// fails to display new bookings" is then a real outage with a real cause rather
// than a hypothetical. An overlay cannot drift from the ledger because it never
// holds a second copy of what the ledger says: it holds a status and nothing
// else. packageStore.js's header makes the same argument about why a package
// stores product IDS and not product prices.
//
// WHAT IS IN A ROW HERE, AND WHAT IS NOT. A row holds the tripId, the status,
// the status it came from, a version, who changed it and when. It holds no
// customer name, no itinerary, no money. Those are the ledger's, and copying
// any of them here would reintroduce exactly the stale copy the overlay exists
// to avoid.
//
// A BOOKING WITH NO ROW HERE IS NOT MISSING - IT IS UNTOUCHED. Absence means
// "operations have never changed this one", and its status is therefore the one
// the booking path wrote: confirmed. This is why creating a booking does not
// have to write here at all, and why the dashboard shows a booking the instant
// the ledger has it. See opsBookingBoard.js, which owns that default.
//
// WHY EVERY CHANGE CARRIES A VERSION. auditedCommit.commit keys its audit entry
// on the id AND the version (`deriveAuditKey(id, event + ".v" + version)`),
// because the audit log is first-write-wins. Keyed on the tripId alone, the
// first status change would be recorded and every later one silently discarded
// - which would leave this module passing its own tests while quietly failing
// the story's trust criterion. The version is the mechanism by which "the
// system logs ALL booking status changes" is true rather than aspirational.
//
// The version also makes the read-back in commit meaningful: a store that
// accepted the write but kept the old row is caught, not just one that kept
// nothing.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? writeStatusChange returns
//     { ok: false, reason, problems } and leaves the stored status exactly as it
//     was - including when the audit write is the thing that failed, in which
//     case auditedCommit rolls the row back before refusing. It never throws.
//     The booking itself is never touched by any failure here: a status change
//     that does not land leaves a confirmed, paid booking confirmed and paid.
//  2. Will it retry? No. The only I/O is a synchronous local store write, and an
//     immediate retry of a failed local write generally fails the same way.
//     Callers retry instead, which is safe because a repeat of a change that
//     already landed is classified NO_CHANGE upstream and never reaches here -
//     see the idempotency note in bookingStatusLifecycle.js.
//  3. Recovery path if retries are exhausted? None is needed for the data: a
//     refused write changed nothing, which is the point of the rollback. The
//     operator is told the change did not land and the booking's real status is
//     still readable, so the dashboard never shows a status that was not saved.
//     The one unrecoverable case - the rollback itself failing - is logged at
//     error level by auditedCommit, because only a person can fix it.
//  4. Failure modes handled vs not handled? HANDLED: a store that throws on
//     write, a store that silently loses the write, a store that keeps the old
//     version, and an audit log that is unavailable or refuses the entry.
//     NOT HANDLED: another process writing the same tripId between our write and
//     our read-back - the store is single-process and the real fix is a
//     database with a transaction, as auditedCommit's own header says - and a
//     crash between the store write and the audit write, which leaves one
//     unaudited row on disk that the next change supersedes.

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { createAuditedCommit } = require("../shared/auditedCommit");
const { recordAudit } = require("../audit/auditLog");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise - the same switch
// every other store in this repo runs on. An operations dashboard that forgot
// every status change on restart would show yesterday's cancelled trips as
// confirmed, which is worse than showing nothing.
const STATUS_CHANGES = createJsonFileStore("booking-statuses");

// subject "booking" makes the log context field `bookingId` and the refusal
// messages speak about a booking; service "booking-status" tags the log lines.
// Both are fixed here once, at wiring time, so no call site can split this
// module's audit trail by passing a different noun - see auditedCommit's header.
const { commit, auditNoChange, REASONS } = createAuditedCommit({
  subject: "booking",
  service: "booking-status",
});

// The audit event name. One event for every status change, with the from/to in
// the context rather than in the event name. The alternative - an event per
// transition, "booking.status.cancelled" and friends - would mean a query for
// "every status change on this booking" had to know the full vocabulary, and
// would have to be rewritten the day a fifth status is added.
const STATUS_CHANGED_EVENT = "booking.status.changed";

// Its counterpart: a change that was asked for and refused. A separate event
// rather than the same one with outcome "failure", so that "every status change
// on this booking" and "every attempt that was turned down" are two queries
// instead of one query plus a filter everybody has to remember to apply.
const STATUS_CHANGE_REFUSED_EVENT = "booking.status.change_refused";

function nowIso() {
  return new Date().toISOString();
}

// Read the overlay row for one booking, or null when operations have never
// changed it. Null is a normal, expected answer - see the header.
//
// The store is injectable for the same reason it is everywhere else in this
// repo: so a test can prove the rollback and the read-back behaviour with a
// store that misbehaves on purpose, which the real one cannot be asked to do.
function readStatusRecord(tripId, { store = STATUS_CHANGES } = {}) {
  if (typeof tripId !== "string" || tripId.trim() === "") {
    // A malformed id is not an error here. It cannot match a row, and the
    // caller that accepted it is the one that owes the client a 400.
    return null;
  }
  return store.get(tripId) || null;
}

// Every overlay row, for the dashboard's list view. Returned as a plain array
// of the frozen records; the caller joins them onto the ledger.
function listStatusRecords({ store = STATUS_CHANGES } = {}) {
  return Array.from(store.values());
}

// THE ONLY PATH THAT WRITES. Save, prove it saved, audit, roll back if the
// audit fails - all of that is auditedCommit.commit; what this function owns is
// the record's shape and the version arithmetic.
//
// This function does NOT check that the transition is legal. That is checked
// before it is called, by the lifecycle, and the division is on purpose: a
// legality check in here would be a second opinion about the rules, sitting in
// the one place that cannot be tested without a store.
function writeStatusChange(
  { tripId, previousStatus, targetStatus, actor, correlationId },
  { store = STATUS_CHANGES, audit = recordAudit, now = nowIso } = {}
) {
  const existing = store.get(tripId) || null;

  // v1 is the first change operations ever made to this booking, not the
  // booking's creation - the booking path writes nothing here. So version 1
  // means "confirmed -> something", and the audit trail's v1 entry carries that
  // `from` value explicitly rather than leaving it to be inferred.
  const version = existing ? existing.version + 1 : 1;
  const changedAt = now();

  const record = Object.freeze({
    tripId: tripId,
    status: targetStatus,
    // What it moved FROM, stored rather than derived. The audit log is the
    // authority on the full history, but a dashboard row that can say "cancelled,
    // from in_progress" without a second query is worth one field.
    previousStatus: previousStatus,
    version: version,
    // When operations FIRST touched this booking, preserved across later
    // changes. Distinct from changedAt, which is always the latest change.
    firstChangedAt: existing ? existing.firstChangedAt : changedAt,
    changedAt: changedAt,
    changedBy: actor,
  });

  return commit(store, audit, {
    id: tripId,
    version: version,
    record: record,
    // The row to restore if the audit write fails, or null when this is the
    // first change and the correct rollback is to delete the row entirely.
    previous: existing,
    event: STATUS_CHANGED_EVENT,
    actor: actor,
    correlationId: correlationId,
    // Ids, the two statuses, and the version. No customer, no itinerary, no
    // money - partly because they are not this module's to know, and partly
    // because the audit trail persists to disk forever and should not accumulate
    // copies of customer data it does not need. The from/to pair is the whole
    // fact being recorded.
    context: {
      tripId: tripId,
      from: previousStatus,
      to: targetStatus,
      version: version,
    },
  });
}

// Records an ATTEMPTED status change that was refused, changing no state.
//
// WHY A REFUSAL IS WORTH AUDITING AT ALL. The story's trust criterion asks for
// every status CHANGE to be logged, and a refusal is not a change - so this is
// deliberately more than the criterion requires. An operations manager
// repeatedly trying to reopen completed bookings is a fact about a person, and
// those are exactly the facts an audit trail exists to hold. The permission
// gate already takes this view: server.js audits a denied request, which also
// changed nothing.
//
// BEST EFFORT, AND DELIBERATELY ASYMMETRICAL WITH writeStatusChange. If this
// audit write fails, the caller's outcome does not change - they are still
// refused, for the reason they were always going to be refused. Turning a 409
// into a 503 because the audit log hiccuped on a refusal would be the worse
// trade, because the refusal already left the system exactly as it was. See
// auditedCommit's header, which makes this argument in full; the failure is
// logged there rather than swallowed.
// The target status is deliberately NOT a parameter: auditNoChange fixes the
// entry's context to the reason alone, and a parameter this function accepted
// and then dropped would read like a recorded fact that is not actually in the
// trail.
function auditRefusedChange(
  { tripId, reason, actor, correlationId },
  { audit = recordAudit } = {}
) {
  return auditNoChange(audit, {
    event: STATUS_CHANGE_REFUSED_EVENT,
    outcome: "failure",
    reason: reason,
    actor: actor,
    correlationId: correlationId,
    // The booking, not the generic subject noun, so the trail can be read by
    // booking rather than only by actor.
    resource: typeof tripId === "string" && tripId !== "" ? tripId : undefined,
  });
}

// Test-only. Named for what it resets and matching the house convention
// (__resetGroupsForTests and friends), so a grep for __reset finds every store
// a suite has to clean up after itself.
function __resetBookingStatusesForTests() {
  Array.from(STATUS_CHANGES.keys()).forEach(function (key) {
    STATUS_CHANGES.delete(key);
  });
}

module.exports = {
  readStatusRecord,
  listStatusRecords,
  writeStatusChange,
  auditRefusedChange,
  STATUS_CHANGED_EVENT,
  STATUS_CHANGE_REFUSED_EVENT,
  REASONS,
  __resetBookingStatusesForTests,
};
