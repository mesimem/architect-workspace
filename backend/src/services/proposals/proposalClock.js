// STORY-013: the thirty-minute clock, and nothing else.
//
// REQ-003 is the only requirement in this project with a NUMBER in it: a
// proposal must be created "within 30 minutes". Two of the story's three
// acceptance criteria are therefore decided by one subtraction, and that
// subtraction is the whole of this file. It is pure - no store, no notifier, no
// Date.now() - so the interesting cases (the exact boundary, a clock that runs
// backwards) can be tested by passing timestamps rather than by waiting half an
// hour or by mocking a global.
//
// WHY THE CLOCK IS ITS OWN MODULE. proposalStore.js owns the LIFECYCLE of a
// proposal and proposalDelayNotifier.js owns telling an advisor about a delay.
// Both need to answer "is this late?", and they must answer it identically. Two
// copies of `elapsed > 30 * 60 * 1000` is two places for the boundary to drift,
// and a proposal that the store calls on time while the notifier calls late is
// a bug nobody would think to look for.
//
// THE BOUNDARY IS INCLUSIVE, AND THAT IS A DECISION, NOT AN ACCIDENT. "Within
// 30 minutes" includes the thirty-minute mark, so a breach is elapsed STRICTLY
// GREATER than the budget. Exactly 30:00.000 is on time. The alternative
// (>=) would report a breach on a proposal that met the requirement as written,
// and the difference is invisible unless someone tests the boundary itself -
// which proposalClock.test.js does, on both sides and at the millisecond.
//
// A TIMESTAMP IS AN ISO INSTANT STRING OR IT IS NOTHING. Numbers are rejected
// even though Date accepts them, because a number is ambiguous (seconds or
// milliseconds?) and guessing wrong by a factor of 1000 turns a 2-minute
// proposal into a 33-hour one. Date-only strings ("2026-09-30") are rejected
// for a subtler reason: they have no timezone, so the same stored value means a
// different instant on a machine in Nairobi than on one in Denver, and the
// error is a whole day. Every timestamp in this repo is written with
// toISOString(), so nothing legitimate is turned away.
//
// A BACKWARDS CLOCK IS NOT A BREACH. CLAUDE.md's BREAK list names clock skew
// and daylight-savings transitions explicitly. If `at` lands before
// `startedAt`, the elapsed time is negative, and the one thing we must not do
// is report that as an overrun - an advisor paged about a "-4 minute delay"
// learns nothing and stops trusting the pages. So negative elapsed is clamped
// to zero and reported as on time, with `clockWentBackwards` set so the
// condition is visible rather than swallowed. Clamping without the flag would
// be the quiet-fix version of the empty catch block CLAUDE.md forbids.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? judgeElapsed returns { ok: false, reason }.
//     It never throws and never guesses a timestamp: an unreadable clock must
//     not silently become "on time", because that is the answer that suppresses
//     the notification the advisor is owed.
//  2. Will it retry? There is nothing to retry. No I/O, no external call, no
//     clock read - the caller supplies both instants.
//  3. Recovery path? The caller decides. proposalStore.js treats an
//     unjudgeable clock as a breach it cannot rule out, and says so, rather
//     than defaulting to the comfortable answer.
//  4. Handled here: non-string and malformed timestamps, date-only strings,
//     NaN dates, the exact boundary, negative elapsed, and elapsed far beyond
//     the budget. NOT handled: leap seconds (JS has no concept of them), the
//     SLA being configurable per customer (one number until someone asks for
//     two), and business-hours arithmetic - 30 minutes here is 30 minutes of
//     wall clock, not 30 minutes of the advisor's working day.

// The number from REQ-003. Named, exported, and used by every caller, so that
// changing the budget is one edit in one file.
const SLA_MINUTES = 30;
const SLA_MS = SLA_MINUTES * 60 * 1000;

const STATES = Object.freeze({
  WITHIN_SLA: "within_sla",
  BREACHED: "sla_breached",
});

const REASONS = Object.freeze({
  UNUSABLE_STARTED_AT: "unusable_started_at",
  UNUSABLE_NOW: "unusable_now",
});

// An ISO-8601 instant: date, T, time, and an explicit offset. The offset is the
// part that matters - see the header on why a date-only string is refused. The
// year, month and day are captured because the day has to be checked by hand;
// see isRealCalendarDay.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// WHY THIS EXISTS, AND IT IS NOT DEFENSIVE PROGRAMMING. Date.parse rejects an
// out-of-range month or hour ("2026-13-01T00:00:00Z" is NaN) but SILENTLY ROLLS
// OVER an out-of-range day: "2026-02-31T00:00:00Z" parses happily as March 3rd,
// and "2026-02-29T00:00:00Z" in a non-leap year becomes March 1st. That is a
// three-day slide arriving as a valid-looking number, which is exactly the kind
// of quiet wrong answer this module refuses to produce. The test that caught
// this is in proposalClock.test.js and stays there.
//
// The day fields are checked as written, in whatever offset the string states,
// which is correct: "2026-02-31" is not a date in any timezone.
function isRealCalendarDay(year, month, day) {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= limit;
}

// Three checks, and each one catches something the others do not. The regex
// rejects the wrong SHAPE, the calendar check rejects a day that does not exist,
// and Date.parse rejects the remaining impossible VALUES (hour 25, minute 61).
function isInstant(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    return false;
  }
  return (
    isRealCalendarDay(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number.isFinite(Date.parse(value))
  );
}

function toMs(value) {
  return isInstant(value) ? Date.parse(value) : null;
}

// When this proposal is due. Returned to the caller so an advisor's client can
// count down to a deadline the server computed, rather than adding 30 minutes
// itself and disagreeing with us by whatever its own clock is out by.
function deadlineFor(startedAt) {
  const started = toMs(startedAt);
  return started === null ? null : new Date(started + SLA_MS).toISOString();
}

// THE JUDGMENT. Given when a proposal started and what time it is now, returns
// everything a caller needs to state the SLA position:
//
//   { ok: true, state, breached, elapsedMs, remainingMs, overdueMs,
//     slaMinutes, deadlineAt, clockWentBackwards }
//
// or { ok: false, reason } when a timestamp cannot be read.
//
// `remainingMs` and `overdueMs` are both floored at zero and exactly one of
// them is ever non-zero. Callers get to render "22 minutes left" or "9 minutes
// over" without doing signed arithmetic and without having to remember which
// sign means which.
function judgeElapsed({ startedAt, at }) {
  const started = toMs(startedAt);
  if (started === null) {
    // The reason names the FIELD, never its value: a malformed timestamp can
    // arrive from a request body and these reasons reach logs and responses.
    return { ok: false, reason: REASONS.UNUSABLE_STARTED_AT };
  }
  const now = toMs(at);
  if (now === null) {
    return { ok: false, reason: REASONS.UNUSABLE_NOW };
  }

  const rawElapsedMs = now - started;
  const clockWentBackwards = rawElapsedMs < 0;
  const elapsedMs = clockWentBackwards ? 0 : rawElapsedMs;

  // Strictly greater - the boundary belongs to "on time". See the header.
  const breached = elapsedMs > SLA_MS;

  return {
    ok: true,
    state: breached ? STATES.BREACHED : STATES.WITHIN_SLA,
    breached: breached,
    elapsedMs: elapsedMs,
    remainingMs: breached ? 0 : SLA_MS - elapsedMs,
    overdueMs: breached ? elapsedMs - SLA_MS : 0,
    slaMinutes: SLA_MINUTES,
    deadlineAt: new Date(started + SLA_MS).toISOString(),
    clockWentBackwards: clockWentBackwards,
  };
}

// THE SAME JUDGMENT, IN THE SHAPE A RECORD STORES. Lives here rather than in
// proposalStore.js so that it cannot drift from the arithmetic above, which is
// the only way this could go quietly wrong.
//
// STORED, NOT DERIVED, and that is the point: "this proposal took 41 minutes"
// is a historical fact about a finished piece of work. Recomputing it from
// startedAt on every later read would give a number that grows forever, so a
// proposal issued comfortably on time would look breached by the next morning.
//
// AN UNREADABLE CLOCK IS RECORDED AS A BREACH. Of the two ways to be wrong,
// "on time" is the one that suppresses a notification the advisor is owed, so
// the unknown case reports a breach, says so with slaUnknown, and invents no
// figures - elapsedMs stays null rather than becoming a plausible zero.
function judgeSlaForRecord(startedAt, completedAt) {
  const judged = judgeElapsed({ startedAt: startedAt, at: completedAt });
  if (!judged.ok) {
    return {
      state: STATES.BREACHED,
      breached: true,
      slaUnknown: true,
      reason: judged.reason,
      elapsedMs: null,
      // null, not zero. "No time left" is a claim; "we cannot tell" is the
      // truth, and a zero here would render as a countdown that has run out.
      remainingMs: null,
      overdueMs: null,
      slaMinutes: SLA_MINUTES,
      deadlineAt: deadlineFor(startedAt),
      clockWentBackwards: false,
    };
  }
  return {
    state: judged.state,
    breached: judged.breached,
    slaUnknown: false,
    reason: null,
    elapsedMs: judged.elapsedMs,
    // Carried through, not dropped: this is what an advisor's client counts
    // down, and it is the whole value of showing them a thirty-minute target.
    remainingMs: judged.remainingMs,
    overdueMs: judged.overdueMs,
    slaMinutes: judged.slaMinutes,
    deadlineAt: judged.deadlineAt,
    clockWentBackwards: judged.clockWentBackwards,
  };
}

// THE SLA POSITION OF A PROPOSAL, whichever kind it is.
//
// An ISSUED proposal carries its own verdict, recorded at the instant it was
// issued, and that stored verdict is the answer - see judgeSlaForRecord above
// on why it must not be recomputed. An OPEN draft has no verdict yet, so it is
// judged against `at`: that is what lets an advisor see "eighteen minutes left"
// on a draft, and the sweep page them about one that is late RIGHT NOW rather
// than only once it eventually completes.
//
// Lives here, and is used by both the notifier and the HTTP read, because the
// two must never disagree about whether a proposal is late. When this was
// private to the notifier the read had no way to ask the same question, and the
// obvious fix - a second copy in the route - is how a dashboard ends up showing
// "on time" for a proposal the advisor was just paged about.
function slaPositionFor(proposal, at) {
  if (!proposal || typeof proposal !== "object") {
    return null;
  }
  if (proposal.sla && typeof proposal.sla === "object") {
    return proposal.sla;
  }
  return judgeSlaForRecord(proposal.startedAt, at);
}

module.exports = {
  judgeElapsed,
  judgeSlaForRecord,
  slaPositionFor,
  deadlineFor,
  isInstant,
  SLA_MINUTES,
  SLA_MS,
  STATES,
  REASONS,
};
