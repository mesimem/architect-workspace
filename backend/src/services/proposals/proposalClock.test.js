// STORY-013, the arithmetic half. These tests exist because the 30-minute
// budget in REQ-003 decides two of the three acceptance criteria, and the two
// ways it can be wrong are both invisible on screen: an off-by-one-millisecond
// boundary, and a negative elapsed time rendered as a delay.
//
// Every case here is written as literal timestamps rather than by adding
// SLA_MS to a base. A test that recomputes the implementation's formula cannot
// catch the formula being wrong.

const assert = require("assert");

const {
  judgeElapsed,
  judgeSlaForRecord,
  slaPositionFor,
  deadlineFor,
  isInstant,
  SLA_MINUTES,
  SLA_MS,
  STATES,
  REASONS,
} = require("./proposalClock");

const START = "2026-09-30T09:00:00.000Z";

function main() {
  // THE NUMBER FROM REQ-003, asserted rather than assumed. If someone edits
  // the budget without a requirement change, this is what says so.
  assert.strictEqual(SLA_MINUTES, 30);
  assert.strictEqual(SLA_MS, 1800000); // 30 * 60 * 1000, by hand
  console.log("proposalClock: the budget is the 30 minutes REQ-003 asks for");

  // HAPPY PATH - AC-1. A proposal finished twelve minutes in is on time, with
  // eighteen minutes left on the clock.
  const onTime = judgeElapsed({ startedAt: START, at: "2026-09-30T09:12:00.000Z" });
  assert.strictEqual(onTime.ok, true);
  assert.strictEqual(onTime.state, STATES.WITHIN_SLA);
  assert.strictEqual(onTime.breached, false);
  assert.strictEqual(onTime.elapsedMs, 720000); // 12 minutes
  assert.strictEqual(onTime.remainingMs, 1080000); // 18 minutes
  assert.strictEqual(onTime.overdueMs, 0);
  assert.strictEqual(onTime.deadlineAt, "2026-09-30T09:30:00.000Z");
  assert.strictEqual(onTime.clockWentBackwards, false);
  console.log("proposalClock: a twelve-minute proposal is within the budget");

  // AC-2. Forty-one minutes is a breach, eleven minutes over.
  const late = judgeElapsed({ startedAt: START, at: "2026-09-30T09:41:00.000Z" });
  assert.strictEqual(late.state, STATES.BREACHED);
  assert.strictEqual(late.breached, true);
  assert.strictEqual(late.elapsedMs, 2460000); // 41 minutes
  assert.strictEqual(late.overdueMs, 660000); // 11 minutes over
  assert.strictEqual(late.remainingMs, 0);
  console.log("proposalClock: a forty-one-minute proposal breaches, by eleven minutes");

  // EXACTLY ONE OF remainingMs / overdueMs IS EVER NON-ZERO. Stated as an
  // invariant so a future change cannot leave a caller rendering both
  // "18 minutes left" and "11 minutes over" on the same proposal.
  [onTime, late].forEach(function (judged) {
    assert.ok(judged.remainingMs === 0 || judged.overdueMs === 0);
  });
  console.log("proposalClock: a proposal is never both early and late");

  // THE BOUNDARY, AT THE MILLISECOND, ON BOTH SIDES. This is the case the
  // module exists to get right: "within 30 minutes" includes the mark.
  const atTheMark = judgeElapsed({ startedAt: START, at: "2026-09-30T09:30:00.000Z" });
  assert.strictEqual(atTheMark.breached, false, "exactly 30:00.000 is within the budget");
  assert.strictEqual(atTheMark.remainingMs, 0);
  assert.strictEqual(atTheMark.overdueMs, 0);

  const oneMsUnder = judgeElapsed({ startedAt: START, at: "2026-09-30T09:29:59.999Z" });
  assert.strictEqual(oneMsUnder.breached, false);
  assert.strictEqual(oneMsUnder.remainingMs, 1);

  const oneMsOver = judgeElapsed({ startedAt: START, at: "2026-09-30T09:30:00.001Z" });
  assert.strictEqual(oneMsOver.breached, true, "30:00.001 is the first breaching millisecond");
  assert.strictEqual(oneMsOver.overdueMs, 1);
  console.log("proposalClock: the boundary is inclusive, to the millisecond, on both sides");

  // ZERO ELAPSED. A proposal completed in the same millisecond it started is
  // not a breach and has the whole budget left - the degenerate case a
  // fast-path or a cached result would hit.
  const instant = judgeElapsed({ startedAt: START, at: START });
  assert.strictEqual(instant.breached, false);
  assert.strictEqual(instant.elapsedMs, 0);
  assert.strictEqual(instant.remainingMs, SLA_MS);
  console.log("proposalClock: zero elapsed is on time with the full budget left");

  // FAILURE PATH - A BACKWARDS CLOCK IS NOT A BREACH. CLAUDE.md's BREAK list
  // names clock skew and DST. Elapsed clamps to zero, the proposal reads as on
  // time, and the condition is FLAGGED rather than swallowed.
  const skewed = judgeElapsed({ startedAt: START, at: "2026-09-30T08:56:00.000Z" });
  assert.strictEqual(skewed.ok, true);
  assert.strictEqual(skewed.clockWentBackwards, true);
  assert.strictEqual(skewed.elapsedMs, 0, "negative elapsed clamps to zero");
  assert.strictEqual(skewed.breached, false, "a backwards clock must never read as a delay");
  assert.strictEqual(skewed.overdueMs, 0);
  console.log("proposalClock: a clock that runs backwards reads as on time, and says so");

  // A DST TRANSITION IS NOT SPECIAL, BECAUSE BOTH INSTANTS CARRY AN OFFSET.
  // 01:50 EST is 06:50Z; 02:10 EDT the same night is 06:10Z. Wall-clock
  // subtraction would say twenty minutes; these are real instants, so the
  // answer is that the second one came FIRST - caught as skew, not as a breach.
  const dst = judgeElapsed({
    startedAt: "2026-03-08T01:50:00.000-05:00",
    at: "2026-03-08T03:10:00.000-04:00",
  });
  assert.strictEqual(dst.ok, true);
  assert.strictEqual(dst.elapsedMs, 1200000, "twenty real minutes across the spring-forward");
  assert.strictEqual(dst.breached, false);
  console.log("proposalClock: a spring-forward transition measures twenty real minutes");

  // A PROPOSAL THAT RAN FOR DAYS still judges rather than overflowing.
  const abandoned = judgeElapsed({ startedAt: START, at: "2026-10-03T09:00:00.000Z" });
  assert.strictEqual(abandoned.breached, true);
  assert.strictEqual(abandoned.elapsedMs, 259200000); // 3 days
  console.log("proposalClock: a three-day-old draft judges without overflowing");

  // FAILURE PATH - AN UNREADABLE CLOCK REFUSES. It must not default to "on
  // time": that is the answer that suppresses the notification AC-2 requires.
  const badStarts = [undefined, null, "", "yesterday", 1759219200000, "2026-09-30", {}, NaN,
    // The last three are days that do not exist. They matter because Date.parse
    // does NOT reject them - it rolls them forward, so "Feb 31" arrives as a
    // perfectly usable March 3rd and the clock is silently three days out.
    "2026-02-31T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-31T00:00:00Z"];
  badStarts.forEach(function (value) {
    const judged = judgeElapsed({ startedAt: value, at: START });
    assert.strictEqual(judged.ok, false, "refused: " + JSON.stringify(value));
    assert.strictEqual(judged.reason, REASONS.UNUSABLE_STARTED_AT);
    assert.strictEqual(judged.breached, undefined, "a refusal states no SLA position at all");
  });
  console.log("proposalClock: an unreadable start refuses instead of guessing 'on time'");

  // The same for `at`, with its own reason - the two are told apart so a log
  // line says which clock we could not read.
  const badNow = judgeElapsed({ startedAt: START, at: "not-a-time" });
  assert.strictEqual(badNow.ok, false);
  assert.strictEqual(badNow.reason, REASONS.UNUSABLE_NOW);
  console.log("proposalClock: an unreadable 'now' is a distinct, named refusal");

  // A NUMBER IS REFUSED EVEN THOUGH Date WOULD TAKE IT. Seconds-vs-milliseconds
  // is the mistake this rules out; guessing wrong turns 2 minutes into 33 hours.
  assert.strictEqual(isInstant(Date.parse(START)), false);
  assert.strictEqual(isInstant(START), true);
  assert.strictEqual(isInstant("2026-09-30T09:00:00Z"), true, "seconds precision is fine");
  assert.strictEqual(isInstant("2026-09-30T09:00Z"), true, "minute precision is fine");
  assert.strictEqual(isInstant("2026-09-30T09:00:00"), false, "no offset means no instant");
  // The calendar check must not overshoot: a real leap day is a real date.
  assert.strictEqual(isInstant("2028-02-29T09:00:00.000Z"), true, "2028 is a leap year");
  assert.strictEqual(isInstant("2000-02-29T09:00:00.000Z"), true, "2000 is a leap year too");
  assert.strictEqual(isInstant("1900-02-29T09:00:00.000Z"), false, "1900 is not");
  console.log("proposalClock: a timestamp is an ISO instant with an offset, or nothing");

  // THE DEADLINE THE SERVER COMPUTES. Exported so a client counts down to our
  // number rather than adding thirty minutes to its own clock.
  assert.strictEqual(deadlineFor(START), "2026-09-30T09:30:00.000Z");
  assert.strictEqual(deadlineFor("nonsense"), null, "no start, no deadline - not a guess");
  console.log("proposalClock: the deadline is the server's to state");

  // PURITY. Two calls with the same arguments give the same answer, and no
  // hidden clock read can make them differ. This is what lets the store and the
  // notifier judge one proposal independently and always agree.
  assert.deepStrictEqual(
    judgeElapsed({ startedAt: START, at: "2026-09-30T09:41:00.000Z" }),
    late
  );
  console.log("proposalClock: the same two instants always judge the same way");

  // ------------------------------------------- THE VERDICT, AS IT IS STORED ----
  // judgeSlaForRecord is what lands on a proposal, so every field a caller
  // renders has to be there. remainingMs was missing from the first version of
  // this function and nothing failed - the HTTP suite caught it, because it is
  // the only caller that actually renders a countdown. Hence this test.
  {
    const onTime = judgeSlaForRecord(START, "2026-09-30T09:12:00.000Z");
    assert.strictEqual(onTime.breached, false);
    assert.strictEqual(onTime.elapsedMs, 720000);
    assert.strictEqual(onTime.remainingMs, 1080000, "eighteen minutes left, for the countdown");
    assert.strictEqual(onTime.overdueMs, 0);
    assert.strictEqual(onTime.slaUnknown, false);
    assert.strictEqual(onTime.deadlineAt, "2026-09-30T09:30:00.000Z");

    const late = judgeSlaForRecord(START, "2026-09-30T09:41:00.000Z");
    assert.strictEqual(late.breached, true);
    assert.strictEqual(late.remainingMs, 0);
    assert.strictEqual(late.overdueMs, 660000);

    // THE UNKNOWN CASE REPORTS A BREACH AND INVENTS NOTHING. Every figure is
    // null rather than zero: a zero remainingMs would render as a countdown
    // that has run out, which is a claim we cannot support.
    const unknown = judgeSlaForRecord("not-a-time", START);
    assert.strictEqual(unknown.breached, true, "cannot rule out a breach, so report one");
    assert.strictEqual(unknown.slaUnknown, true);
    assert.strictEqual(unknown.elapsedMs, null);
    assert.strictEqual(unknown.remainingMs, null);
    assert.strictEqual(unknown.overdueMs, null);
    assert.strictEqual(unknown.deadlineAt, null);
    assert.strictEqual(unknown.reason, REASONS.UNUSABLE_STARTED_AT, "and says which clock failed");
    console.log("proposalClock: the stored verdict carries every figure, or honest nulls");
  }

  // slaPositionFor: an ISSUED proposal answers from its stored verdict, an OPEN
  // draft is judged against now. Both the notifier and the HTTP read call this,
  // so a dashboard and a page cannot disagree about one proposal.
  {
    const issued = {
      startedAt: START,
      sla: { breached: true, elapsedMs: 2460000, overdueMs: 660000, frozen: "yes" },
    };
    const position = slaPositionFor(issued, "2026-10-05T09:00:00.000Z");
    assert.strictEqual(position.elapsedMs, 2460000, "days later, still 41 minutes");
    assert.strictEqual(position.frozen, "yes", "it is the stored object, not a recomputation");

    const draft = { startedAt: START, sla: null };
    const early = slaPositionFor(draft, "2026-09-30T09:20:00.000Z");
    assert.strictEqual(early.breached, false);
    assert.strictEqual(early.remainingMs, 600000, "ten minutes left");

    const nowLate = slaPositionFor(draft, "2026-09-30T09:45:00.000Z");
    assert.strictEqual(nowLate.breached, true, "the same draft, judged later, is late");
    assert.strictEqual(nowLate.overdueMs, 900000);

    for (const notAProposal of [null, undefined, "proposal_1", 7]) {
      assert.strictEqual(slaPositionFor(notAProposal, START), null);
    }
    console.log("proposalClock: an issued proposal answers from the record, a draft from the clock");
  }

  console.log("proposalClock: all tests passed");
}

main();
