// STORY-013, acceptance criterion 3:
//   "Trust: Given any trip proposal, when it is created, then an audit log
//    entry must be created."
// and the project-wide guardrail it comes from: "the system must maintain audit
// logs for all transactions and changes."
//
// WHY THIS IS A SEPARATE SUITE. The criterion is not "an audit function is
// called somewhere". It is that a proposal CANNOT EXIST unaudited - which is
// only provable by breaking the audit log and checking that nothing was left
// behind. Those cases need a failing audit and a lossy store, so they read
// nothing like the lifecycle suite next door, which needs both to work.
//
// The other half of "system crash during proposal creation" is here too: a
// store that accepts a write and loses it. That is the silent version, and the
// silent version was always the dangerous one - the advisor sees a
// confirmation and the row is not there.

const assert = require("assert");

const { startProposal, completeProposal, getProposalForStaff, STATUSES, EVENTS, REASONS } = require("./proposalStore");
const {
  fakeStore,
  droppingStore,
  auditSpy,
  failingAudit,
  notifierSpy,
  clockAt,
  tripDetails,
  OPENED_AT,
  ON_TIME_AT,
  LATE_AT,
} = require("./proposalFixtures");

function openDraft(store, audit, correlationId) {
  return startProposal(
    { customerId: "cust_42", tripReference: "TRIP-9001", actor: "advisor_ada", correlationId: correlationId },
    { store: store, audit: audit, now: clockAt([OPENED_AT]) }
  );
}

async function main() {
  // BOTH ACTS ARE AUDITED, AND UNDER DIFFERENT KEYS. Keyed on the proposal id
  // alone, the audit log's first-write-wins rule would keep the opening and
  // silently discard the issue - the exact opposite of what this criterion asks
  // for. The key carries the version, so v1 and v2 are two entries.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-audit-0001");
    assert.strictEqual(audit.eventsFor(EVENTS.OPENED).length, 1);

    const openEntry = audit.eventsFor(EVENTS.OPENED)[0];
    assert.strictEqual(openEntry.outcome, "success");
    assert.strictEqual(openEntry.actor, "advisor_ada");
    assert.strictEqual(openEntry.resource, opened.proposal.proposalId);
    assert.strictEqual(openEntry.correlationId, "corr-audit-0001");
    // The deadline is in the trail from the first instant, so "was this
    // proposal ever going to be on time?" is answerable from the log alone.
    assert.strictEqual(openEntry.context.startedAt, OPENED_AT);
    assert.strictEqual(openEntry.context.deadlineAt, "2026-09-30T09:30:00.000Z");
    assert.strictEqual(openEntry.context.slaMinutes, 30);

    await completeProposal(
      { proposalId: opened.proposal.proposalId, details: tripDetails(), actor: "advisor_bo", correlationId: "corr-audit-0002" },
      // A spy, so this suite's only late completion cannot page through the
      // real notifier's module-level outbox. What it sends is tested in
      // proposalDelayNotifier.test.js; here it must simply not escape.
      { store: store, audit: audit, now: clockAt([LATE_AT]), notifyDelay: notifierSpy() }
    );
    const issueEntry = audit.eventsFor(EVENTS.ISSUED)[0];
    assert.strictEqual(issueEntry.actor, "advisor_bo", "the issue records who issued it, not who opened it");
    assert.strictEqual(issueEntry.context.elapsedMs, 2460000); // 41 minutes
    assert.strictEqual(issueEntry.context.slaBreached, true);
    assert.strictEqual(issueEntry.context.slaState, "sla_breached");
    assert.strictEqual(issueEntry.context.totalCents, 1020000);
    assert.notStrictEqual(openEntry.auditKey, issueEntry.auditKey, "two acts, two keys");
    console.log("proposals.audit: opening and issuing are each audited, with distinct keys");
  }

  // THE SLA BREACH IS IN THE TRAIL, not only on the record. A breach that is
  // only a field on a row is a breach that disappears the moment someone edits
  // the row; in the append-only trail it is evidence.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-audit-0003");
    await completeProposal(
      { proposalId: opened.proposal.proposalId, details: tripDetails(), actor: "advisor_ada", correlationId: "corr-audit-0004" },
      { store: store, audit: audit, now: clockAt([ON_TIME_AT]) }
    );
    const entry = audit.eventsFor(EVENTS.ISSUED)[0];
    assert.strictEqual(entry.context.slaBreached, false);
    assert.strictEqual(entry.context.elapsedMs, 720000);
    assert.strictEqual(entry.context.startedAt, OPENED_AT);
    assert.strictEqual(entry.context.completedAt, ON_TIME_AT);
    console.log("proposals.audit: the trail carries both instants and the elapsed time");
  }

  // THE AUDIT CONTEXT CARRIES NO FREE TEXT. Notes can quote a customer, and the
  // audit trail persists to disk forever - a stray detail here outlives the
  // booking, the customer relationship and the advisor who typed it.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-audit-0005");
    await completeProposal(
      {
        proposalId: opened.proposal.proposalId,
        details: tripDetails({ customerNote: "Mum's wheelchair, flight AB123", internalNotes: "margin thin here" }),
        actor: "advisor_ada",
        correlationId: "corr-audit-0006",
      },
      { store: store, audit: audit, now: clockAt([ON_TIME_AT]) }
    );
    const serialised = JSON.stringify(audit.entries);
    assert.ok(!serialised.includes("wheelchair"), "customer prose must not reach the audit trail");
    assert.ok(!serialised.includes("AB123"));
    assert.ok(!serialised.includes("margin thin"), "nor internal commentary");
    // ...but it IS on the proposal itself, where the advisor needs it.
    const stored = getProposalForStaff({ proposalId: opened.proposal.proposalId }, { store: store });
    assert.strictEqual(stored.customerNote, "Mum's wheelchair, flight AB123");
    console.log("proposals.audit: the trail records figures and ids; the notes stay on the proposal");
  }

  // A REFUSAL IS AUDITED TOO. A log that only records successes cannot answer
  // the question an audit trail exists to answer - what happened to the
  // proposal that is missing?
  {
    const store = fakeStore();
    const audit = auditSpy();
    const refused = startProposal(
      { customerId: "", actor: "advisor_ada", correlationId: "corr-audit-0007" },
      { store: store, audit: audit }
    );
    assert.strictEqual(refused.ok, false);
    const entry = audit.eventsFor(EVENTS.REFUSED)[0];
    assert.strictEqual(entry.outcome, "failure");
    assert.strictEqual(entry.context.reason, REASONS.INVALID_REQUEST);
    // The REASON, never the submitted body: a rejected request can carry a
    // customer's details.
    assert.deepStrictEqual(Object.keys(entry.context), ["reason"]);
    console.log("proposals.audit: a refusal is recorded, with its reason and nothing else");
  }

  // AN UNAUDITED PROPOSAL MUST NOT EXIST. When the audit throws on the way in,
  // the write is rolled back: no draft, no clock, nothing to find later.
  {
    const store = fakeStore();
    const opened = openDraft(store, failingAudit(), "corr-audit-0008");
    assert.strictEqual(opened.ok, false);
    assert.strictEqual(opened.reason, REASONS.AUDIT_UNAVAILABLE);
    assert.strictEqual(store.size, 0, "the unaudited draft was rolled back");
    // 503-shaped, not 400-shaped: the request was not at fault and the right
    // client behaviour is to try again.
    assert.ok(opened.problems[0].includes("try again"));
    console.log("proposals.audit: a draft that cannot be audited is not left behind");
  }

  // The same rule on the way out, with the rollback restoring the DRAFT rather
  // than deleting the row - the advisor's work is still there to re-issue.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-audit-0009");
    const issued = await completeProposal(
      { proposalId: opened.proposal.proposalId, details: tripDetails(), actor: "advisor_ada", correlationId: "corr-audit-0010" },
      { store: store, audit: failingAudit(), now: clockAt([ON_TIME_AT]) }
    );
    assert.strictEqual(issued.ok, false);
    assert.strictEqual(issued.reason, REASONS.AUDIT_UNAVAILABLE);

    const after = getProposalForStaff({ proposalId: opened.proposal.proposalId }, { store: store });
    assert.strictEqual(after.status, STATUSES.DRAFTING, "rolled back to the draft, not deleted");
    assert.strictEqual(after.version, 1);
    assert.strictEqual(after.pricing, null, "and no half-issued price was left on it");
    assert.strictEqual(after.startedAt, OPENED_AT, "and the clock is intact");
    console.log("proposals.audit: an unauditable issue rolls back to the open draft");
  }

  // A FAILING AUDIT ON A REFUSAL DOES NOT CHANGE THE REFUSAL. Turning a 400
  // into a 503 because the audit log hiccuped while recording something that
  // changed nothing would be the worse trade.
  {
    const store = fakeStore();
    const refused = startProposal(
      { customerId: "", actor: "advisor_ada", correlationId: "corr-audit-0011" },
      { store: store, audit: failingAudit() }
    );
    assert.strictEqual(refused.reason, REASONS.INVALID_REQUEST, "still the caller's error, not ours");
    console.log("proposals.audit: an audit failure on a refusal leaves the refusal as it was");
  }

  // -------------------------------------------- FAILURE: SAVE NOT DURABLE ----
  // A store that takes the write and loses it must not report success.
  {
    const dropped = openDraft(droppingStore(), auditSpy(), "corr-audit-0012");
    assert.strictEqual(dropped.ok, false);
    assert.strictEqual(dropped.reason, REASONS.NOT_SAVED);
    assert.ok(dropped.problems[0].includes("Nothing was changed"));
    console.log("proposals.audit: a write that does not persist is not called a success");
  }

  // A store that keeps the OLD version is caught too - not just one that keeps
  // nothing. This is the shape a partially-applied write has.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const opened = openDraft(store, audit, "corr-audit-0013");
    const draft = opened.proposal;
    // Accepts the v2 write, hands back v1 on read-back.
    const stale = { ...store, set: function () { return this; }, get: function () { return draft; } };

    const issued = await completeProposal(
      { proposalId: draft.proposalId, details: tripDetails(), actor: "advisor_ada", correlationId: "corr-audit-0014" },
      { store: stale, audit: audit, now: clockAt([ON_TIME_AT]) }
    );
    assert.strictEqual(issued.ok, false);
    assert.strictEqual(issued.reason, REASONS.NOT_SAVED);
    assert.strictEqual(audit.eventsFor(EVENTS.ISSUED).length, 0, "and it was never audited as issued");
    console.log("proposals.audit: a store that keeps the old version is caught by the read-back");
  }

  console.log("proposals.audit: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
