// STORY-018, the write path. This file tests the HALF of "booking status fails
// to update" that is an outage rather than a rule: the store refusing the
// write, the store losing the write, and the audit log being unavailable.
//
// The other half - a change refused because the lifecycle forbids it - is in
// bookingStatusLifecycle.test.js, where it needs no store at all.
//
// WHY THE STORES HERE ARE FAKES THAT MISBEHAVE ON PURPOSE. The real store
// cannot be asked to accept a write and then lose it, and the real audit log
// cannot be asked to be down. Those are exactly the two failures the audit
// guarantee is built to survive, so proving the guarantee requires a store and
// an audit that can be told to fail. This is the whole reason writeStatusChange
// takes { store, audit, now } as an injected second argument.
//
// THE GUARANTEE BEING TESTED, stated once: no status change exists in the store
// without a matching entry in the audit trail. Every assertion below is about
// some way that could stop being true.

const assert = require("assert");

const {
  readStatusRecord,
  listStatusRecords,
  writeStatusChange,
  auditRefusedChange,
  STATUS_CHANGED_EVENT,
  STATUS_CHANGE_REFUSED_EVENT,
  REASONS,
  __resetBookingStatusesForTests,
} = require("./bookingStatusStore");

// A store that behaves. Map-shaped, matching the surface auditedCommit and this
// module actually use: get, set, delete, values, keys.
function workingStore() {
  const rows = new Map();
  return {
    rows: rows,
    get: function (key) {
      return rows.get(key);
    },
    set: function (key, value) {
      rows.set(key, value);
    },
    delete: function (key) {
      return rows.delete(key);
    },
    values: function () {
      return rows.values();
    },
    keys: function () {
      return rows.keys();
    },
  };
}

// An audit that records what it was asked to record, so the test can read the
// trail back and assert on what is in it.
function recordingAudit() {
  const entries = [];
  const audit = function (entry) {
    entries.push(entry);
    return { entry: entry, replayed: false };
  };
  audit.entries = entries;
  return audit;
}

// An audit that is down. Throws the way the real one does on a refused entry.
function brokenAudit(message) {
  return function () {
    const error = new Error(message || "audit log unavailable");
    error.errorClass = "AuditUnavailable";
    throw error;
  };
}

// A fixed clock, so changedAt is assertable rather than "some string".
function clockAt(iso) {
  return function () {
    return iso;
  };
}

const FIRST_CHANGE = "2026-10-01T09:00:00.000Z";
const SECOND_CHANGE = "2026-10-02T14:30:00.000Z";

function main() {
  // ---------------------------------------------------------------------
  // HAPPY PATH: the first change operations ever make to a booking.
  // ---------------------------------------------------------------------

  const store = workingStore();
  const audit = recordingAudit();

  const first = writeStatusChange(
    {
      tripId: "TRIP-100",
      previousStatus: "confirmed",
      targetStatus: "in_progress",
      actor: "OPS-ALICE",
      correlationId: "corr-first-0001",
    },
    { store: store, audit: audit, now: clockAt(FIRST_CHANGE) }
  );

  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.record.tripId, "TRIP-100");
  assert.strictEqual(first.record.status, "in_progress");
  assert.strictEqual(first.record.previousStatus, "confirmed");
  // v1 is the first change OPERATIONS made, not the booking's creation - the
  // booking path writes nothing to this store.
  assert.strictEqual(first.record.version, 1);
  assert.strictEqual(first.record.changedAt, FIRST_CHANGE);
  assert.strictEqual(first.record.firstChangedAt, FIRST_CHANGE);
  assert.strictEqual(first.record.changedBy, "OPS-ALICE");
  console.log("bookingStatusStore: a first status change is stored at version 1");

  // Frozen, so a caller handed the record cannot edit the store through it.
  assert.ok(Object.isFrozen(first.record));
  console.log("bookingStatusStore: the stored record is frozen");

  // It is really in the store, under the tripId, not merely returned.
  assert.strictEqual(readStatusRecord("TRIP-100", { store: store }).status, "in_progress");
  console.log("bookingStatusStore: the change is readable back by trip ID");

  // AND it is in the audit trail. One entry, keyed on the trip and the version.
  assert.strictEqual(audit.entries.length, 1);
  assert.strictEqual(audit.entries[0].event, STATUS_CHANGED_EVENT);
  assert.strictEqual(audit.entries[0].outcome, "success");
  assert.strictEqual(audit.entries[0].actor, "OPS-ALICE");
  assert.strictEqual(audit.entries[0].resource, "TRIP-100");
  assert.strictEqual(audit.entries[0].correlationId, "corr-first-0001");
  assert.strictEqual(audit.entries[0].auditKey, "TRIP-100:booking.status.changed.v1");
  console.log("bookingStatusStore: the change is in the audit trail, keyed on trip and version");

  // WHAT THE AUDIT ENTRY MAY CONTAIN. The from/to pair, the trip, the version -
  // and nothing else. Asserted as an EXACT key set rather than a few spot
  // checks, because the failure being guarded against is someone adding the
  // customer or the price to this context later: the audit trail persists to
  // disk forever and should not accumulate copies of customer data it does not
  // need.
  assert.deepStrictEqual(Object.keys(audit.entries[0].context).sort(), [
    "from",
    "to",
    "tripId",
    "version",
  ]);
  assert.strictEqual(audit.entries[0].context.from, "confirmed");
  assert.strictEqual(audit.entries[0].context.to, "in_progress");
  console.log("bookingStatusStore: the audit context carries the change and no customer data");

  // ---------------------------------------------------------------------
  // THE SECOND CHANGE. The case that proves "ALL changes are logged".
  // ---------------------------------------------------------------------

  const second = writeStatusChange(
    {
      tripId: "TRIP-100",
      previousStatus: "in_progress",
      targetStatus: "completed",
      actor: "OPS-BOB",
      correlationId: "corr-second-002",
    },
    { store: store, audit: audit, now: clockAt(SECOND_CHANGE) }
  );

  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.record.version, 2);
  assert.strictEqual(second.record.status, "completed");
  assert.strictEqual(second.record.previousStatus, "in_progress");
  assert.strictEqual(second.record.changedAt, SECOND_CHANGE);
  // Preserved from the first change, not reset to now. Two different questions:
  // "when did operations first touch this?" and "when did they last?".
  assert.strictEqual(second.record.firstChangedAt, FIRST_CHANGE);
  assert.strictEqual(second.record.changedBy, "OPS-BOB");
  console.log("bookingStatusStore: a second change increments the version and keeps firstChangedAt");

  // THE ASSERTION THIS WHOLE DESIGN EXISTS FOR. The audit log is
  // first-write-wins. Keyed on the trip id alone, this second entry would have
  // been discarded as a duplicate and the trail would hold only the first
  // change - leaving the module passing every other test while quietly failing
  // the story's trust criterion. Two changes, two entries, two distinct keys.
  assert.strictEqual(audit.entries.length, 2);
  assert.strictEqual(audit.entries[1].auditKey, "TRIP-100:booking.status.changed.v2");
  assert.notStrictEqual(audit.entries[0].auditKey, audit.entries[1].auditKey);
  console.log("bookingStatusStore: every change gets its own audit entry, not just the first");

  // The store holds ONE row per booking - the current status, not a history.
  // The history is the audit trail's job, which is why it must be complete.
  assert.strictEqual(listStatusRecords({ store: store }).length, 1);
  console.log("bookingStatusStore: the store holds one current row per booking");

  // ---------------------------------------------------------------------
  // FAILURE PATH: the audit log is down. THE ROLLBACK.
  // ---------------------------------------------------------------------

  // On a booking with NO existing row, the correct rollback is to remove the
  // row entirely - there was nothing to go back to.
  const rollbackStore = workingStore();
  const newRowRefused = writeStatusChange(
    {
      tripId: "TRIP-200",
      previousStatus: "confirmed",
      targetStatus: "cancelled",
      actor: "OPS-ALICE",
      correlationId: "corr-audit-down1",
    },
    { store: rollbackStore, audit: brokenAudit(), now: clockAt(FIRST_CHANGE) }
  );

  assert.strictEqual(newRowRefused.ok, false);
  assert.strictEqual(newRowRefused.reason, REASONS.AUDIT_UNAVAILABLE);
  assert.ok(Array.isArray(newRowRefused.problems));
  assert.ok(newRowRefused.problems[0].length > 0);
  // THE POINT: no unaudited row was left behind.
  assert.strictEqual(readStatusRecord("TRIP-200", { store: rollbackStore }), null);
  assert.strictEqual(listStatusRecords({ store: rollbackStore }).length, 0);
  console.log("bookingStatusStore: an unauditable first change is rolled back to nothing");

  // On a booking that ALREADY had a row, the rollback must restore the OLD row
  // - not delete it. Deleting would turn an audit outage into silent data loss,
  // which is a worse failure than the one being handled.
  const restoreStore = workingStore();
  const okAudit = recordingAudit();
  writeStatusChange(
    {
      tripId: "TRIP-300",
      previousStatus: "confirmed",
      targetStatus: "in_progress",
      actor: "OPS-ALICE",
      correlationId: "corr-restore-001",
    },
    { store: restoreStore, audit: okAudit, now: clockAt(FIRST_CHANGE) }
  );

  const supersedeRefused = writeStatusChange(
    {
      tripId: "TRIP-300",
      previousStatus: "in_progress",
      targetStatus: "completed",
      actor: "OPS-BOB",
      correlationId: "corr-restore-002",
    },
    { store: restoreStore, audit: brokenAudit(), now: clockAt(SECOND_CHANGE) }
  );

  assert.strictEqual(supersedeRefused.ok, false);
  assert.strictEqual(supersedeRefused.reason, REASONS.AUDIT_UNAVAILABLE);

  const restored = readStatusRecord("TRIP-300", { store: restoreStore });
  assert.ok(restored, "the previous row must still be there");
  assert.strictEqual(restored.status, "in_progress");
  assert.strictEqual(restored.version, 1);
  assert.strictEqual(restored.changedAt, FIRST_CHANGE);
  assert.strictEqual(restored.changedBy, "OPS-ALICE");
  console.log("bookingStatusStore: an unauditable later change restores the previous row exactly");

  // And the trail holds only the change that actually happened. A refused
  // change must not appear as a success.
  assert.strictEqual(okAudit.entries.length, 1);
  assert.strictEqual(okAudit.entries[0].auditKey, "TRIP-300:booking.status.changed.v1");
  console.log("bookingStatusStore: a rolled-back change leaves no success entry");

  // ---------------------------------------------------------------------
  // FAILURE PATH: the store itself. Three ways it can let us down.
  // ---------------------------------------------------------------------

  // 1. It throws on write - a full disk, a permission error.
  const throwingStore = Object.assign(workingStore(), {
    set: function () {
      const error = new Error("ENOSPC: no space left on device");
      error.errorClass = "StoreUnavailable";
      throw error;
    },
  });
  const threw = writeStatusChange(
    {
      tripId: "TRIP-400",
      previousStatus: "confirmed",
      targetStatus: "in_progress",
      actor: "OPS-ALICE",
      correlationId: "corr-throwing-01",
    },
    { store: throwingStore, audit: recordingAudit(), now: clockAt(FIRST_CHANGE) }
  );
  assert.strictEqual(threw.ok, false);
  assert.strictEqual(threw.reason, REASONS.NOT_SAVED);
  console.log("bookingStatusStore: a store that throws is reported as not saved, not as a crash");

  // 2. It accepts the write and silently loses it. The read-back catches this;
  // without it, the caller would be told their change landed when it did not,
  // and the dashboard would show a status that is not on disk.
  const forgetfulStore = Object.assign(workingStore(), {
    set: function () {
      /* accepts everything, stores nothing */
    },
  });
  const lost = writeStatusChange(
    {
      tripId: "TRIP-500",
      previousStatus: "confirmed",
      targetStatus: "in_progress",
      actor: "OPS-ALICE",
      correlationId: "corr-forgetful-1",
    },
    { store: forgetfulStore, audit: recordingAudit(), now: clockAt(FIRST_CHANGE) }
  );
  assert.strictEqual(lost.ok, false);
  assert.strictEqual(lost.reason, REASONS.NOT_SAVED);
  console.log("bookingStatusStore: a write the store silently loses is caught by the read-back");

  // 3. It keeps the OLD row - the subtle one. Presence alone would pass; the
  // read-back compares the VERSION, so a stale row is caught too.
  const staleRows = new Map();
  const staleStore = {
    get: function (key) {
      return staleRows.get(key);
    },
    set: function (key, value) {
      // Writes the first version, then refuses every update.
      if (!staleRows.has(key)) {
        staleRows.set(key, value);
      }
    },
    delete: function (key) {
      return staleRows.delete(key);
    },
    values: function () {
      return staleRows.values();
    },
    keys: function () {
      return staleRows.keys();
    },
  };
  const staleAudit = recordingAudit();
  writeStatusChange(
    {
      tripId: "TRIP-600",
      previousStatus: "confirmed",
      targetStatus: "in_progress",
      actor: "OPS-ALICE",
      correlationId: "corr-stale-0001",
    },
    { store: staleStore, audit: staleAudit, now: clockAt(FIRST_CHANGE) }
  );
  const stale = writeStatusChange(
    {
      tripId: "TRIP-600",
      previousStatus: "in_progress",
      targetStatus: "completed",
      actor: "OPS-BOB",
      correlationId: "corr-stale-0002",
    },
    { store: staleStore, audit: staleAudit, now: clockAt(SECOND_CHANGE) }
  );
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.reason, REASONS.NOT_SAVED);
  // The old row is untouched and - critically - no audit entry claims the
  // second change happened.
  assert.strictEqual(readStatusRecord("TRIP-600", { store: staleStore }).status, "in_progress");
  assert.strictEqual(staleAudit.entries.length, 1);
  console.log("bookingStatusStore: a store that keeps the old version is caught by the version check");

  // ---------------------------------------------------------------------
  // readStatusRecord: absence is normal, not an error.
  // ---------------------------------------------------------------------

  // A booking operations have never touched has no row here. Null, not a throw
  // - the board turns this into "confirmed".
  assert.strictEqual(readStatusRecord("TRIP-NEVER-TOUCHED", { store: store }), null);
  // Malformed ids cannot match a row and must not throw on the way to finding
  // that out. The caller that accepted one owes the client a 400.
  [undefined, null, "", "   ", 42, {}, []].forEach(function (bad) {
    assert.strictEqual(readStatusRecord(bad, { store: store }), null);
  });
  console.log("bookingStatusStore: an untouched or malformed booking reads as null, never a throw");

  // ---------------------------------------------------------------------
  // auditRefusedChange: the attempt that changed nothing.
  // ---------------------------------------------------------------------

  const refusalAudit = recordingAudit();
  const logged = auditRefusedChange(
    {
      tripId: "TRIP-100",
      reason: "terminal_status",
      actor: "OPS-ALICE",
      correlationId: "corr-refusal-001",
    },
    { audit: refusalAudit }
  );
  assert.strictEqual(logged, true);
  assert.strictEqual(refusalAudit.entries.length, 1);
  assert.strictEqual(refusalAudit.entries[0].event, STATUS_CHANGE_REFUSED_EVENT);
  assert.strictEqual(refusalAudit.entries[0].outcome, "failure");
  assert.strictEqual(refusalAudit.entries[0].resource, "TRIP-100");
  assert.strictEqual(refusalAudit.entries[0].actor, "OPS-ALICE");
  // A separate event from the success one, so "what changed" and "what was
  // turned down" are two queries rather than one plus a filter.
  assert.notStrictEqual(STATUS_CHANGE_REFUSED_EVENT, STATUS_CHANGED_EVENT);
  // The reason, and not the submitted body - a rejected submission can carry a
  // customer's details and this trail is permanent.
  assert.deepStrictEqual(Object.keys(refusalAudit.entries[0].context), ["reason"]);
  assert.strictEqual(refusalAudit.entries[0].context.reason, "terminal_status");
  console.log("bookingStatusStore: a refused attempt is audited under its own event");

  // A BLANK OR NON-STRING correlation id means no key to dedup on, so nothing
  // is written - an entry under a made-up key could never be matched by a later
  // request. Reported as false rather than thrown.
  //
  // Note what the boundary actually is. deriveAuditKey refuses a base that is
  // blank or not a string, and nothing else: a SHORT id still produces a usable
  // key, because the event discriminator it appends is itself long enough to
  // clear the minimum. So the cases below are the blank ones, not the short
  // ones - a short id is handled a layer up, where updateBookingStatus refuses
  // the whole request as invalid before any audit is attempted.
  const unkeyableAudit = recordingAudit();
  [undefined, null, "", "   ", 42, {}].forEach(function (unusable) {
    assert.strictEqual(
      auditRefusedChange(
        {
          tripId: "TRIP-100",
          reason: "terminal_status",
          actor: "OPS-ALICE",
          correlationId: unusable,
        },
        { audit: unkeyableAudit }
      ),
      false
    );
  });
  assert.strictEqual(unkeyableAudit.entries.length, 0);
  console.log("bookingStatusStore: an unkeyable refusal is not invented into the trail");

  // The other side of that boundary, pinned so it cannot silently change: a
  // short-but-present correlation id IS audited. Losing the refusal trail
  // because an id was five characters long would be the wrong trade - the
  // request is already being refused, and the trail is the only record that it
  // was attempted.
  const shortIdAudit = recordingAudit();
  assert.strictEqual(
    auditRefusedChange(
      { tripId: "TRIP-100", reason: "terminal_status", actor: "OPS-ALICE", correlationId: "short" },
      { audit: shortIdAudit }
    ),
    true
  );
  assert.strictEqual(shortIdAudit.entries.length, 1);
  console.log("bookingStatusStore: a short-but-present correlation id still records the refusal");

  // BEST EFFORT, and deliberately asymmetrical with writeStatusChange: if THIS
  // audit write fails, the caller's outcome does not change. They were going to
  // be refused either way, and the refusal already left the system exactly as
  // it was. Returns false; does not throw.
  assert.strictEqual(
    auditRefusedChange(
      {
        tripId: "TRIP-100",
        reason: "terminal_status",
        actor: "OPS-ALICE",
        correlationId: "corr-refusal-002",
      },
      { audit: brokenAudit() }
    ),
    false
  );
  console.log("bookingStatusStore: an audit failure on a refusal is survivable, not fatal");

  // ---------------------------------------------------------------------
  // The real store, wired to its real defaults.
  // ---------------------------------------------------------------------

  // Every test above injected a fake, which proves the logic and proves nothing
  // about the wiring. This one calls through with no options at all, so a
  // module-level typo in the store name or the audit import cannot hide.
  try {
    const wired = writeStatusChange({
      tripId: "TRIP-REAL-WIRING",
      previousStatus: "confirmed",
      targetStatus: "cancelled",
      actor: "OPS-ALICE",
      correlationId: "corr-real-wiring",
    });
    assert.strictEqual(wired.ok, true);
    assert.strictEqual(wired.record.version, 1);
    assert.strictEqual(readStatusRecord("TRIP-REAL-WIRING").status, "cancelled");
    console.log("bookingStatusStore: the real store and real audit log are correctly wired");
  } finally {
    // The real store is process-wide. Leaving a row in it would leak into any
    // other suite that reads it - the house convention every store module
    // exports a reset for.
    __resetBookingStatusesForTests();
  }
  assert.strictEqual(readStatusRecord("TRIP-REAL-WIRING"), null);
  console.log("bookingStatusStore: the reset helper clears the real store");

  console.log("bookingStatusStore: all tests passed");
}

main();
