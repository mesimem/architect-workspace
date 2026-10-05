// STORY-018, the pure half. The story's first named failure path - "booking
// status fails to update" - is tested here in the form that is a RULE rather
// than an outage: a change that the lifecycle refuses because the booking's
// current state does not permit it. A trip that has already been travelled
// cannot be un-travelled, and an operations manager who tries is told why.
//
// The other two failure paths are tested where they live: "dashboard fails to
// display new bookings" in opsBookingBoard.test.js (a new ledger row must
// appear with no sync step in between), and "unauthorized access to booking
// management features" in http/opsBookings.test.js, which is a property of the
// HTTP boundary and cannot be observed from here.
//
// The OTHER half of "status fails to update" - the store accepting a write and
// the audit then failing - is in bookingStatusStore.test.js, because it needs a
// store to break.
//
// EVERY EXPECTED ANSWER IS WRITTEN OUT BY HAND rather than read back out of
// ALLOWED_TRANSITIONS. A test that asks the table what the table says cannot
// catch the table being wrong - so the legal transitions below are listed
// literally, and the day someone adds a row to the table, this file fails until
// a human agrees the new row is intended.

const assert = require("assert");

const {
  STATUSES,
  ALL_STATUSES,
  INITIAL_STATUS,
  REFUSAL_REASONS,
  TRANSITION_KINDS,
  isKnownStatus,
  isTerminalStatus,
  allowedNextStatuses,
  classifyTransition,
} = require("./bookingStatusLifecycle");

function main() {
  // ---------------------------------------------------------------------
  // The vocabulary itself.
  // ---------------------------------------------------------------------

  // Written out literally. If a fifth status is added, this assertion fails and
  // whoever added it has to come here and say so - which is the point.
  assert.deepStrictEqual(ALL_STATUSES.slice().sort(), [
    "cancelled",
    "completed",
    "confirmed",
    "in_progress",
  ]);
  console.log("bookingStatusLifecycle: the vocabulary is exactly four statuses");

  // The start state is what the booking path actually writes. bookTripService.js
  // and groupBookingService.js both set status: "confirmed" and nothing else, so
  // if this ever disagrees, the dashboard's default is wrong for every booking
  // ever made.
  assert.strictEqual(INITIAL_STATUS, "confirmed");
  console.log("bookingStatusLifecycle: a booking starts confirmed");

  // ---------------------------------------------------------------------
  // isKnownStatus: untrusted input reaches this, so type confusion counts.
  // ---------------------------------------------------------------------

  assert.strictEqual(isKnownStatus("confirmed"), true);
  assert.strictEqual(isKnownStatus("in_progress"), true);

  // A near-miss typo, the single most likely bad input from a hand-written
  // request. It must not be accepted by a loose comparison.
  assert.strictEqual(isKnownStatus("in_progres"), false);

  // Case matters. "Cancelled" and "cancelled" being two statuses to a filter
  // and one to a human is the whole reason the vocabulary is fixed.
  assert.strictEqual(isKnownStatus("Cancelled"), false);
  assert.strictEqual(isKnownStatus("CONFIRMED"), false);

  // Non-strings of every shape that an HTTP body can actually produce.
  assert.strictEqual(isKnownStatus(undefined), false);
  assert.strictEqual(isKnownStatus(null), false);
  assert.strictEqual(isKnownStatus(""), false);
  assert.strictEqual(isKnownStatus(0), false);
  assert.strictEqual(isKnownStatus(["confirmed"]), false);
  assert.strictEqual(isKnownStatus({ status: "confirmed" }), false);
  // A String OBJECT, not a primitive. JSON.parse cannot make one, but a caller
  // inside the process can, and typeof catches it where includes() would not.
  assert.strictEqual(isKnownStatus(new String("confirmed")), false);
  console.log("bookingStatusLifecycle: only exact lowercase vocabulary strings are statuses");

  // ---------------------------------------------------------------------
  // Which states are final.
  // ---------------------------------------------------------------------

  assert.strictEqual(isTerminalStatus(STATUSES.COMPLETED), true);
  assert.strictEqual(isTerminalStatus(STATUSES.CANCELLED), true);
  assert.strictEqual(isTerminalStatus(STATUSES.CONFIRMED), false);
  assert.strictEqual(isTerminalStatus(STATUSES.IN_PROGRESS), false);
  // An unknown status is not terminal - it is unknown. Answering "true" here
  // would make a corrupt stored value look like a finished trip.
  assert.strictEqual(isTerminalStatus("nonsense"), false);
  assert.strictEqual(isTerminalStatus(undefined), false);
  console.log("bookingStatusLifecycle: completed and cancelled are final, and unknown is not");

  // ---------------------------------------------------------------------
  // allowedNextStatuses: what the dashboard offers an operator.
  // ---------------------------------------------------------------------

  // Listed literally, in table order.
  assert.deepStrictEqual(allowedNextStatuses(STATUSES.CONFIRMED), ["in_progress", "cancelled"]);
  assert.deepStrictEqual(allowedNextStatuses(STATUSES.IN_PROGRESS), ["completed", "cancelled"]);
  assert.deepStrictEqual(allowedNextStatuses(STATUSES.COMPLETED), []);
  assert.deepStrictEqual(allowedNextStatuses(STATUSES.CANCELLED), []);
  assert.deepStrictEqual(allowedNextStatuses("nonsense"), []);
  console.log("bookingStatusLifecycle: each state offers exactly its legal next moves");

  // A caller must not be able to edit the frozen table through the array it was
  // handed. allowedNextStatuses returns a copy; prove it by mutating.
  const offered = allowedNextStatuses(STATUSES.CONFIRMED);
  offered.push("completed");
  assert.deepStrictEqual(allowedNextStatuses(STATUSES.CONFIRMED), ["in_progress", "cancelled"]);
  console.log("bookingStatusLifecycle: the returned list is a copy, not the table");

  // ---------------------------------------------------------------------
  // The legal transitions. HAPPY PATH.
  // ---------------------------------------------------------------------

  const forwardOne = classifyTransition(STATUSES.CONFIRMED, STATUSES.IN_PROGRESS);
  assert.strictEqual(forwardOne.kind, TRANSITION_KINDS.ALLOWED);
  assert.strictEqual(forwardOne.reason, null);
  console.log("bookingStatusLifecycle: confirmed -> in_progress is allowed");

  const forwardTwo = classifyTransition(STATUSES.IN_PROGRESS, STATUSES.COMPLETED);
  assert.strictEqual(forwardTwo.kind, TRANSITION_KINDS.ALLOWED);
  console.log("bookingStatusLifecycle: in_progress -> completed is allowed");

  // Cancellation is reachable from both live states, because a booking can fall
  // through either before or during the arranging.
  assert.strictEqual(
    classifyTransition(STATUSES.CONFIRMED, STATUSES.CANCELLED).kind,
    TRANSITION_KINDS.ALLOWED
  );
  assert.strictEqual(
    classifyTransition(STATUSES.IN_PROGRESS, STATUSES.CANCELLED).kind,
    TRANSITION_KINDS.ALLOWED
  );
  console.log("bookingStatusLifecycle: cancellation is reachable from both live states");

  // ---------------------------------------------------------------------
  // IDEMPOTENCY. The retried PATCH.
  // ---------------------------------------------------------------------

  // A double-clicked button, or a client replaying a request it never saw the
  // response to. This must be a no-op the caller can report as success, NOT a
  // refusal - and the caller must be able to tell it apart from a real change,
  // because a real change writes an audit entry and this one must not.
  ALL_STATUSES.forEach(function (status) {
    const sameToSame = classifyTransition(status, status);
    assert.strictEqual(sameToSame.kind, TRANSITION_KINDS.NO_CHANGE);
    assert.strictEqual(sameToSame.reason, null);
  });
  console.log("bookingStatusLifecycle: setting a status to what it already is is a no-op, not an error");

  // Including on a TERMINAL status, which is the case the check order exists
  // for. Re-sending "cancelled" for an already-cancelled booking is a safe
  // retry; reporting it as a terminal-state refusal would make a harmless
  // replay look like operator error.
  const replayedCancel = classifyTransition(STATUSES.CANCELLED, STATUSES.CANCELLED);
  assert.strictEqual(replayedCancel.kind, TRANSITION_KINDS.NO_CHANGE);
  assert.notStrictEqual(replayedCancel.reason, REFUSAL_REASONS.TERMINAL_STATUS);
  console.log("bookingStatusLifecycle: re-sending a terminal status is a replay, not a refusal");

  // ---------------------------------------------------------------------
  // FAILURE PATH: "booking status fails to update" as a rule.
  // ---------------------------------------------------------------------

  // The headline case. A trip that has been travelled cannot be un-travelled.
  const outOfCompleted = classifyTransition(STATUSES.COMPLETED, STATUSES.IN_PROGRESS);
  assert.strictEqual(outOfCompleted.kind, TRANSITION_KINDS.REFUSED);
  assert.strictEqual(outOfCompleted.reason, REFUSAL_REASONS.TERMINAL_STATUS);
  console.log("bookingStatusLifecycle: a completed booking cannot be reopened");

  // A cancelled booking is not re-opened by editing it. That is a new booking
  // with its own payment.
  const outOfCancelled = classifyTransition(STATUSES.CANCELLED, STATUSES.CONFIRMED);
  assert.strictEqual(outOfCancelled.kind, TRANSITION_KINDS.REFUSED);
  assert.strictEqual(outOfCancelled.reason, REFUSAL_REASONS.TERMINAL_STATUS);
  console.log("bookingStatusLifecycle: a cancelled booking cannot be revived");

  // Every route out of a terminal state, exhaustively - not just the two above.
  // Terminal means terminal for all four targets, including the other terminal.
  [STATUSES.COMPLETED, STATUSES.CANCELLED].forEach(function (terminal) {
    ALL_STATUSES.forEach(function (target) {
      if (target === terminal) {
        return; // the replay case, asserted above
      }
      assert.strictEqual(
        classifyTransition(terminal, target).reason,
        REFUSAL_REASONS.TERMINAL_STATUS,
        "expected " + terminal + " -> " + target + " to be refused as terminal"
      );
    });
  });
  console.log("bookingStatusLifecycle: no transition leaves a terminal state");

  // Skipping the middle. The one transition that matters most - "this customer
  // has had their trip" - must not be recordable with no evidence that anybody
  // arranged it.
  const skipped = classifyTransition(STATUSES.CONFIRMED, STATUSES.COMPLETED);
  assert.strictEqual(skipped.kind, TRANSITION_KINDS.REFUSED);
  assert.strictEqual(skipped.reason, REFUSAL_REASONS.ILLEGAL_TRANSITION);
  console.log("bookingStatusLifecycle: confirmed cannot jump straight to completed");

  // Walking backwards through the live states is equally refused, and as an
  // ILLEGAL_TRANSITION rather than a terminal one - in_progress is not final.
  const backwards = classifyTransition(STATUSES.IN_PROGRESS, STATUSES.CONFIRMED);
  assert.strictEqual(backwards.kind, TRANSITION_KINDS.REFUSED);
  assert.strictEqual(backwards.reason, REFUSAL_REASONS.ILLEGAL_TRANSITION);
  console.log("bookingStatusLifecycle: in_progress cannot go back to confirmed");

  // ---------------------------------------------------------------------
  // Bad vocabulary, and the two sides it can be wrong on.
  // ---------------------------------------------------------------------

  // A typo in the REQUEST. Reported as an unknown target, not as an illegal
  // transition - so the operator goes looking for their typo rather than for a
  // rule that refused them.
  const typo = classifyTransition(STATUSES.CONFIRMED, "in_progres");
  assert.strictEqual(typo.kind, TRANSITION_KINDS.REFUSED);
  assert.strictEqual(typo.reason, REFUSAL_REASONS.UNKNOWN_TARGET_STATUS);
  // The message has to be actionable: it must name the statuses that would work.
  assert.ok(typo.message.indexOf("in_progress") !== -1);
  console.log("bookingStatusLifecycle: an unrecognised target status is named as such, with the valid set");

  // A corrupt STORED status - our bug, or a version skew, not the client's
  // fault. It gets its own reason so the route layer can answer 500 rather than
  // 400 and nobody spends an afternoon debugging the request.
  const corrupt = classifyTransition("whatever-was-in-the-store", STATUSES.IN_PROGRESS);
  assert.strictEqual(corrupt.kind, TRANSITION_KINDS.REFUSED);
  assert.strictEqual(corrupt.reason, REFUSAL_REASONS.UNKNOWN_CURRENT_STATUS);
  console.log("bookingStatusLifecycle: a corrupt stored status is distinguished from a bad request");

  // Current status is checked BEFORE the target, so a request that is wrong in
  // both places is reported as the system's problem first. Fixing the typo
  // would not have helped - the stored value is still unreadable.
  const bothWrong = classifyTransition("garbage", "also-garbage");
  assert.strictEqual(bothWrong.reason, REFUSAL_REASONS.UNKNOWN_CURRENT_STATUS);
  console.log("bookingStatusLifecycle: when both statuses are unknown, the stored one is reported first");

  // Non-string input in either position, which is what a JSON body of
  // {"status": 3} or {"status": null} actually delivers. No throw - a
  // classification, like every other refusal.
  [undefined, null, 42, true, {}, []].forEach(function (bad) {
    const refusedTarget = classifyTransition(STATUSES.CONFIRMED, bad);
    assert.strictEqual(refusedTarget.kind, TRANSITION_KINDS.REFUSED);
    assert.strictEqual(refusedTarget.reason, REFUSAL_REASONS.UNKNOWN_TARGET_STATUS);
  });
  console.log("bookingStatusLifecycle: non-string input is refused, never thrown on");

  // ---------------------------------------------------------------------
  // Shape guarantees the callers rely on.
  // ---------------------------------------------------------------------

  // Every classification carries all three fields and is frozen, so the store
  // and the route can read .kind/.reason/.message without defending against an
  // absent key, and cannot accidentally mutate a shared frozen object.
  [
    classifyTransition(STATUSES.CONFIRMED, STATUSES.IN_PROGRESS),
    classifyTransition(STATUSES.CONFIRMED, STATUSES.CONFIRMED),
    classifyTransition(STATUSES.COMPLETED, STATUSES.CONFIRMED),
  ].forEach(function (result) {
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.prototype.hasOwnProperty.call(result, "kind"));
    assert.ok(Object.prototype.hasOwnProperty.call(result, "reason"));
    assert.strictEqual(typeof result.message, "string");
    assert.ok(result.message.length > 0);
  });
  console.log("bookingStatusLifecycle: every classification is frozen and fully populated");

  // Purity, stated as an assertion rather than as a comment: the same two
  // strings always give the same answer, so there is nothing to retry and
  // nothing to seed.
  assert.deepStrictEqual(
    classifyTransition(STATUSES.CONFIRMED, STATUSES.IN_PROGRESS),
    classifyTransition(STATUSES.CONFIRMED, STATUSES.IN_PROGRESS)
  );
  console.log("bookingStatusLifecycle: the same question always gets the same answer");

  console.log("bookingStatusLifecycle: all tests passed");
}

main();
