// STORY-018: the operations booking dashboard. Every booking in the system in
// one list, with the status operations currently hold it at, and the one
// operation that changes that status.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR. It owns the JOIN - the CRM transaction
// ledger says what bookings exist, bookingStatusStore says what operations have
// set them to, and a dashboard row is one of each. It also owns the use case
// that changes a status, because changing one requires reading the current one,
// and a caller that had to read it first could read a different one than the
// rule was checked against.
//
// WHAT IT IS NOT RESPONSIBLE FOR. It does not decide which changes are legal
// (bookingStatusLifecycle.js), does not write (bookingStatusStore.js), and does
// not decide who may call it - routes declare a permission and server.js
// enforces it, which is why there is no role check anywhere in this file.
//
// WHERE "ALL BOOKINGS" COMES FROM, AND WHY IT IS THE RIGHT SOURCE. The CRM
// transaction log is the only durable store every booking path writes to:
// bookTripService.js logs one row per trip, groupBookingService.js logs one row
// per group MEMBER carrying a groupId. So one ledger row is one person's trip,
// which is the granularity an operations manager works at - a group of eight is
// eight things to arrange, not one.
//
// This matters more than it looks: bookTripService keeps its confirmed single
// bookings in an in-memory Map that does not survive a restart, and the ledger
// row is their only durable trace. Reading the ledger is therefore not merely
// convenient, it is the only source that is still correct tomorrow.
//
// NO SYNC STEP EXISTS, ON PURPOSE. The list is assembled per call from the
// ledger as it is now. There is no projection to rebuild, no cache to warm and
// no job to have failed overnight, which is what makes the story's "dashboard
// fails to display new bookings" failure path structurally hard rather than
// merely tested: a booking appears here the instant its ledger row exists,
// because this reads that row. See opsBookingBoard.test.js, which books a trip
// and finds it on the board with no step in between.
//
// A BOOKING WITH NO OVERLAY ROW IS confirmed. Absence in the status store means
// operations have never touched it, so its status is the one the booking path
// wrote. This module owns that default, which is why bookings do not have to be
// registered anywhere to show up.
//
// WHY A ROW REPORTS ITS OWN LEGAL NEXT MOVES. allowedNextStatuses travels with
// each row so a dashboard can offer the two buttons that will work rather than
// let an operator discover by refusal which ones will not. The rules stay in
// one place; this just carries their answer outward.
//
// COST, AND WHY IT IS ACCEPTABLE TODAY. listBookings is O(ledger rows) plus a
// store lookup each, materialised in memory. At this system's volume - a
// travel agency's bookings, in a JSON file store - that is the simplest thing
// that is correct, and STORY-016's load governor already caps concurrent work
// at the HTTP boundary. The day this is a real database, the join becomes a
// LEFT JOIN and a page of SQL; the row shape below is what it must return, and
// nothing above this module changes. Paging is deliberately NOT built ahead of
// that: a limit parameter designed against a Map tends to be the wrong one.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Reads return what they can: a booking whose
//     stored status is unreadable is listed with that status shown as-is and no
//     legal next moves, rather than hidden or silently defaulted - see
//     statusIsManaged. updateBookingStatus returns { ok: false, reason,
//     problems } and changes nothing. Neither throws.
//  2. Will it retry? No. The only I/O is synchronous local store reads and one
//     write, and the write's own header explains why retrying it in process is
//     not useful. A client retry is safe: a repeat of a change that already
//     landed is classified NO_CHANGE and writes nothing.
//  3. Recovery path if retries are exhausted? The booking is untouched and its
//     real status is still readable, so the dashboard never shows a status that
//     was not saved. The operator is told the change did not land and can try
//     again; nothing needs unwinding, because a refused write wrote nothing.
//  4. Failure modes handled vs not handled? HANDLED: a booking that does not
//     exist, a malformed tripId or correlation id, an illegal or impossible
//     transition, a replayed request, a ledger row whose status is outside the
//     vocabulary, a ledger row too malformed to describe, and every store and
//     audit failure the write path can produce. NOT HANDLED: two operations
//     managers changing the same booking at the same instant - the store is
//     single-process and last-write-wins, and the honest fix is a database row
//     lock rather than a check here that would still race - and a ledger that
//     is itself wrong about what was booked, which is the booking path's
//     contract to keep, not this module's.

const { getLoggedTransactions } = require("./crmTransactionLog");
const {
  INITIAL_STATUS,
  isKnownStatus,
  allowedNextStatuses,
  classifyTransition,
  TRANSITION_KINDS,
} = require("./bookingStatusLifecycle");
const {
  readStatusRecord,
  writeStatusChange,
  auditRefusedChange,
} = require("./bookingStatusStore");

// Why this module refused, over and above the lifecycle's own reasons. Stable
// strings: the route maps them onto HTTP status codes and tests assert on them.
const BOARD_REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  UNKNOWN_BOOKING: "unknown_booking",
});

// Same bounds as every other key in this repo (auditLog, bookTripService,
// groupBookingService all use 8-128). Repeated rather than imported because
// each of those modules declares its own too; centralising them is a worthwhile
// cleanup, and doing it inside this story would edit four files that STORY-018
// has no business touching.
const MIN_CORRELATION_ID_LENGTH = 8;
const MAX_CORRELATION_ID_LENGTH = 128;

function refuse(reason, problems) {
  return { ok: false, reason: reason, problems: problems };
}

function isUsableTripId(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isUsableCorrelationId(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= MIN_CORRELATION_ID_LENGTH &&
    value.length <= MAX_CORRELATION_ID_LENGTH
  );
}

// The effective status of a booking: what operations set it to, or - if they
// never have - what the booking path wrote when it was made.
//
// The ledger's own status is preferred over the hardcoded default so that if a
// booking path ever writes something other than "confirmed", the board reports
// what is actually recorded rather than what this file assumed.
function effectiveStatus(ledgerRow, overlay) {
  if (overlay) {
    return overlay.status;
  }
  if (typeof ledgerRow.status === "string" && ledgerRow.status !== "") {
    return ledgerRow.status;
  }
  return INITIAL_STATUS;
}

// One dashboard row: the booking as the ledger has it, plus the status as
// operations hold it.
//
// The booking's own fields are passed through rather than reshaped, because the
// ledger is the authority on them and a second opinion here would be a copy
// that can disagree. The status fields are the only thing this module adds.
function toBoardRow(ledgerRow, overlay) {
  const status = effectiveStatus(ledgerRow, overlay);
  return Object.freeze({
    tripId: ledgerRow.tripId,
    customerId: ledgerRow.customerId || null,
    // Present only on a booking made as part of a group, and the field a
    // dashboard groups eight members' rows by.
    groupId: ledgerRow.groupId || null,
    status: status,
    // FALSE means the stored status is outside the vocabulary this system
    // manages - a corruption, or a row written by a future version. The row is
    // still listed, showing the status it really has, because hiding a booking
    // is a worse answer than showing one nobody can currently advance. A
    // dashboard can read this to grey the row's controls out.
    statusIsManaged: isKnownStatus(status),
    allowedNextStatuses: allowedNextStatuses(status),
    amountCents: typeof ledgerRow.amountCents === "number" ? ledgerRow.amountCents : null,
    currency: ledgerRow.currency || null,
    bookedAt: ledgerRow.bookedAt || null,
    legs: ledgerRow.legs || null,
    // Null on a booking operations have never touched, which is the honest
    // answer: nobody has changed it, so nobody changed it at a time.
    statusChangedAt: overlay ? overlay.changedAt : null,
    statusChangedBy: overlay ? overlay.changedBy : null,
    previousStatus: overlay ? overlay.previousStatus : null,
    // 0 means "never changed by operations", so a client can tell an untouched
    // booking from one changed back and forth without comparing timestamps.
    statusVersion: overlay ? overlay.version : 0,
    statusFirstChangedAt: overlay ? overlay.firstChangedAt : null,
  });
}

// A ledger row with no usable tripId cannot be keyed, shown or acted on. Such a
// row should not exist - logTransaction keys on tripId - but the board reads a
// store it does not own, and skipping one unusable row is better than throwing
// away the whole dashboard over it. Counted and reported by listBookings rather
// than dropped silently, so the gap is visible instead of inferred.
function isListableLedgerRow(row) {
  return row !== null && typeof row === "object" && isUsableTripId(row.tripId);
}

// Newest booking first, which is what an operations manager wants on opening
// the board. Ties break on tripId so the order is total and a test can assert
// on it - two bookings made in the same millisecond must not swap places
// between calls. Rows with no bookedAt sort last rather than first, because an
// absent date is not evidence of being recent.
function byNewestBookingFirst(left, right) {
  const leftAt = left.bookedAt || "";
  const rightAt = right.bookedAt || "";
  if (leftAt !== rightAt) {
    if (leftAt === "") {
      return 1;
    }
    if (rightAt === "") {
      return -1;
    }
    return leftAt < rightAt ? 1 : -1;
  }
  return left.tripId < right.tripId ? -1 : left.tripId > right.tripId ? 1 : 0;
}

// THE DASHBOARD. Every booking, newest first, each with its current status.
//
// Filters are exact-match and optional. An unrecognised status filter matches
// nothing and returns an empty list, which is true - no booking has that status
// - and the route rejects it with a 400 before it gets here, so an operator
// never has to tell an empty result from a typo.
//
// Returns a summary alongside the rows rather than a bare array: a dashboard
// header needs the counts, and counting four statuses in the client means
// every client does it slightly differently.
function listBookings(
  { status, groupId } = {},
  { ledger = getLoggedTransactions, readOverlay = readStatusRecord } = {}
) {
  const allRows = ledger();
  const listable = allRows.filter(isListableLedgerRow);

  const rows = listable
    .map(function (ledgerRow) {
      return toBoardRow(ledgerRow, readOverlay(ledgerRow.tripId));
    })
    .filter(function (row) {
      if (status !== undefined && row.status !== status) {
        return false;
      }
      if (groupId !== undefined && row.groupId !== groupId) {
        return false;
      }
      return true;
    })
    .sort(byNewestBookingFirst);

  // Counted over every listable booking, not over the filtered rows - a header
  // that said "0 cancelled" because you are currently filtered to confirmed
  // would be worse than no header at all.
  const countsByStatus = {};
  listable.forEach(function (ledgerRow) {
    const rowStatus = effectiveStatus(ledgerRow, readOverlay(ledgerRow.tripId));
    countsByStatus[rowStatus] = (countsByStatus[rowStatus] || 0) + 1;
  });

  return Object.freeze({
    bookings: rows,
    total: listable.length,
    shown: rows.length,
    countsByStatus: Object.freeze(countsByStatus),
    // Non-zero means the ledger holds rows too malformed to show. Surfaced so a
    // missing booking can be explained rather than hunted for.
    unlistable: allRows.length - listable.length,
  });
}

// One booking, or null when the ledger has no row for that trip. Null is "no
// such booking", which the route turns into a 404.
function getBooking(
  tripId,
  { ledger = getLoggedTransactions, readOverlay = readStatusRecord } = {}
) {
  if (!isUsableTripId(tripId)) {
    return null;
  }
  const ledgerRow = ledger().find(function (row) {
    return isListableLedgerRow(row) && row.tripId === tripId;
  });
  if (!ledgerRow) {
    return null;
  }
  return toBoardRow(ledgerRow, readOverlay(tripId));
}

// THE ONE OPERATION THAT CHANGES A STATUS.
//
// The order of these steps is the contract. Read the booking, then ask the
// lifecycle, then write - and read the booking HERE rather than taking the
// caller's word for its current status, because a caller that read it a moment
// ago may have read a different value than the rule is about to be checked
// against.
function updateBookingStatus(
  { tripId, targetStatus, actor, correlationId },
  {
    ledger = getLoggedTransactions,
    readOverlay = readStatusRecord,
    write = writeStatusChange,
    auditRefusal = auditRefusedChange,
    storeOptions = undefined,
  } = {}
) {
  // Envelope first. These two are refused WITHOUT an audit entry, deliberately:
  // auditNoChange keys its entry on the correlation id, so a request with an
  // unusable one has nothing to key on, and a made-up key would put an entry in
  // the trail that no later request could ever match. packageStore.js refuses
  // the same way for the same reason.
  const problems = [];
  if (!isUsableTripId(tripId)) {
    problems.push("tripId is required and must be a non-empty string");
  }
  if (!isUsableCorrelationId(correlationId)) {
    problems.push(
      "correlationId is required and must be " +
        MIN_CORRELATION_ID_LENGTH +
        "-" +
        MAX_CORRELATION_ID_LENGTH +
        " characters"
    );
  }
  if (problems.length > 0) {
    return refuse(BOARD_REASONS.INVALID_REQUEST, problems);
  }

  const booking = getBooking(tripId, { ledger: ledger, readOverlay: readOverlay });
  if (!booking) {
    // Audited: an attempt to change a booking that does not exist is worth a
    // line in the trail, whether it is a stale dashboard or someone probing
    // trip ids.
    auditRefusal({
      tripId: tripId,
      reason: BOARD_REASONS.UNKNOWN_BOOKING,
      actor: actor,
      correlationId: correlationId,
    });
    return refuse(BOARD_REASONS.UNKNOWN_BOOKING, [
      "No booking exists with that trip ID.",
    ]);
  }

  const transition = classifyTransition(booking.status, targetStatus);

  if (transition.kind === TRANSITION_KINDS.REFUSED) {
    auditRefusal({
      tripId: tripId,
      reason: transition.reason,
      actor: actor,
      correlationId: correlationId,
    });
    return refuse(transition.reason, [transition.message]);
  }

  if (transition.kind === TRANSITION_KINDS.NO_CHANGE) {
    // IDEMPOTENCY. A retried or double-clicked request. Nothing is written and
    // nothing is audited - an audit entry here would claim a change that did
    // not happen, and two of them would claim it twice. The caller is told it
    // succeeded, because the booking is in the state they asked for, and
    // `changed: false` lets them tell that apart from having caused it.
    return { ok: true, booking: booking, changed: false, message: transition.message };
  }

  const written = write(
    {
      tripId: tripId,
      previousStatus: booking.status,
      targetStatus: targetStatus,
      actor: actor,
      correlationId: correlationId,
    },
    storeOptions
  );

  if (!written.ok) {
    // The store already rolled back anything it had written and logged why, so
    // there is nothing to undo here. Its reason is passed through unchanged -
    // not_saved and audit_unavailable mean different things to the route, and
    // flattening them into one would lose which it was.
    return refuse(written.reason, written.problems);
  }

  // Re-read rather than patching the row we already have. What is returned is
  // then what is stored, which is the same guarantee the write's own read-back
  // gives - and it means the response cannot show a status that is not on disk.
  const updated = getBooking(tripId, { ledger: ledger, readOverlay: readOverlay });
  return { ok: true, booking: updated, changed: true, message: transition.message };
}

module.exports = {
  listBookings,
  getBooking,
  updateBookingStatus,
  BOARD_REASONS,
};
