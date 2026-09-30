// STORY-013, the lifecycle and the clock. Acceptance criteria 1 and 2:
//   AC-1 "Given a new trip request, when a travel advisor creates a proposal,
//        then it should be completed within 30 minutes."
//   AC-2 "Given a trip proposal, when it exceeds 30 minutes, then the advisor
//        should be notified of the delay."
// This file proves the BREACH IS DETECTED AND RECORDED, for a finished proposal
// and for one still open; the paging itself is proposalDelayNotifier.test.js.
// AC-3 (the audit trail) is proposals.audit.test.js, the assemble boundary is
// proposalAssembly.test.js, and the crash path is proposals.durability.test.js.
//
// Also here: two of the story's named failure paths - incorrect trip details,
// and a generation timeout seen from the store's side, which is the side that
// matters to the advisor (their draft is still there).

const assert = require("assert");

const {
  startProposal,
  completeProposal,
  getProposalForStaff,
  listBreachedOpenProposals,
  STATUSES,
  EVENTS,
  REASONS,
} = require("./proposalStore");
const { SLA_MS, STATES } = require("./proposalClock");
const {
  fakeStore,
  auditSpy,
  notifierSpy,
  clockAt,
  tripDetails,
  OPENED_AT,
  ON_TIME_AT,
  LATE_AT,
} = require("./proposalFixtures");

function openDraft(store, audit, correlationId, startedAt) {
  return startProposal(
    {
      customerId: "cust_42",
      tripReference: "TRIP-9001",
      title: "Tanzania",
      actor: "advisor_ada",
      correlationId: correlationId,
    },
    { store: store, audit: audit, now: clockAt([startedAt || OPENED_AT]) }
  );
}

// Issues a draft at an explicit instant. `options` carries anything unusual -
// different details, a different advisor, an assemble stub, a notifier to watch.
//
// A notifier spy is injected WHETHER OR NOT the test asked for one, so that no
// block in this file can reach the real notifier's module-level outbox. Without
// that, every late completion here would quietly page through the real module
// and the suite's behaviour would depend on the order its blocks happen to run.
function issueAt(store, audit, proposalId, at, correlationId, options) {
  const extra = options || {};
  return completeProposal(
    {
      proposalId: proposalId,
      details: extra.details === undefined ? tripDetails() : extra.details,
      // `=== undefined`, not `||`: a test that deliberately passes an empty
      // actor must get the empty one, not the default.
      actor: extra.actor === undefined ? "advisor_ada" : extra.actor,
      correlationId: correlationId,
    },
    {
      store: store,
      audit: audit,
      now: clockAt([at]),
      notifyDelay: extra.notifier || notifierSpy(),
      ...(extra.opts || {}),
    }
  );
}

async function main() {
  // ---------------------------------------------------------------- AC-1 ----
  // HAPPY PATH. A draft opened at 09:00 and issued at 09:12 is within the
  // thirty-minute budget, and the record says so in figures, not adjectives.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0001");
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(opened.proposal.status, STATUSES.DRAFTING);
    assert.strictEqual(opened.proposal.startedAt, OPENED_AT);
    assert.strictEqual(opened.proposal.version, 1);
    assert.strictEqual(opened.proposal.pricing, null, "a draft has no price yet");

    const issued = await issueAt(store, audit, opened.proposal.proposalId, ON_TIME_AT, "corr-done-0001");
    assert.strictEqual(issued.ok, true);
    assert.strictEqual(issued.proposal.status, STATUSES.ISSUED);
    assert.strictEqual(issued.proposal.version, 2);
    assert.strictEqual(issued.sla.breached, false);
    assert.strictEqual(issued.sla.state, STATES.WITHIN_SLA);
    assert.strictEqual(issued.sla.elapsedMs, 720000); // 12 minutes, by hand
    assert.strictEqual(issued.sla.overdueMs, 0);
    assert.strictEqual(issued.sla.deadlineAt, "2026-09-30T09:30:00.000Z");
    // The price comes from STORY-007's pricer, so a proposal cannot disagree
    // with a quote about money. Checked by hand: 1,000,000 + 20,000.
    assert.strictEqual(issued.proposal.pricing.totalCents, 1020000);
    console.log("proposalStore: a proposal opened and issued inside 30 minutes is within the SLA");
  }

  // THE CLOCK IS NEVER REWRITTEN BY COMPLETION. If completion re-stamped
  // startedAt, every proposal would be issued in zero minutes and AC-1 would
  // pass vacuously forever. This is the assertion that makes the criterion mean
  // something.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0002");
    const issued = await issueAt(store, audit, opened.proposal.proposalId, LATE_AT, "corr-done-0002");
    assert.strictEqual(issued.proposal.startedAt, OPENED_AT, "startedAt must survive completion untouched");
    assert.strictEqual(issued.proposal.completedAt, LATE_AT);
    console.log("proposalStore: completion never moves the start instant");
  }

  // ---------------------------------------------------------------- AC-2 ----
  // A LATE PROPOSAL IS STILL ISSUED, and it is marked. Throwing away 41 minutes
  // of an advisor's work to satisfy a timer would leave the client with nothing.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0003");
    const issued = await issueAt(store, audit, opened.proposal.proposalId, LATE_AT, "corr-done-0003");
    assert.strictEqual(issued.ok, true, "a late proposal still issues");
    assert.strictEqual(issued.proposal.status, STATUSES.ISSUED);
    assert.strictEqual(issued.sla.breached, true);
    assert.strictEqual(issued.sla.state, STATES.BREACHED);
    assert.strictEqual(issued.sla.overdueMs, 660000); // 11 minutes over, by hand
    assert.strictEqual(issued.sla.slaUnknown, false);
    console.log("proposalStore: a 41-minute proposal issues, flagged as a breach 11 minutes over");
  }

  // AC-2, THE WIRING. The page is part of completion, not something a route
  // remembers to ask for - so a late completion pages, and an on-time one does
  // not. A notification that fires only when a caller thinks of it is one
  // forgotten call site away from an advisor never being told.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const late = notifierSpy();
    const onTime = notifierSpy();

    const lateDraft = openDraft(store, audit, "corr-open-0030");
    const lateIssue = await issueAt(store, audit, lateDraft.proposal.proposalId, LATE_AT, "corr-done-0030", { notifier: late });
    assert.strictEqual(late.calls.length, 1, "a late proposal pages its advisor");
    assert.strictEqual(late.calls[0].proposal.proposalId, lateDraft.proposal.proposalId);
    assert.strictEqual(late.calls[0].at, LATE_AT, "and pages about the completion instant");
    assert.strictEqual(late.calls[0].correlationId, "corr-done-0030", "traceable to the request");
    // The outcome is reported back, so a route can log it rather than guess.
    assert.strictEqual(lateIssue.delayNotification.notified, true);

    const fineDraft = openDraft(store, audit, "corr-open-0031");
    const fineIssue = await issueAt(store, audit, fineDraft.proposal.proposalId, ON_TIME_AT, "corr-done-0031", { notifier: onTime });
    assert.strictEqual(onTime.calls.length, 0, "an on-time proposal pages nobody");
    assert.strictEqual(fineIssue.delayNotification, null);
    console.log("proposalStore: a late completion pages the advisor; an on-time one does not");
  }

  // A BROKEN NOTIFIER MUST NOT UNDO A FINISHED PROPOSAL. The page is an alert;
  // the proposal is the advisor's work. Rolling one back to protect the other
  // would be the wrong way round.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0032");
    const explodes = async function () {
      throw new Error("pager on fire");
    };
    const issued = await issueAt(store, audit, opened.proposal.proposalId, LATE_AT, "corr-done-0032", { notifier: explodes });
    assert.strictEqual(issued.ok, true, "the proposal is still issued");
    assert.strictEqual(issued.proposal.status, STATUSES.ISSUED);
    assert.strictEqual(issued.delayNotification.notified, false, "and the failed page is reported, not hidden");
    assert.ok(!JSON.stringify(issued.delayNotification).includes("on fire"), "without leaking the error");
    console.log("proposalStore: a notifier that throws is reported and does not undo the issue");
  }

  // THE ELAPSED TIME IS A HISTORICAL FACT, STORED, NOT RECOMPUTED. Read back
  // days later it is still 12 minutes. Derived from startedAt on every read it
  // would grow forever, and an on-time proposal would look breached by morning.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0004");
    await issueAt(store, audit, opened.proposal.proposalId, ON_TIME_AT, "corr-done-0004");
    const later = getProposalForStaff({ proposalId: opened.proposal.proposalId }, { store: store });
    assert.strictEqual(later.sla.elapsedMs, 720000, "still twelve minutes, however long ago it was");
    assert.strictEqual(later.sla.breached, false);
    console.log("proposalStore: the elapsed time is recorded once and does not drift upwards");
  }

  // THE OTHER HALF OF AC-2: A DRAFT THAT IS ALREADY LATE, still open. Nothing
  // would ever page anyone if the only check ran at completion - a proposal
  // abandoned at minute 12 and picked up at minute 90 has been late for an hour.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const late = openDraft(store, audit, "corr-open-0005", "2026-09-30T08:00:00.000Z"); // 100 min
    const fresh = openDraft(store, audit, "corr-open-0006", "2026-09-30T09:35:00.000Z"); // 5 min
    const finished = openDraft(store, audit, "corr-open-0007", "2026-09-30T07:00:00.000Z");
    await issueAt(store, audit, finished.proposal.proposalId, "2026-09-30T07:10:00.000Z", "corr-done-0007");

    const breached = listBreachedOpenProposals({ at: "2026-09-30T09:40:00.000Z" }, { store: store });
    const ids = breached.map(function (p) {
      return p.proposalId;
    });
    assert.deepStrictEqual(ids, [late.proposal.proposalId], "only the open, late one");
    assert.ok(!ids.includes(fresh.proposal.proposalId), "a five-minute-old draft is not late");
    assert.ok(!ids.includes(finished.proposal.proposalId), "an issued proposal is not an open breach");
    console.log("proposalStore: an open draft past its deadline is listed as a breach");
  }

  // AN UNREADABLE CLOCK IS TREATED AS A BREACH, NOT AS "ON TIME". Of the two
  // ways to be wrong, silently reporting on time is the one that suppresses the
  // page the advisor is owed.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0008");
    // A corrupt row - the shape a hand-edited or half-written store file has.
    store.set(opened.proposal.proposalId, { ...opened.proposal, startedAt: "not-a-time" });

    const issued = await issueAt(store, audit, opened.proposal.proposalId, ON_TIME_AT, "corr-done-0008");
    assert.strictEqual(issued.ok, true);
    assert.strictEqual(issued.sla.breached, true, "cannot rule out a breach, so report one");
    assert.strictEqual(issued.sla.slaUnknown, true);
    assert.strictEqual(issued.sla.elapsedMs, null, "no invented figure");
    console.log("proposalStore: an unjudgeable clock reports a breach rather than guessing");
  }

  // An open draft with an unreadable clock is listed too, for the same reason.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0009");
    store.set(opened.proposal.proposalId, { ...opened.proposal, startedAt: null });
    const listed = listBreachedOpenProposals({ at: ON_TIME_AT }, { store: store });
    assert.strictEqual(listed.length, 1, "not knowing is not a reason to stay quiet");
    console.log("proposalStore: an open draft with an unreadable clock is listed as a breach");
  }

  // ------------------------------------------------- FAILURE: IDEMPOTENCY ----
  // A RETRIED START MUST NOT OPEN A SECOND CLOCK. Two drafts for one trip
  // request means the advisor is paged about the one nobody is working on.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const first = openDraft(store, audit, "corr-open-0014");
    const retry = openDraft(store, audit, "corr-open-0014", "2026-09-30T09:25:00.000Z");
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.replayed, true);
    assert.strictEqual(retry.proposal.proposalId, first.proposal.proposalId);
    assert.strictEqual(retry.proposal.startedAt, OPENED_AT, "the retry did not restart the clock");
    assert.strictEqual(store.size, 1);
    assert.strictEqual(audit.eventsFor(EVENTS.OPENED).length, 1, "and did not audit twice");
    console.log("proposalStore: a retried start returns the first draft, clock untouched");
  }

  // A DOUBLE-CLICKED COMPLETE DOES NOT ISSUE TWICE OR BUMP THE VERSION TWICE.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0015");
    const id = opened.proposal.proposalId;
    const once = await issueAt(store, audit, id, ON_TIME_AT, "corr-done-0015");
    const twice = await issueAt(store, audit, id, "2026-09-30T09:50:00.000Z", "corr-done-0015");
    assert.strictEqual(twice.ok, true);
    assert.strictEqual(twice.replayed, true);
    assert.strictEqual(twice.proposal.version, 2, "still version 2");
    assert.strictEqual(twice.sla.elapsedMs, once.sla.elapsedMs, "and the recorded duration did not move");
    assert.strictEqual(audit.eventsFor(EVENTS.ISSUED).length, 1);
    console.log("proposalStore: a resubmitted completion replays instead of re-issuing");
  }

  // RE-ISSUING A FINISHED PROPOSAL IS REFUSED. A new correlation id is a new
  // request, and it must not be allowed to rewrite whether this proposal met
  // REQ-003.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0016");
    const id = opened.proposal.proposalId;
    await issueAt(store, audit, id, ON_TIME_AT, "corr-done-0016");
    const again = await issueAt(store, audit, id, LATE_AT, "corr-done-0016-b");
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, REASONS.ALREADY_ISSUED);
    const stored = getProposalForStaff({ proposalId: id }, { store: store });
    assert.strictEqual(stored.sla.elapsedMs, 720000, "the recorded 12 minutes stands");
    assert.strictEqual(audit.eventsFor(EVENTS.REFUSED).length, 1, "and the refusal is audited");
    console.log("proposalStore: an issued proposal cannot be re-issued into a better SLA");
  }

  // --------------------------------------- FAILURE: INCORRECT TRIP DETAILS ----
  // Judged by STORY-007's pricer, and the draft survives so the advisor can fix
  // the form and resubmit - the clock is still running, which is the honest
  // outcome: their correction is part of the thirty minutes.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0017");
    const id = opened.proposal.proposalId;
    const bad = await issueAt(store, audit, id, ON_TIME_AT, "corr-done-0017", {
      details: tripDetails({
        lines: [{ label: "Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: -2 }],
      }),
    });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, REASONS.INVALID_DETAILS);
    assert.ok(bad.problems.length > 0, "every problem at once, so the form is fixed in one pass");

    const draft = getProposalForStaff({ proposalId: id }, { store: store });
    assert.strictEqual(draft.status, STATUSES.DRAFTING, "the draft is untouched");
    assert.strictEqual(draft.pricing, null, "and no half-price was left on it");

    // ...and the corrected resubmission goes through.
    const fixed = await issueAt(store, audit, id, ON_TIME_AT, "corr-done-0017-b");
    assert.strictEqual(fixed.ok, true);
    assert.strictEqual(fixed.proposal.pricing.totalCents, 1020000);
    console.log("proposalStore: trip details that do not price are refused, and the draft survives");
  }

  // Empty and non-object detail sets are the same refusal, not a crash.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0018");
    for (const details of [null, "lines", [], {}, { lines: [] }, { lines: "safari" }]) {
      const result = await issueAt(store, audit, opened.proposal.proposalId, ON_TIME_AT,
        "corr-done-0018-" + String(details), { details: details });
      assert.strictEqual(result.ok, false, "refused: " + JSON.stringify(details));
      assert.strictEqual(result.reason, REASONS.INVALID_DETAILS);
    }
    console.log("proposalStore: a missing or malformed detail set refuses without throwing");
  }

  // ---------------------------------- FAILURE: PROPOSAL GENERATION TIMEOUT ----
  // The assemble boundary hangs. What matters here is what the ADVISOR sees:
  // their draft is exactly as it was, nothing priced, clock still running,
  // still completable. The boundary's own retry behaviour is tested next door
  // in proposalAssembly.test.js.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0019");
    const id = opened.proposal.proposalId;
    const timedOut = await issueAt(store, audit, id, ON_TIME_AT, "corr-done-0019", {
      opts: { assemble: function () { return new Promise(function () {}); }, timeoutMs: 20, maxAttempts: 2 },
    });
    assert.strictEqual(timedOut.ok, false);
    assert.strictEqual(timedOut.reason, REASONS.GENERATION_TIMEOUT);

    const draft = getProposalForStaff({ proposalId: id }, { store: store });
    assert.strictEqual(draft.status, STATUSES.DRAFTING);
    assert.strictEqual(draft.version, 1);
    assert.strictEqual(draft.startedAt, OPENED_AT, "the clock kept running through the timeout");
    assert.strictEqual(audit.eventsFor(EVENTS.ISSUED).length, 0, "nothing was issued");
    assert.strictEqual(audit.eventsFor(EVENTS.REFUSED).length, 1, "and the refusal is audited");

    // The retry after the dependency recovers completes normally.
    const recovered = await issueAt(store, audit, id, ON_TIME_AT, "corr-done-0019-b", {
      opts: { assemble: async function (d) { return d; }, timeoutMs: 20 },
    });
    assert.strictEqual(recovered.ok, true);
    console.log("proposalStore: an assembly that hangs leaves the draft intact, and can be retried");
  }

  // A SUCCESSFUL ASSEMBLY'S OUTPUT IS WHAT GETS PRICED - otherwise the hook
  // would be decorative, wired up and changing nothing.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-open-0022");
    const enriched = await issueAt(store, audit, opened.proposal.proposalId, ON_TIME_AT, "corr-done-0022", {
      opts: {
        assemble: async function (details) {
          return {
            ...details,
            lines: details.lines.concat([
              { label: "Park fees", unitCostCents: 5000, unitSellCents: 8000, quantity: 2 },
            ]),
          };
        },
        timeoutMs: 50,
      },
    });
    assert.strictEqual(enriched.ok, true);
    assert.strictEqual(enriched.proposal.pricing.lines.length, 3);
    assert.strictEqual(enriched.proposal.pricing.totalCents, 1036000); // 1,020,000 + 16,000
    console.log("proposalStore: what the assembly returns is what gets priced");
  }

  // ------------------------------------------------ FAILURE: BAD REQUESTS ----
  {
    const store = fakeStore();
    const audit = auditSpy();

    const noCustomer = startProposal(
      { customerId: "", actor: "advisor_ada", correlationId: "corr-open-0023" },
      { store: store, audit: audit }
    );
    assert.strictEqual(noCustomer.reason, REASONS.INVALID_REQUEST);
    assert.strictEqual(noCustomer.problems.length, 1);

    const noActor = startProposal(
      { customerId: "cust_42", actor: null, correlationId: "corr-open-0024" },
      { store: store, audit: audit }
    );
    assert.strictEqual(noActor.reason, REASONS.INVALID_REQUEST);

    // Both problems at once, not one per attempt.
    const neither = startProposal({ correlationId: "corr-open-0025" }, { store: store, audit: audit });
    assert.strictEqual(neither.problems.length, 2);

    // Our plumbing, not the caller's - server.js always supplies one.
    const noCorrelation = startProposal({ customerId: "cust_42", actor: "advisor_ada" }, { store: store, audit: audit });
    assert.strictEqual(noCorrelation.reason, REASONS.MISSING_CORRELATION_ID);

    assert.strictEqual(store.size, 0, "no draft was opened by any of those");

    const unknown = await issueAt(store, audit, "proposal_nope", ON_TIME_AT, "corr-done-0026");
    assert.strictEqual(unknown.reason, REASONS.UNKNOWN_PROPOSAL);

    const noId = await issueAt(store, audit, "", ON_TIME_AT, "corr-done-0027");
    assert.strictEqual(noId.reason, REASONS.UNKNOWN_PROPOSAL, "an unusable id reads as unknown");

    const noIssuer = await issueAt(store, audit, "proposal_nope", ON_TIME_AT, "corr-done-0027-b", { actor: "" });
    assert.strictEqual(noIssuer.reason, REASONS.INVALID_REQUEST);
    console.log("proposalStore: missing ids, actors and correlation ids each refuse, and audit it");
  }

  // A READ FOR AN UNUSABLE ID IS null, NOT A THROW.
  {
    const store = fakeStore();
    for (const id of [undefined, null, "", "x".repeat(200), {}]) {
      assert.strictEqual(getProposalForStaff({ proposalId: id }, { store: store }), null);
    }
    console.log("proposalStore: a read for an unusable id is null, never an exception");
  }

  // THE BOUNDARY, END TO END. Exactly 30:00.000 is on time; one millisecond
  // later is not. SLA_MS is used here so the test cannot drift from the module.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const startMs = Date.parse(OPENED_AT);

    const onMark = openDraft(store, audit, "corr-open-0028");
    const atLimit = await issueAt(store, audit, onMark.proposal.proposalId,
      new Date(startMs + SLA_MS).toISOString(), "corr-done-0028");
    assert.strictEqual(atLimit.sla.breached, false, "thirty minutes exactly meets REQ-003");

    const overMark = openDraft(store, audit, "corr-open-0029");
    const overLimit = await issueAt(store, audit, overMark.proposal.proposalId,
      new Date(startMs + SLA_MS + 1).toISOString(), "corr-done-0029");
    assert.strictEqual(overLimit.sla.breached, true, "one millisecond later is a breach");
    console.log("proposalStore: the SLA boundary holds end to end, to the millisecond");
  }

  console.log("proposalStore: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
