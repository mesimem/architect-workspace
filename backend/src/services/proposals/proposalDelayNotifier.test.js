// STORY-013, acceptance criterion 2:
//   "Given a trip proposal, when it exceeds 30 minutes, then the advisor should
//    be notified of the delay."
//
// The lifecycle suite proves completion CALLS this. This suite proves what it
// does when called: who gets paged, who does not, what the page says, what it
// must never say, and what happens when the channel is slow, broken or has
// already been used for this proposal.
//
// THE CASE THIS FILE EXISTS FOR is the last one: dedup through the audit log
// rather than an in-memory Set, so that a restart cannot re-page an advisor
// about a delay they were already told about. That is the difference between
// this notifier and advisor/advisorNotifier.js, and it is only visible in a
// test that swaps the "have we already paged?" store out from underneath it.

const assert = require("assert");

const {
  notifyProposalDelay,
  sweepBreachedProposals,
  defaultDelayNotifier,
  getOutbox,
  __clearOutboxForTests,
  EVENTS,
  STATUSES,
} = require("./proposalDelayNotifier");
const { SLA_MINUTES } = require("./proposalClock");

const OPENED_AT = "2026-09-30T09:00:00.000Z";
const LATE_AT = "2026-09-30T09:41:00.000Z";

// An issued proposal carrying its own recorded verdict, as completeProposal
// leaves it.
function issuedProposal(overrides) {
  return {
    proposalId: "proposal_ab12cd34",
    customerId: "cust_42",
    status: "issued",
    startedAt: OPENED_AT,
    completedAt: LATE_AT,
    openedBy: "advisor_ada",
    completedBy: "advisor_ada",
    customerNote: "Mum's wheelchair, flight AB123",
    internalNotes: "margin thin here",
    sla: {
      state: "sla_breached",
      breached: true,
      slaUnknown: false,
      elapsedMs: 2460000,
      overdueMs: 660000, // 11 minutes
      slaMinutes: 30,
      deadlineAt: "2026-09-30T09:30:00.000Z",
      clockWentBackwards: false,
    },
    ...overrides,
  };
}

// An OPEN draft, which has no verdict yet - the sweep's input.
function openDraft(overrides) {
  return {
    proposalId: "proposal_open0001",
    customerId: "cust_77",
    status: "drafting",
    startedAt: OPENED_AT,
    completedAt: null,
    openedBy: "advisor_bo",
    completedBy: null,
    sla: null,
    ...overrides,
  };
}

// A notifier that records what it was handed. Never a real channel.
function channelSpy() {
  const sent = [];
  const spy = async function (message) {
    sent.push(message);
    return { delivered: true };
  };
  spy.sent = sent;
  return spy;
}

function auditSpy() {
  const entries = [];
  const spy = function (entry) {
    entries.push(entry);
    return { entry: entry, replayed: false };
  };
  spy.entries = entries;
  return spy;
}

// Stands in for the durable audit log's hasAuditEntry, backed by a set the test
// controls - which is what lets "already paged, then restarted" be written down.
function dedupStore(keys) {
  const seen = new Set(keys || []);
  const has = function (key) {
    return seen.has(key);
  };
  has.seen = seen;
  return has;
}

const never = dedupStore();

async function main() {
  // HAPPY PATH. A proposal eleven minutes past its target pages its advisor,
  // once, and the audit trail records that the page went out.
  {
    const channel = channelSpy();
    const audit = auditSpy();
    const result = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: channel,
      audit: audit,
      alreadyNotified: never,
      correlationId: "corr-done-0001",
    });
    assert.strictEqual(result.status, STATUSES.NOTIFIED);
    assert.strictEqual(result.notified, true);
    assert.strictEqual(result.replayed, false);
    assert.strictEqual(result.deduped, true);
    assert.strictEqual(channel.sent.length, 1);

    const entry = audit.entries[0];
    assert.strictEqual(entry.event, EVENTS.NOTIFIED);
    assert.strictEqual(entry.outcome, "success");
    assert.strictEqual(entry.resource, "proposal_ab12cd34");
    assert.strictEqual(entry.correlationId, "corr-done-0001");
    assert.strictEqual(entry.context.overdueMs, 660000);
    console.log("proposalDelayNotifier: a late proposal pages its advisor and records the page");
  }

  // THE PAGE SAYS HOW LATE, IN MINUTES AN ADVISOR CAN ACT ON. 660,000ms is not
  // a sentence.
  {
    const channel = channelSpy();
    await notifyProposalDelay({ proposal: issuedProposal(), notify: channel, audit: auditSpy(), alreadyNotified: never });
    const message = channel.sent[0];
    assert.strictEqual(message.overdueMinutes, 11);
    assert.strictEqual(message.slaMinutes, SLA_MINUTES);
    assert.strictEqual(message.proposalId, "proposal_ab12cd34");
    assert.strictEqual(message.customerId, "cust_42");
    assert.strictEqual(message.advisor, "advisor_ada");
    assert.strictEqual(message.deadlineAt, "2026-09-30T09:30:00.000Z");
    assert.ok(message.subject.includes("11 minutes past its 30-minute target"));
    console.log("proposalDelayNotifier: the page states the overrun in whole minutes");
  }

  // Singular, because "1 minutes" is the kind of detail that makes an
  // automated page look automated. A 30-second overrun rounds UP to 1, never
  // down to 0 - "0 minutes over" would read as a false alarm.
  {
    const channel = channelSpy();
    await notifyProposalDelay({
      proposal: issuedProposal({ sla: { ...issuedProposal().sla, overdueMs: 30000 } }),
      notify: channel,
      audit: auditSpy(),
      alreadyNotified: never,
    });
    assert.strictEqual(channel.sent[0].overdueMinutes, 1);
    assert.ok(channel.sent[0].subject.includes("1 minute past"), channel.sent[0].subject);
    console.log("proposalDelayNotifier: a part-minute overrun rounds up, and reads as singular");
  }

  // THE PAGE CARRIES NO CUSTOMER PROSE. It travels over a channel this repo
  // does not control, and the advisor reads the full proposal on their desk.
  {
    const channel = channelSpy();
    await notifyProposalDelay({ proposal: issuedProposal(), notify: channel, audit: auditSpy(), alreadyNotified: never });
    const serialised = JSON.stringify(channel.sent[0]);
    assert.ok(!serialised.includes("wheelchair"), "no customer prose in the page");
    assert.ok(!serialised.includes("AB123"));
    assert.ok(!serialised.includes("margin thin"), "nor internal commentary");
    console.log("proposalDelayNotifier: the page carries ids and figures, never note text");
  }

  // AN ON-TIME PROPOSAL PAGES NOBODY, and this is checked here rather than
  // trusted from the caller: a false delay alert teaches an advisor to ignore
  // the channel, which costs more than the alert it saved.
  {
    const channel = channelSpy();
    const onTime = issuedProposal({
      sla: { ...issuedProposal().sla, breached: false, state: "within_sla", overdueMs: 0 },
    });
    const result = await notifyProposalDelay({ proposal: onTime, notify: channel, audit: auditSpy(), alreadyNotified: never });
    assert.strictEqual(result.status, STATUSES.NOT_LATE);
    assert.strictEqual(result.notified, false);
    assert.strictEqual(channel.sent.length, 0);
    console.log("proposalDelayNotifier: an on-time proposal is not paged about");
  }

  // AN OPEN DRAFT IS JUDGED AGAINST NOW, because it has no verdict yet. This is
  // what lets the sweep page an advisor about a draft that is late RIGHT NOW,
  // rather than only once it eventually completes.
  {
    const channel = channelSpy();
    const stillFine = await notifyProposalDelay({
      proposal: openDraft(),
      at: "2026-09-30T09:20:00.000Z", // 20 minutes in
      notify: channel,
      audit: auditSpy(),
      alreadyNotified: never,
    });
    assert.strictEqual(stillFine.status, STATUSES.NOT_LATE);

    const nowLate = await notifyProposalDelay({
      proposal: openDraft(),
      at: "2026-09-30T09:45:00.000Z", // 45 minutes in
      notify: channel,
      audit: auditSpy(),
      alreadyNotified: never,
    });
    assert.strictEqual(nowLate.status, STATUSES.NOTIFIED);
    assert.strictEqual(channel.sent[0].overdueMinutes, 15);
    assert.strictEqual(channel.sent[0].status, "drafting");
    assert.strictEqual(channel.sent[0].completedAt, null, "it has not finished - that is the point");
    console.log("proposalDelayNotifier: an open draft is judged against the present moment");
  }

  // AN UNREADABLE CLOCK PAGES, AND SAYS SO. It does not invent a figure, and it
  // does not stay quiet: "we cannot tell how late this is" needs someone to
  // look at the record, not just work faster.
  {
    const channel = channelSpy();
    const result = await notifyProposalDelay({
      proposal: openDraft({ startedAt: "not-a-time" }),
      at: LATE_AT,
      notify: channel,
      audit: auditSpy(),
      alreadyNotified: never,
    });
    assert.strictEqual(result.status, STATUSES.NOTIFIED);
    assert.strictEqual(channel.sent[0].overdueMinutes, null, "no invented figure");
    assert.strictEqual(channel.sent[0].slaUnknown, true);
    assert.ok(channel.sent[0].subject.includes("unreadable delivery clock"));
    console.log("proposalDelayNotifier: an unreadable clock pages, flagged as unknown");
  }

  // ------------------------------------------- IDEMPOTENCY, THE MAIN EVENT ----
  // ALREADY PAGED MEANS NOT PAGED AGAIN, and the check happens BEFORE the call,
  // so a replay never reaches the channel at all.
  {
    const channel = channelSpy();
    const audit = auditSpy();
    const proposal = issuedProposal();
    // The key the first page would have written, as if it already had.
    const already = dedupStore(["proposal_ab12cd34:" + EVENTS.NOTIFIED]);

    const result = await notifyProposalDelay({ proposal: proposal, notify: channel, audit: audit, alreadyNotified: already });
    assert.strictEqual(result.status, STATUSES.ALREADY_NOTIFIED);
    assert.strictEqual(result.notified, true, "the advisor HAS been told - just not by this call");
    assert.strictEqual(result.replayed, true);
    assert.strictEqual(result.attempts, 0);
    assert.strictEqual(channel.sent.length, 0, "the channel was never reached");
    assert.strictEqual(audit.entries.length, 0, "and nothing was written twice");
    console.log("proposalDelayNotifier: a proposal already paged about is not paged again");
  }

  // THE DEDUP SURVIVES A RESTART, which is the whole reason the key lives in
  // the audit log rather than in a Set. Written here as two calls sharing a
  // durable store while everything else is thrown away - which is exactly what
  // a process restart is.
  {
    const durable = dedupStore();
    const audit = function (entry) {
      durable.seen.add(entry.auditKey); // what recordAudit does, durably
      return { entry: entry, replayed: false };
    };

    const beforeRestart = channelSpy();
    const first = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: beforeRestart,
      audit: audit,
      alreadyNotified: durable,
    });
    assert.strictEqual(first.status, STATUSES.NOTIFIED);
    assert.strictEqual(beforeRestart.sent.length, 1);

    // ...process dies, comes back with a brand-new channel and no memory.
    const afterRestart = channelSpy();
    const second = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: afterRestart,
      audit: audit,
      alreadyNotified: durable,
    });
    assert.strictEqual(second.status, STATUSES.ALREADY_NOTIFIED);
    assert.strictEqual(afterRestart.sent.length, 0, "a restart must not re-page yesterday's delay");
    console.log("proposalDelayNotifier: the dedup key is durable, so a restart pages nobody twice");
  }

  // A FAILED PAGE IS NOT RECORDED AS DELIVERED, so the next attempt tries
  // again. This is the trade stated in the module header: a duplicate page is a
  // nuisance, a suppressed page is the missed alert the criterion exists for.
  {
    const durable = dedupStore();
    const audit = function (entry) {
      durable.seen.add(entry.auditKey);
      return { entry: entry, replayed: false };
    };
    const broken = async function () {
      throw new Error("pager unreachable at https://pager.test/?token=abcd1234");
    };

    const failed = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: broken,
      audit: audit,
      alreadyNotified: durable,
    });
    assert.strictEqual(failed.status, STATUSES.FAILED);
    assert.strictEqual(failed.notified, false);
    assert.strictEqual(failed.errorClass, "UpstreamUnavailable");
    assert.ok(!JSON.stringify(failed).includes("abcd1234"), "no credential in the result");

    // The failure IS in the trail, under its own key...
    assert.ok(durable.seen.has("proposal_ab12cd34:" + EVENTS.FAILED), "the failed page is recorded");
    assert.ok(
      !durable.seen.has("proposal_ab12cd34:" + EVENTS.NOTIFIED),
      "and NOT under the delivered key, which is what would suppress the retry"
    );
    // ...and that record does NOT block the retry.
    const retry = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: channelSpy(),
      audit: audit,
      alreadyNotified: durable,
    });
    assert.strictEqual(retry.status, STATUSES.NOTIFIED, "the retry pages, it is not suppressed");
    console.log("proposalDelayNotifier: a failed page is recorded but does not block the retry");
  }

  // A HANGING CHANNEL TIMES OUT AND RETRIES, CAPPED. A page that waits forever
  // holds the advisor's completion response open behind it.
  {
    let calls = 0;
    const hangs = function () {
      calls += 1;
      return new Promise(function () {});
    };
    const result = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: hangs,
      audit: auditSpy(),
      alreadyNotified: never,
      timeoutMs: 20,
      maxAttempts: 2,
    });
    assert.strictEqual(result.status, STATUSES.FAILED);
    assert.strictEqual(result.errorClass, "TimeoutError");
    assert.strictEqual(calls, 2, "one call plus one retry");
    console.log("proposalDelayNotifier: a channel that hangs times out and retries once");
  }

  // AN AUDIT FAILURE AFTER A DELIVERED PAGE REPORTS THE PAGE AS SENT, because
  // it was. Claiming otherwise would be a lie the caller acts on. What it does
  // report is that the page is NOT deduped, so a retry may page again.
  {
    const channel = channelSpy();
    const result = await notifyProposalDelay({
      proposal: issuedProposal(),
      notify: channel,
      audit: function () {
        throw new Error("audit store unavailable");
      },
      alreadyNotified: never,
    });
    assert.strictEqual(result.status, STATUSES.NOTIFIED, "the page went out");
    assert.strictEqual(result.notified, true);
    assert.strictEqual(result.deduped, false, "but it is not deduped, and says so");
    assert.strictEqual(channel.sent.length, 1);
    console.log("proposalDelayNotifier: an unaudited page is still reported as sent, and flagged");
  }

  // AN UNUSABLE PROPOSAL REFUSES INSTEAD OF THROWING. This runs after a
  // committed completion; an exception here would surface as a 500 on a request
  // that actually succeeded.
  {
    for (const proposal of [null, undefined, "proposal_1", 7, {}, { proposalId: "" }]) {
      const result = await notifyProposalDelay({
        proposal: proposal,
        notify: channelSpy(),
        audit: auditSpy(),
        alreadyNotified: never,
      });
      assert.strictEqual(result.status, STATUSES.INVALID_PROPOSAL, "refused: " + JSON.stringify(proposal));
      assert.strictEqual(result.notified, false);
    }
    console.log("proposalDelayNotifier: an unusable proposal refuses without throwing");
  }

  // ------------------------------------------------------------- THE SWEEP ----
  // Pages every late open draft, counts what happened, and does not stop on a
  // failure - a scheduled job that abandons the queue on the first bad row
  // leaves every later advisor un-paged for reasons unrelated to their work.
  {
    const durable = dedupStore();
    const audit = function (entry) {
      durable.seen.add(entry.auditKey);
      return { entry: entry, replayed: false };
    };
    let call = 0;
    const flaky = async function (message) {
      call += 1;
      if (call === 2) {
        throw new Error("channel blipped");
      }
      return { delivered: true, to: message.proposalId };
    };

    const summary = await sweepBreachedProposals({
      proposals: [
        openDraft({ proposalId: "proposal_late00001" }),
        openDraft({ proposalId: "proposal_late00002" }),
        openDraft({ proposalId: "proposal_late00003" }),
      ],
      at: "2026-09-30T09:45:00.000Z",
      notify: flaky,
      audit: audit,
      alreadyNotified: durable,
    });
    assert.strictEqual(summary.considered, 3);
    assert.strictEqual(summary.notified, 2);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(call, 3, "the third was still attempted after the second failed");
    console.log("proposalDelayNotifier: the sweep pages every late draft and survives one failure");
  }

  // THE SWEEP IS SAFE TO RUN ON A SCHEDULE. Running it twice pages nobody a
  // second time - which is the property that lets a cron fire it every minute.
  {
    const durable = dedupStore();
    const audit = function (entry) {
      durable.seen.add(entry.auditKey);
      return { entry: entry, replayed: false };
    };
    const args = {
      proposals: [openDraft({ proposalId: "proposal_late00004" })],
      at: "2026-09-30T09:45:00.000Z",
      audit: audit,
      alreadyNotified: durable,
    };
    const first = await sweepBreachedProposals({ ...args, notify: channelSpy() });
    const again = await sweepBreachedProposals({ ...args, notify: channelSpy() });
    assert.strictEqual(first.notified, 1);
    assert.strictEqual(again.notified, 0);
    assert.strictEqual(again.alreadyNotified, 1);
    console.log("proposalDelayNotifier: running the sweep twice pages nobody twice");
  }

  // An empty or absent queue is a no-op, not a crash - the ordinary case for a
  // scheduled job, since most minutes nothing is late.
  {
    for (const proposals of [[], null, undefined, "nope"]) {
      const summary = await sweepBreachedProposals({ proposals: proposals, notify: channelSpy(), audit: auditSpy(), alreadyNotified: never });
      assert.strictEqual(summary.considered, 0);
      assert.strictEqual(summary.notified, 0);
    }
    console.log("proposalDelayNotifier: an empty sweep is a no-op");
  }

  // THE DEFAULT CHANNEL IS AN IN-MEMORY OUTBOX, NOT A REAL ONE. Asserted so
  // that wiring a real channel in cannot happen silently: this test would have
  // to be changed deliberately.
  {
    __clearOutboxForTests();
    const delivered = await defaultDelayNotifier({ proposalId: "proposal_outbox01" });
    assert.strictEqual(delivered.channel, "in-memory-outbox");
    assert.strictEqual(getOutbox().length, 1);
    // A copy, so a reader cannot rewrite what was sent.
    const read = getOutbox();
    read[0].proposalId = "tampered";
    assert.strictEqual(getOutbox()[0].proposalId, "proposal_outbox01");
    __clearOutboxForTests();
    console.log("proposalDelayNotifier: the default channel is an in-memory outbox, read-only");
  }

  console.log("proposalDelayNotifier: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
