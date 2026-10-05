// STORY-018, the dashboard. This file carries the story's two "given/when/then"
// acceptance criteria and its second named failure path.
//
//   CRITERION 1 - a new booking is created, the manager views the dashboard,
//                 the booking is displayed with its current status.
//   CRITERION 2 - a status is updated, the manager saves, the dashboard
//                 reflects the updated status.
//   FAILURE     - "dashboard fails to display new bookings".
//
// CRITERION 1 IS TESTED AGAINST A REAL BOOKING, NOT A FIXTURE. The first
// section below calls bookTrip the way the application calls it and then asks
// the board what it can see. A fixture row dropped straight into the ledger
// would have proved the join works while proving nothing about whether the
// booking path and the dashboard agree on where bookings live - which is the
// one thing that would make the dashboard silently empty in production. That is
// also how the failure path is covered: there is no sync step between the two
// calls to fail, and this test is what says so.
//
// EVERYTHING AFTER THAT SECTION USES FAKE LEDGERS, on purpose. The join's edge
// cases - a corrupt status, a row with no trip id, two bookings in the same
// millisecond - cannot be produced by booking trips properly, and a test that
// can only assert on what the happy path happens to generate cannot cover them.
//
// The third failure path, "unauthorized access to booking management features",
// is a property of the HTTP boundary and is tested in http/opsBookings.test.js.
// Nothing in this file checks a role, because nothing in opsBookingBoard.js
// does - server.js owns that.

const assert = require("assert");

const { bookTrip } = require("./bookTripService");
const { listBookings, getBooking, updateBookingStatus, BOARD_REASONS } =
  require("./opsBookingBoard");
const { REASONS: STORE_REASONS, __resetBookingStatusesForTests } =
  require("./bookingStatusStore");
const { REFUSAL_REASONS } = require("./bookingStatusLifecycle");
const { findAuditEntry, getAuditEntries } = require("../audit/auditLog");

// A ledger that returns exactly the rows a test wants to talk about.
function fakeLedger(rows) {
  return function () {
    return rows;
  };
}

// An overlay reader backed by a plain object, plus a fake writer that updates
// it - so a test can prove the re-read after a successful write returns what
// was actually stored rather than a patched copy of the old row.
function fakeOverlay(initial) {
  const rows = Object.assign({}, initial || {});
  return {
    read: function (tripId) {
      return rows[tripId] || null;
    },
    write: function ({ tripId, previousStatus, targetStatus, actor }) {
      const existing = rows[tripId];
      const record = {
        tripId: tripId,
        status: targetStatus,
        previousStatus: previousStatus,
        version: existing ? existing.version + 1 : 1,
        changedAt: "2026-10-05T12:00:00.000Z",
        firstChangedAt: existing ? existing.firstChangedAt : "2026-10-05T12:00:00.000Z",
        changedBy: actor,
      };
      rows[tripId] = record;
      return { ok: true, record: record };
    },
  };
}

// Records whether a refusal was audited, and with what reason.
function spyAuditRefusal() {
  const calls = [];
  const spy = function (args) {
    calls.push(args);
    return true;
  };
  spy.calls = calls;
  return spy;
}

// A write that must never be reached. Any call is a test failure, which is how
// "nothing was written" is asserted rather than assumed.
function forbiddenWrite() {
  return function () {
    throw new Error("the store must not be written on this path");
  };
}

const LEDGER_ROW = Object.freeze({
  tripId: "TRIP-A",
  customerId: "CUST-1",
  status: "confirmed",
  legs: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
  amountCents: 449000,
  currency: "USD",
  bookedAt: "2026-09-01T10:00:00.000Z",
});

async function main() {
  // =====================================================================
  // CRITERION 1, against a real booking, and the "dashboard fails to
  // display new bookings" failure path.
  // =====================================================================

  // The board starts empty in a fresh process, so the row found below can only
  // have come from the booking made after this line.
  assert.strictEqual(listBookings().total, 0);
  console.log("opsBookingBoard: the board is empty before anything is booked");

  const booked = await bookTrip({
    customerId: "CUST-REAL-1",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "board-real-key-01",
  });
  assert.strictEqual(booked.status, "confirmed");

  // GIVEN a new booking is created, WHEN the manager views the dashboard, THEN
  // the system displays the booking with its current status. No registration
  // call, no projection rebuild, no sync job - the two lines above and below
  // are the whole path.
  const afterBooking = listBookings();
  assert.strictEqual(afterBooking.total, 1);
  assert.strictEqual(afterBooking.shown, 1);
  assert.strictEqual(afterBooking.unlistable, 0);

  const realRow = afterBooking.bookings[0];
  assert.strictEqual(realRow.tripId, booked.tripId);
  assert.strictEqual(realRow.customerId, "CUST-REAL-1");
  assert.strictEqual(realRow.status, "confirmed");
  assert.strictEqual(realRow.statusIsManaged, true);
  assert.strictEqual(realRow.amountCents, booked.amountCents);
  assert.strictEqual(realRow.currency, "USD");
  // Never touched by operations, so these are null and the version is 0 - the
  // honest answer, rather than a fabricated "changed at creation".
  assert.strictEqual(realRow.statusVersion, 0);
  assert.strictEqual(realRow.statusChangedAt, null);
  assert.strictEqual(realRow.statusChangedBy, null);
  assert.strictEqual(realRow.previousStatus, null);
  // The dashboard can offer the moves that will work.
  assert.deepStrictEqual(realRow.allowedNextStatuses, ["in_progress", "cancelled"]);
  assert.deepStrictEqual(afterBooking.countsByStatus, { confirmed: 1 });
  console.log("opsBookingBoard: CRITERION 1 - a newly booked trip appears with its current status");

  // =====================================================================
  // CRITERION 2 and the trust criterion, still on the real stores.
  // =====================================================================

  const auditEntriesBefore = getAuditEntries().length;

  const saved = updateBookingStatus({
    tripId: booked.tripId,
    targetStatus: "in_progress",
    actor: "OPS-REAL-1",
    correlationId: "board-real-corr-1",
  });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.changed, true);
  assert.strictEqual(saved.booking.status, "in_progress");

  // GIVEN a booking status is updated, WHEN the manager saves, THEN the
  // dashboard reflects the updated status. Asserted by asking the board again,
  // not by trusting the update's own return value.
  const afterUpdate = listBookings();
  assert.strictEqual(afterUpdate.bookings[0].status, "in_progress");
  assert.strictEqual(afterUpdate.bookings[0].previousStatus, "confirmed");
  assert.strictEqual(afterUpdate.bookings[0].statusChangedBy, "OPS-REAL-1");
  assert.strictEqual(afterUpdate.bookings[0].statusVersion, 1);
  assert.deepStrictEqual(afterUpdate.bookings[0].allowedNextStatuses, ["completed", "cancelled"]);
  // The header counts moved with it - a dashboard that showed the new status in
  // the row and the old one in its summary would be wrong in the more
  // misleading of the two places.
  assert.deepStrictEqual(afterUpdate.countsByStatus, { in_progress: 1 });
  console.log("opsBookingBoard: CRITERION 2 - a saved status change is reflected on the dashboard");

  // TRUST CRITERION: the change is in the audit trail, findable by the key the
  // store derives for it.
  const trailEntry = findAuditEntry(booked.tripId + ":booking.status.changed.v1");
  assert.ok(trailEntry, "the status change must be in the audit trail");
  assert.strictEqual(trailEntry.event, "booking.status.changed");
  assert.strictEqual(trailEntry.outcome, "success");
  assert.strictEqual(trailEntry.actor, "OPS-REAL-1");
  assert.strictEqual(trailEntry.resource, booked.tripId);
  assert.strictEqual(trailEntry.context.from, "confirmed");
  assert.strictEqual(trailEntry.context.to, "in_progress");
  assert.strictEqual(getAuditEntries().length, auditEntriesBefore + 1);
  console.log("opsBookingBoard: the status change is recorded in the audit trail");

  // IDEMPOTENCY, on the real stores. The same save again - a double-clicked
  // button, or a client retrying a request whose response it never saw.
  const replayed = updateBookingStatus({
    tripId: booked.tripId,
    targetStatus: "in_progress",
    actor: "OPS-REAL-1",
    correlationId: "board-real-corr-2",
  });
  assert.strictEqual(replayed.ok, true);
  // The caller is told it succeeded - the booking IS in_progress - but told
  // they did not cause it.
  assert.strictEqual(replayed.changed, false);
  // Nothing was written: still version 1, still the first actor.
  assert.strictEqual(listBookings().bookings[0].statusVersion, 1);
  // And nothing was audited. A second entry here would claim the status changed
  // twice, which is the exact false record the no-change branch exists to
  // prevent.
  assert.strictEqual(getAuditEntries().length, auditEntriesBefore + 1);
  assert.strictEqual(findAuditEntry(booked.tripId + ":booking.status.changed.v2"), null);
  console.log("opsBookingBoard: a replayed save changes nothing and audits nothing");

  // The real stores are process-wide. Done with them before the fake-ledger
  // sections, so a leftover overlay row cannot colour what follows.
  __resetBookingStatusesForTests();
  assert.strictEqual(listBookings().bookings[0].status, "confirmed");
  console.log("opsBookingBoard: clearing the overlay returns the booking to its ledger status");

  // =====================================================================
  // THE JOIN. Fake ledgers from here down.
  // =====================================================================

  const noOverlay = fakeOverlay({});

  // A booking with no overlay row shows the status the booking path wrote.
  // Absence means "operations never touched it", not "missing".
  const untouched = listBookings(
    {},
    { ledger: fakeLedger([LEDGER_ROW]), readOverlay: noOverlay.read }
  );
  assert.strictEqual(untouched.bookings[0].status, "confirmed");
  assert.strictEqual(untouched.bookings[0].statusVersion, 0);
  console.log("opsBookingBoard: a booking with no overlay row shows its ledger status");

  // The ledger's own status is used rather than a hardcoded default, so that if
  // a booking path ever writes something other than "confirmed", the board
  // reports what is recorded instead of what this module assumed.
  const oddLedgerStatus = listBookings(
    {},
    {
      ledger: fakeLedger([Object.assign({}, LEDGER_ROW, { status: "cancelled" })]),
      readOverlay: noOverlay.read,
    }
  );
  assert.strictEqual(oddLedgerStatus.bookings[0].status, "cancelled");
  assert.deepStrictEqual(oddLedgerStatus.bookings[0].allowedNextStatuses, []);
  console.log("opsBookingBoard: the ledger's own status is reported, not a hardcoded default");

  // The overlay wins when it exists. That is the whole point of it.
  const overlaid = fakeOverlay({
    "TRIP-A": {
      tripId: "TRIP-A",
      status: "completed",
      previousStatus: "in_progress",
      version: 3,
      changedAt: "2026-09-20T08:00:00.000Z",
      firstChangedAt: "2026-09-10T08:00:00.000Z",
      changedBy: "OPS-CARLA",
    },
  });
  const joined = getBooking("TRIP-A", {
    ledger: fakeLedger([LEDGER_ROW]),
    readOverlay: overlaid.read,
  });
  assert.strictEqual(joined.status, "completed");
  assert.strictEqual(joined.previousStatus, "in_progress");
  assert.strictEqual(joined.statusVersion, 3);
  assert.strictEqual(joined.statusChangedBy, "OPS-CARLA");
  assert.strictEqual(joined.statusFirstChangedAt, "2026-09-10T08:00:00.000Z");
  // The booking's own facts still come from the ledger, which is the authority
  // on them - the overlay holds no copy to disagree with.
  assert.strictEqual(joined.amountCents, 449000);
  assert.strictEqual(joined.customerId, "CUST-1");
  assert.deepStrictEqual(joined.allowedNextStatuses, []);
  console.log("opsBookingBoard: an operations status overrides the ledger's, and the rest is the ledger's");

  // Rows are frozen, so a caller cannot edit the board through what it returns.
  assert.ok(Object.isFrozen(joined));
  assert.ok(Object.isFrozen(untouched));
  console.log("opsBookingBoard: rows and the summary are frozen");

  // A GROUP member's booking carries the groupId it was booked under, which is
  // what lets a dashboard show eight members as one party. A group of eight is
  // eight things to arrange, so it is eight rows - not one.
  const groupRows = listBookings(
    {},
    {
      ledger: fakeLedger([
        Object.assign({}, LEDGER_ROW, { tripId: "TRIP-G1", groupId: "GRP-7" }),
        Object.assign({}, LEDGER_ROW, { tripId: "TRIP-G2", groupId: "GRP-7" }),
      ]),
      readOverlay: noOverlay.read,
    }
  );
  assert.strictEqual(groupRows.total, 2);
  assert.strictEqual(groupRows.bookings[0].groupId, "GRP-7");
  assert.strictEqual(groupRows.bookings[1].groupId, "GRP-7");
  // A single booking has no group, and says so with null rather than omitting
  // the field - a client should not have to tell "no group" from "key absent".
  assert.strictEqual(untouched.bookings[0].groupId, null);
  console.log("opsBookingBoard: group members carry their group, and single bookings say null");

  // =====================================================================
  // A STATUS THE SYSTEM DOES NOT MANAGE. Honest rather than hidden.
  // =====================================================================

  // A corrupt row, or one written by a future version. It is still LISTED,
  // showing the status it really has, with no legal next moves - hiding a
  // booking is a worse answer than showing one nobody can currently advance,
  // and statusIsManaged is how a dashboard knows to grey its controls out.
  const corrupt = listBookings(
    {},
    {
      ledger: fakeLedger([Object.assign({}, LEDGER_ROW, { status: "awaiting-visa-maybe" })]),
      readOverlay: noOverlay.read,
    }
  );
  assert.strictEqual(corrupt.total, 1);
  assert.strictEqual(corrupt.bookings[0].status, "awaiting-visa-maybe");
  assert.strictEqual(corrupt.bookings[0].statusIsManaged, false);
  assert.deepStrictEqual(corrupt.bookings[0].allowedNextStatuses, []);
  console.log("opsBookingBoard: an unmanaged status is shown as it is, with no legal moves");

  // =====================================================================
  // ORDER, COUNTS AND FILTERS.
  // =====================================================================

  const manyRows = [
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-OLD", bookedAt: "2026-01-01T00:00:00.000Z" }),
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-NEW", bookedAt: "2026-12-31T00:00:00.000Z" }),
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-MID", bookedAt: "2026-06-15T00:00:00.000Z" }),
  ];
  const ordered = listBookings({}, { ledger: fakeLedger(manyRows), readOverlay: noOverlay.read });
  assert.deepStrictEqual(
    ordered.bookings.map(function (row) {
      return row.tripId;
    }),
    ["TRIP-NEW", "TRIP-MID", "TRIP-OLD"]
  );
  console.log("opsBookingBoard: the newest booking is listed first");

  // Two bookings in the same millisecond must not swap places between calls, or
  // a dashboard's second page would be unstable. Ties break on tripId, making
  // the order total.
  const sameInstant = [
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-ZZ", bookedAt: "2026-06-15T00:00:00.000Z" }),
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-AA", bookedAt: "2026-06-15T00:00:00.000Z" }),
  ];
  assert.deepStrictEqual(
    listBookings({}, { ledger: fakeLedger(sameInstant), readOverlay: noOverlay.read }).bookings.map(
      function (row) {
        return row.tripId;
      }
    ),
    ["TRIP-AA", "TRIP-ZZ"]
  );
  console.log("opsBookingBoard: bookings made in the same millisecond have a stable order");

  // A row with no bookedAt sorts LAST, not first. An absent date is not
  // evidence of being recent, and sorting it to the top would put the least
  // trustworthy row where the operator looks first.
  const undated = [
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-UNDATED", bookedAt: undefined }),
    Object.assign({}, LEDGER_ROW, { tripId: "TRIP-DATED", bookedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  assert.deepStrictEqual(
    listBookings({}, { ledger: fakeLedger(undated), readOverlay: noOverlay.read }).bookings.map(
      function (row) {
        return row.tripId;
      }
    ),
    ["TRIP-DATED", "TRIP-UNDATED"]
  );
  console.log("opsBookingBoard: a booking with no date sorts last, not first");

  // A ledger row too malformed to key or act on is skipped - and COUNTED, so
  // the gap is visible rather than inferred from a booking somebody cannot
  // find. The rest of the board still renders.
  const withJunk = listBookings(
    {},
    {
      ledger: fakeLedger([LEDGER_ROW, null, {}, { tripId: "" }, { tripId: 42 }]),
      readOverlay: noOverlay.read,
    }
  );
  assert.strictEqual(withJunk.total, 1);
  assert.strictEqual(withJunk.unlistable, 4);
  assert.strictEqual(withJunk.bookings.length, 1);
  console.log("opsBookingBoard: unusable ledger rows are skipped and counted, not fatal");

  // Filters are exact-match. The counts stay whole-board on purpose: a header
  // reading "0 cancelled" because you are filtered to confirmed would be worse
  // than no header at all.
  const mixedOverlay = fakeOverlay({
    "TRIP-NEW": { tripId: "TRIP-NEW", status: "cancelled", previousStatus: "confirmed", version: 1, changedAt: "x", firstChangedAt: "x", changedBy: "OPS-1" },
  });
  const filtered = listBookings(
    { status: "confirmed" },
    { ledger: fakeLedger(manyRows), readOverlay: mixedOverlay.read }
  );
  assert.strictEqual(filtered.total, 3);
  assert.strictEqual(filtered.shown, 2);
  assert.deepStrictEqual(filtered.countsByStatus, { confirmed: 2, cancelled: 1 });
  assert.ok(
    filtered.bookings.every(function (row) {
      return row.status === "confirmed";
    })
  );
  console.log("opsBookingBoard: a status filter narrows the rows and leaves the counts whole-board");

  const byGroup = listBookings(
    { groupId: "GRP-7" },
    {
      ledger: fakeLedger([
        Object.assign({}, LEDGER_ROW, { tripId: "TRIP-G1", groupId: "GRP-7" }),
        Object.assign({}, LEDGER_ROW, { tripId: "TRIP-SOLO" }),
      ]),
      readOverlay: noOverlay.read,
    }
  );
  assert.strictEqual(byGroup.shown, 1);
  assert.strictEqual(byGroup.bookings[0].tripId, "TRIP-G1");
  console.log("opsBookingBoard: a group filter shows one party");

  // An unrecognised filter value matches nothing, which is true - no booking
  // has that status. The route rejects it with a 400 first, so an operator
  // never has to tell an empty result from a typo.
  assert.strictEqual(
    listBookings({ status: "in_progres" }, { ledger: fakeLedger(manyRows), readOverlay: noOverlay.read })
      .shown,
    0
  );
  console.log("opsBookingBoard: an unrecognised filter value matches nothing");

  // An empty ledger is an empty board, not a crash.
  const empty = listBookings({}, { ledger: fakeLedger([]), readOverlay: noOverlay.read });
  assert.deepStrictEqual(empty.bookings, []);
  assert.strictEqual(empty.total, 0);
  assert.deepStrictEqual(empty.countsByStatus, {});
  console.log("opsBookingBoard: an empty ledger is an empty board");

  // =====================================================================
  // getBooking: one booking, or an honest null.
  // =====================================================================

  assert.strictEqual(
    getBooking("TRIP-NOT-THERE", { ledger: fakeLedger([LEDGER_ROW]), readOverlay: noOverlay.read }),
    null
  );
  [undefined, null, "", "   ", 42, {}].forEach(function (bad) {
    assert.strictEqual(
      getBooking(bad, { ledger: fakeLedger([LEDGER_ROW]), readOverlay: noOverlay.read }),
      null
    );
  });
  console.log("opsBookingBoard: an unknown or malformed trip ID reads as null, never a throw");

  // =====================================================================
  // updateBookingStatus REFUSALS. Every one must write nothing.
  // =====================================================================

  // A malformed request. Refused WITHOUT an audit entry, deliberately: the
  // audit key is derived from the correlation id, so a request without a usable
  // one has nothing to key on, and an entry under a made-up key could never be
  // matched by a later request.
  const noAuditSpy = spyAuditRefusal();
  const badRequest = updateBookingStatus(
    { tripId: "", targetStatus: "in_progress", actor: "OPS-1", correlationId: "corr-valid-0001" },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: noOverlay.read,
      write: forbiddenWrite(),
      auditRefusal: noAuditSpy,
    }
  );
  assert.strictEqual(badRequest.ok, false);
  assert.strictEqual(badRequest.reason, BOARD_REASONS.INVALID_REQUEST);
  assert.strictEqual(noAuditSpy.calls.length, 0);
  console.log("opsBookingBoard: a malformed trip ID is refused unaudited, because there is no key for it");

  // The correlation id is mandatory, and bounded the way every other key in
  // this repo is. A request without one cannot be traced or deduplicated.
  ["", "short", undefined, null, 42, "x".repeat(129)].forEach(function (bad) {
    const refused = updateBookingStatus(
      { tripId: "TRIP-A", targetStatus: "in_progress", actor: "OPS-1", correlationId: bad },
      {
        ledger: fakeLedger([LEDGER_ROW]),
        readOverlay: noOverlay.read,
        write: forbiddenWrite(),
        auditRefusal: noAuditSpy,
      }
    );
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, BOARD_REASONS.INVALID_REQUEST);
  });
  assert.strictEqual(noAuditSpy.calls.length, 0);
  console.log("opsBookingBoard: a missing or out-of-bounds correlation ID is refused");

  // A booking that does not exist. This one IS audited - a stale dashboard or
  // somebody probing trip ids is worth a line in the trail.
  const probeSpy = spyAuditRefusal();
  const missing = updateBookingStatus(
    {
      tripId: "TRIP-GHOST",
      targetStatus: "in_progress",
      actor: "OPS-1",
      correlationId: "corr-ghost-0001",
    },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: noOverlay.read,
      write: forbiddenWrite(),
      auditRefusal: probeSpy,
    }
  );
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, BOARD_REASONS.UNKNOWN_BOOKING);
  assert.strictEqual(probeSpy.calls.length, 1);
  assert.strictEqual(probeSpy.calls[0].reason, BOARD_REASONS.UNKNOWN_BOOKING);
  assert.strictEqual(probeSpy.calls[0].tripId, "TRIP-GHOST");
  console.log("opsBookingBoard: changing a booking that does not exist is refused and audited");

  // An illegal transition. The lifecycle's reason is passed through unchanged,
  // because the route maps it onto a different HTTP code than a bad request.
  const illegalSpy = spyAuditRefusal();
  const illegal = updateBookingStatus(
    {
      tripId: "TRIP-A",
      targetStatus: "completed",
      actor: "OPS-1",
      correlationId: "corr-illegal-001",
    },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: noOverlay.read,
      write: forbiddenWrite(),
      auditRefusal: illegalSpy,
    }
  );
  assert.strictEqual(illegal.ok, false);
  assert.strictEqual(illegal.reason, REFUSAL_REASONS.ILLEGAL_TRANSITION);
  assert.strictEqual(illegalSpy.calls.length, 1);
  console.log("opsBookingBoard: a confirmed booking cannot jump to completed, and the attempt is audited");

  // Out of a terminal state, which is the story's "status fails to update"
  // failure path as a rule rather than an outage.
  const terminalOverlay = fakeOverlay({
    "TRIP-A": { tripId: "TRIP-A", status: "completed", previousStatus: "in_progress", version: 2, changedAt: "x", firstChangedAt: "x", changedBy: "OPS-1" },
  });
  const terminalSpy = spyAuditRefusal();
  const reopen = updateBookingStatus(
    {
      tripId: "TRIP-A",
      targetStatus: "in_progress",
      actor: "OPS-1",
      correlationId: "corr-reopen-0001",
    },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: terminalOverlay.read,
      write: forbiddenWrite(),
      auditRefusal: terminalSpy,
    }
  );
  assert.strictEqual(reopen.ok, false);
  assert.strictEqual(reopen.reason, REFUSAL_REASONS.TERMINAL_STATUS);
  assert.strictEqual(terminalSpy.calls.length, 1);
  console.log("opsBookingBoard: a completed booking cannot be reopened, and the attempt is audited");

  // An unrecognised target status. Reported as its own reason so the operator
  // looks for their typo rather than for a rule that refused them.
  const typo = updateBookingStatus(
    {
      tripId: "TRIP-A",
      targetStatus: "in_progres",
      actor: "OPS-1",
      correlationId: "corr-typo-00001",
    },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: noOverlay.read,
      write: forbiddenWrite(),
      auditRefusal: spyAuditRefusal(),
    }
  );
  assert.strictEqual(typo.reason, REFUSAL_REASONS.UNKNOWN_TARGET_STATUS);
  console.log("opsBookingBoard: an unrecognised target status is named as such");

  // THE CURRENT STATUS IS READ HERE, NOT TAKEN FROM THE CALLER. A caller that
  // read it a moment ago may have read a different value than the rule is about
  // to be checked against, which is how a terminal booking gets reopened by a
  // stale dashboard. Proved by the test above: the caller asked for
  // in_progress, the ledger says confirmed (which would have allowed it), and
  // the OVERLAY says completed - and the overlay is what decided.

  // A no-change save on a legal state. No write, no audit, reported as success.
  const noChangeSpy = spyAuditRefusal();
  const noChange = updateBookingStatus(
    {
      tripId: "TRIP-A",
      targetStatus: "confirmed",
      actor: "OPS-1",
      correlationId: "corr-nochange-01",
    },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: noOverlay.read,
      write: forbiddenWrite(),
      auditRefusal: noChangeSpy,
    }
  );
  assert.strictEqual(noChange.ok, true);
  assert.strictEqual(noChange.changed, false);
  assert.strictEqual(noChange.booking.status, "confirmed");
  assert.strictEqual(noChangeSpy.calls.length, 0);
  console.log("opsBookingBoard: setting a status to what it already is writes nothing and audits nothing");

  // =====================================================================
  // A SUCCESSFUL WRITE re-reads, and a FAILED one passes its reason through.
  // =====================================================================

  const writable = fakeOverlay({});
  const applied = updateBookingStatus(
    {
      tripId: "TRIP-A",
      targetStatus: "in_progress",
      actor: "OPS-DIANE",
      correlationId: "corr-applied-0001",
    },
    {
      ledger: fakeLedger([LEDGER_ROW]),
      readOverlay: writable.read,
      write: writable.write,
      auditRefusal: spyAuditRefusal(),
    }
  );
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(applied.changed, true);
  // The returned row came from a RE-READ of the store, not from patching the
  // row we already had - so the response cannot show a status that is not
  // stored. The overlay fields below only exist because the write really landed.
  assert.strictEqual(applied.booking.status, "in_progress");
  assert.strictEqual(applied.booking.statusVersion, 1);
  assert.strictEqual(applied.booking.statusChangedBy, "OPS-DIANE");
  assert.strictEqual(applied.booking.previousStatus, "confirmed");
  console.log("opsBookingBoard: a successful save returns the booking as re-read from the store");

  // The store's own failures pass through with their reason intact. not_saved
  // and audit_unavailable mean different things to the route, and flattening
  // them into one would lose which it was.
  [STORE_REASONS.NOT_SAVED, STORE_REASONS.AUDIT_UNAVAILABLE].forEach(function (reason) {
    const refused = updateBookingStatus(
      {
        tripId: "TRIP-A",
        targetStatus: "in_progress",
        actor: "OPS-1",
        correlationId: "corr-storefail-01",
      },
      {
        ledger: fakeLedger([LEDGER_ROW]),
        readOverlay: noOverlay.read,
        write: function () {
          return { ok: false, reason: reason, problems: ["the store said no"] };
        },
        auditRefusal: spyAuditRefusal(),
      }
    );
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, reason);
    assert.deepStrictEqual(refused.problems, ["the store said no"]);
  });
  console.log("opsBookingBoard: a store failure passes through with its reason intact");

  console.log("opsBookingBoard: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
