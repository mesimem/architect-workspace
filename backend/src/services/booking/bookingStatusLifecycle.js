// STORY-018: what a booking's status may be, and which status changes an
// operations manager is allowed to make. Pure - no I/O, no clock, no store.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It answers one
// question: "is this status change legal?" It does NOT write the new status
// down, does NOT audit it, does NOT read the booking ledger, and does NOT
// decide who may make the change. Those are bookingStatusStore.js, the audit
// log, opsBookingBoard.js, and the central permission gate respectively.
// Keeping the rules pure is what lets every transition below be tested with two
// strings and no setup - see bookingStatusLifecycle.test.js, which touches no
// store at all.
//
// THE FOUR STATUSES, AND WHY EACH IS ONE. REQ-012 asks the system to "manage
// their statuses", which only means something once "status" has a fixed
// vocabulary. A free-form string would have been three lines instead of this
// file, and it would have made the dashboard's status column read as whatever
// anyone happened to type - "cancelled", "Cancelled", "CANCELLED" and "canceled"
// are four statuses to a filter and one to a human.
//
//   confirmed    - the booking exists and is paid for. This is the ONLY status
//                  the booking path itself ever writes (bookTripService.js and
//                  groupBookingService.js both write exactly "confirmed"), so
//                  it is the start state by construction, not by choice.
//   in_progress  - operations have begun arranging it with suppliers.
//   completed    - the customer has travelled. TERMINAL.
//   cancelled    - the booking will not be travelled. TERMINAL.
//
// WHY completed AND cancelled ARE TERMINAL. A status is a claim about the real
// world, and these two claims are about things that have already happened. Once
// a trip is travelled, nothing an operations manager types makes it untravelled;
// once a booking is cancelled, re-opening it is a NEW booking with its own
// payment, not an edit to a dead one. A lifecycle that lets a record leave a
// terminal state is a lifecycle where the status column cannot be trusted to
// mean anything, because it can always be walked backwards.
//
// This is also the testable form of the story's "booking status fails to
// update" failure path. Without terminal states, the only way to make an update
// fail is to break the store - which tests a disk, not a rule.
//
// WHY confirmed CANNOT JUMP STRAIGHT TO completed. The path is a path: a
// booking that was never arranged with a supplier cannot have been travelled.
// Allowing the jump would mean the one transition that matters most - "this
// customer has now had their trip" - could be recorded with no evidence that
// anybody did the work. An operations manager who genuinely needs to skip a
// step makes two deliberate, separately-audited changes instead of one.
//
// WHAT IS DELIBERATELY ABSENT. There is no `on_hold`. Real operations teams
// hold bookings for payment and document problems, so this is a likely next
// addition - but nothing in STORY-018 or REQ-012 asks for it, and a state
// invented ahead of the requirement that asks for it is a state nobody can say
// is correct. Adding it later is one entry in STATUSES and two rows in
// ALLOWED_TRANSITIONS; that is the whole cost of waiting.
//
// SETTING A STATUS TO WHAT IT ALREADY IS IS NOT A REFUSAL. It is classified
// NO_CHANGE, and the caller is expected to treat that as success without
// writing or auditing anything. CLAUDE.md requires every side effect to be
// idempotent: a retried PATCH - a double-clicked button, a replayed request -
// must not append a second audit entry claiming the status changed twice. The
// alternative, refusing it, would make a safe retry look like an error to the
// client and push operators into refreshing to find out what actually happened.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns a classification object carrying a
//     reason and a human-readable message. It never throws and never mutates
//     its inputs. The caller decides what a refusal becomes - an HTTP 409, a
//     log line - because this module does not know it is being called over HTTP.
//  2. Will it retry? Nothing to retry. Pure function, no I/O, no clock - the
//     same two strings always give the same answer.
//  3. Recovery path if retries are exhausted? Not applicable. A refusal here is
//     a correct answer about an illegal change, not a transient failure, and
//     retrying it will correctly refuse again.
//  4. Failure modes handled vs not handled? HANDLED: unknown status strings in
//     either position, non-string input of any type, a change out of a terminal
//     state, a legal-vocabulary-but-illegal-order change, and a no-op change.
//     NOT HANDLED: whether the booking being changed exists at all, and whether
//     the caller is allowed to change it. Both are deliberately somebody else's
//     job - the first opsBookingBoard.js, the second the permission gate - and
//     this module cannot answer either without the I/O it is defined not to do.

// The vocabulary. Values are the strings that go on the wire and into the
// store, so they are lowercase snake_case like every other status in this repo
// (groupBookingService.js STATUSES, bookTripService's returned status values).
const STATUSES = Object.freeze({
  CONFIRMED: "confirmed",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

const ALL_STATUSES = Object.freeze(Object.values(STATUSES));

// The start state is not a preference - it is what the booking path writes.
// Named here so the board's default and the lifecycle's first state cannot
// drift apart into two different ideas of where a booking begins.
const INITIAL_STATUS = STATUSES.CONFIRMED;

// The transition table, written out per status with no inheritance and no
// wildcards - the same style as authz/permissions.js ROLE_PERMISSIONS, and for
// the same reason. Read this as the answer to "what can an operations manager
// do to a booking in this state?", because that is the question it answers.
//
// A terminal status is one whose row is empty. That is the definition; there is
// no second list to keep in step with this one.
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUSES.CONFIRMED]: Object.freeze([STATUSES.IN_PROGRESS, STATUSES.CANCELLED]),
  [STATUSES.IN_PROGRESS]: Object.freeze([STATUSES.COMPLETED, STATUSES.CANCELLED]),
  [STATUSES.COMPLETED]: Object.freeze([]),
  [STATUSES.CANCELLED]: Object.freeze([]),
});

// Why a transition was refused. Stable strings, because the route layer maps
// them onto HTTP status codes and a test asserts on them - renaming one is a
// breaking contract change, not a tidy-up.
const REFUSAL_REASONS = Object.freeze({
  UNKNOWN_CURRENT_STATUS: "unknown_current_status",
  UNKNOWN_TARGET_STATUS: "unknown_target_status",
  TERMINAL_STATUS: "terminal_status",
  ILLEGAL_TRANSITION: "illegal_transition",
});

// What classifyTransition decided. Three kinds, because the caller has three
// genuinely different jobs: write and audit, do nothing and report success, or
// refuse.
const TRANSITION_KINDS = Object.freeze({
  ALLOWED: "allowed",
  NO_CHANGE: "no_change",
  REFUSED: "refused",
});

function isKnownStatus(value) {
  // typeof guard first: ALL_STATUSES.includes(undefined) is false, but relying
  // on that would also quietly accept a String object or a number that happened
  // to coerce. Untrusted input reaches this function.
  return typeof value === "string" && ALL_STATUSES.indexOf(value) !== -1;
}

function isTerminalStatus(status) {
  // Derived from the table, never from a second hand-kept list of terminals.
  return isKnownStatus(status) && ALLOWED_TRANSITIONS[status].length === 0;
}

// What an operations manager could legally do to a booking in this state.
// Exported because the dashboard shows it: an operator should see the two
// buttons that will work rather than discover by refusal which ones will not.
// Returns a fresh array, so a caller sorting or splicing it cannot edit the
// frozen table through the reference.
function allowedNextStatuses(status) {
  if (!isKnownStatus(status)) {
    return [];
  }
  return ALLOWED_TRANSITIONS[status].slice();
}

// Quote a value into a message without ever quoting the caller's own string
// back at them verbatim. Same rule as packageCompatibility.js describeValue and
// quotePricing.js: a message ends up in an HTTP response body and in a log
// line, so it may carry OUR vocabulary and structural facts about the input,
// never arbitrary caller text.
function describeStatus(value) {
  if (isKnownStatus(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return "a " + typeof value;
  }
  return "an unrecognised status";
}

function refuse(reason, message) {
  return Object.freeze({
    kind: TRANSITION_KINDS.REFUSED,
    reason: reason,
    message: message,
  });
}

// The whole rule set, in one function, in the order the checks have to happen.
//
// ORDER MATTERS AND IS NOT ARBITRARY. Vocabulary is checked before legality,
// because "is in_progres a status?" has to be answered before "may I move to
// it?" - otherwise a typo is reported as an illegal transition and the operator
// goes looking for a rule that refused them instead of for their typo. The
// no-change check sits after vocabulary (an unknown status equalling itself is
// still unknown) and before the terminal check, so that re-sending "cancelled"
// for an already-cancelled booking is the idempotent no-op described in the
// header rather than a terminal-state refusal.
function classifyTransition(currentStatus, targetStatus) {
  if (!isKnownStatus(currentStatus)) {
    // The stored status is not in the vocabulary. This is a corruption or a
    // version skew, not operator error, and it is reported as its own reason so
    // it can never be mistaken for a bad request from the client.
    return refuse(
      REFUSAL_REASONS.UNKNOWN_CURRENT_STATUS,
      "The booking's current status is " + describeStatus(currentStatus) +
        ", which is not a status this system manages."
    );
  }

  if (!isKnownStatus(targetStatus)) {
    return refuse(
      REFUSAL_REASONS.UNKNOWN_TARGET_STATUS,
      "Cannot set a booking to " + describeStatus(targetStatus) +
        ". Valid statuses are: " + ALL_STATUSES.join(", ") + "."
    );
  }

  if (currentStatus === targetStatus) {
    return Object.freeze({
      kind: TRANSITION_KINDS.NO_CHANGE,
      reason: null,
      message: "The booking is already " + targetStatus + ".",
    });
  }

  if (isTerminalStatus(currentStatus)) {
    return refuse(
      REFUSAL_REASONS.TERMINAL_STATUS,
      "This booking is " + currentStatus + ", which is final. A " + currentStatus +
        " booking cannot be changed to " + targetStatus + "."
    );
  }

  if (ALLOWED_TRANSITIONS[currentStatus].indexOf(targetStatus) === -1) {
    return refuse(
      REFUSAL_REASONS.ILLEGAL_TRANSITION,
      "A booking that is " + currentStatus + " cannot move to " + targetStatus +
        ". From " + currentStatus + " it may become: " +
        ALLOWED_TRANSITIONS[currentStatus].join(", ") + "."
    );
  }

  return Object.freeze({
    kind: TRANSITION_KINDS.ALLOWED,
    reason: null,
    message: "Moving the booking from " + currentStatus + " to " + targetStatus + ".",
  });
}

module.exports = {
  STATUSES,
  ALL_STATUSES,
  INITIAL_STATUS,
  ALLOWED_TRANSITIONS,
  REFUSAL_REASONS,
  TRANSITION_KINDS,
  isKnownStatus,
  isTerminalStatus,
  allowedNextStatuses,
  classifyTransition,
};
