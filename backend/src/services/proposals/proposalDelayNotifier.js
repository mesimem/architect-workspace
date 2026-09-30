// STORY-013, acceptance criterion 2: tell the advisor their proposal is late.
//
// NOTHING HERE SENDS A REAL MESSAGE. The default notifier appends to an
// in-memory outbox, exactly as advisor/advisorNotifier.js does. Wiring a real
// channel (Mandrill, Basecamp, a queue) needs credentials this repo
// deliberately does not hold, and CLAUDE.md forbids workers sending real
// communications during tests. When a real channel arrives it goes in behind
// the same injected `notify` argument, so everything below - the timeout, the
// retries, the idempotency, the failure contract - applies to it unchanged.
//
// THE DEDUP KEY IS THE AUDIT LOG, NOT AN IN-MEMORY SET. advisorNotifier.js
// keeps a Set, which is honest for a flag that is itself in memory. It would be
// wrong here: the whole point of this story's crash path is that a proposal's
// clock survives a restart, so a restart must not also re-page every advisor
// whose proposal was already late. The audit log is durable, append-only and
// first-write-wins, which is precisely a dedup store - so "have we paged about
// this proposal?" is `hasAuditEntry(key)`, and it is still true after a reboot.
//
// THE ENTRY IS WRITTEN AFTER A CONFIRMED SEND, AND THAT ORDERING IS A CHOICE.
// Writing it first (write-ahead, outcome "pending") would make a duplicate page
// impossible - but if the send then failed, the key would exist forever and the
// advisor would NEVER be paged, with the trail claiming otherwise. Writing it
// after leaves a small window: crash between send and audit, and the advisor
// gets one duplicate page. That is the better failure. A duplicate page is a
// nuisance; a suppressed page is the missed SLA alert this criterion exists to
// deliver. Same reasoning as advisorNotifier.js, where a failed notification is
// deliberately not recorded as delivered so a later call tries again.
//
// ONE PAGE PER PROPOSAL, NOT ONE PER EVENT. The key carries the proposal id
// and nothing else, so a proposal that is paged by the sweep at minute 31 is
// not paged again when the advisor finally issues it at minute 90. The advisor
// has already been told this proposal is late; telling them twice is noise, and
// noisy pages are ignored pages.
//
// IT WILL NOT PAGE ABOUT AN ON-TIME PROPOSAL. Checked here rather than trusted
// from the caller, because a false delay alert is worse than a late one: it
// teaches the advisor to ignore the channel.
//
// WHY THE SWEEP TAKES RECORDS RATHER THAN READING THEM. proposalStore.js
// requires this module, so this module must not require it back - CLAUDE.md
// calls a cycle a missing third module, and here the honest answer is that the
// caller already knows which drafts are late (listBreachedOpenProposals) and
// passing them in keeps this file a leaf.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? The PROPOSAL IS UNAFFECTED. It is already
//     committed and its breach is already in the audit trail before anything
//     here runs, so a failed page loses an alert, never the record of the
//     delay. Callers get a status and never an exception.
//  2. Will it retry? Only on timeout, capped - the shared policy in
//     shared/callWithRetry.js. A notifier that throws is not retried.
//  3. Recovery when retries are exhausted? The next call tries again, because
//     a failure is deliberately not recorded as delivered. The failure IS
//     recorded under its own key, so the trail shows a page that never landed,
//     and the sweep will find the proposal again while it stays open. There is
//     no dead-letter store yet, and inventing one before there is a real
//     channel to fail against would be pretend machinery.
//  4. Handled here: an unusable proposal, an on-time proposal, an unreadable
//     clock, a notifier that hangs, one that throws, one already paged, and an
//     audit log that fails while recording the page. NOT handled: a notifier
//     that reports success and silently drops the message (undetectable without
//     delivery receipts from a real channel), two processes paging concurrently
//     for one proposal (single-process store; the real fix is a unique
//     constraint in Postgres, as everywhere else in this repo), and escalation
//     to anyone above the advisor when a proposal is late by hours rather than
//     minutes - nobody has specified who that would be.

const { recordAudit, deriveAuditKey, hasAuditEntry } = require("../audit/auditLog");
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  callWithRetry,
  classifyFailure,
  logFailure,
} = require("../shared/callWithRetry");
// slaPositionFor answers "is this late?" for an issued proposal and an open
// draft alike. Shared with the HTTP read so a dashboard and a page cannot
// disagree about one proposal.
const { slaPositionFor, SLA_MINUTES } = require("./proposalClock");

const SERVICE_NAME = "proposal-delay-notify";

const EVENTS = Object.freeze({
  NOTIFIED: "proposal.delay_notified",
  FAILED: "proposal.delay_notify_failed",
});

const STATUSES = Object.freeze({
  NOTIFIED: "notified",
  ALREADY_NOTIFIED: "already_notified",
  NOT_LATE: "not_late",
  INVALID_PROPOSAL: "invalid_proposal",
  FAILED: "notification_failed",
});

// Stand-in for a real channel. Exported so tests and the demo can read what
// would have been sent.
const OUTBOX = [];

async function defaultDelayNotifier(message) {
  OUTBOX.push(message);
  return { delivered: true, channel: "in-memory-outbox" };
}

function getOutbox() {
  return OUTBOX.map(function (message) {
    return { ...message };
  });
}

// Tests only - the outbox is process-local and has no business being cleared
// over HTTP.
function __clearOutboxForTests() {
  OUTBOX.length = 0;
}

function isUsableProposal(proposal) {
  return (
    proposal !== null &&
    typeof proposal === "object" &&
    typeof proposal.proposalId === "string" &&
    proposal.proposalId.trim() !== ""
  );
}

// Whole minutes, rounded up, because "0 minutes over" is not a sentence an
// advisor can act on. null when the clock could not be read - we would rather
// say nothing than state a made-up figure.
function overdueMinutes(overdueMs) {
  return typeof overdueMs === "number" ? Math.max(1, Math.ceil(overdueMs / 60000)) : null;
}

// Only the facts an advisor needs to act. NO FREE TEXT: customerNote and
// internalNotes are unsanitised prose that may quote the customer, and the
// advisor reads the full proposal on their desk anyway. Same rule as
// advisorNotifier.buildMessage.
function buildMessage(proposal, sla) {
  const minutes = overdueMinutes(sla.overdueMs);
  return {
    proposalId: proposal.proposalId,
    customerId: proposal.customerId,
    advisor: proposal.completedBy || proposal.openedBy,
    status: proposal.status,
    startedAt: proposal.startedAt,
    deadlineAt: sla.deadlineAt,
    completedAt: proposal.completedAt || null,
    slaMinutes: SLA_MINUTES,
    overdueMinutes: minutes,
    // Distinguishes "late by 11 minutes" from "we cannot tell how late" - the
    // second needs someone to look at the record, not just work faster.
    slaUnknown: sla.slaUnknown === true,
    subject:
      minutes === null
        ? "Trip proposal " + proposal.proposalId + " has an unreadable delivery clock"
        : "Trip proposal " +
          proposal.proposalId +
          " is " +
          minutes +
          " minute" +
          (minutes === 1 ? "" : "s") +
          " past its " +
          SLA_MINUTES +
          "-minute target",
  };
}

// Records that the page landed. This IS the dedup store, so the key carries the
// proposal id alone - see the header on why one page per proposal.
function auditKeyFor(proposalId, event) {
  return deriveAuditKey(proposalId, event);
}

// Pages the advisor about one late proposal.
//
// Returns { status, notified, replayed, ... } and never throws. `at` is only
// consulted for a proposal with no recorded verdict yet, i.e. an open draft.
async function notifyProposalDelay({
  proposal,
  at = new Date().toISOString(),
  correlationId = null,
  notify = defaultDelayNotifier,
  audit = recordAudit,
  alreadyNotified = hasAuditEntry,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (!isUsableProposal(proposal)) {
    logFailure(SERVICE_NAME, "proposal_delay_refused", "ValidationError", 0, {
      reason: "unusable_proposal",
    });
    return { status: STATUSES.INVALID_PROPOSAL, notified: false };
  }

  const sla = slaPositionFor(proposal, at);
  if (!sla || sla.breached !== true) {
    // Not an error, and deliberately not logged as one: the overwhelming
    // majority of proposals arrive here on time, and this is the normal answer.
    return { status: STATUSES.NOT_LATE, notified: false, proposalId: proposal.proposalId };
  }

  const key = auditKeyFor(proposal.proposalId, EVENTS.NOTIFIED);

  // Checked BEFORE the call, so a replay cannot reach the channel at all.
  // Durable, so a restart cannot re-page an advisor about yesterday's delay.
  if (key !== "" && alreadyNotified(key)) {
    return {
      status: STATUSES.ALREADY_NOTIFIED,
      notified: true,
      replayed: true,
      attempts: 0,
      proposalId: proposal.proposalId,
    };
  }

  const result = await callWithRetry(notify, buildMessage(proposal, sla), timeoutMs, maxAttempts);

  if (!result.ok) {
    const failure = classifyFailure(result);
    logFailure(SERVICE_NAME, "proposal_delay_notify_failed", failure.errorClass, result.attempts, {
      proposalId: proposal.proposalId,
    });
    // Recorded under a DIFFERENT key, so the trail shows a page that never
    // landed without that record blocking the next attempt. Best effort: the
    // proposal is already committed and its breach already audited, so an audit
    // failure here must not turn a missed page into a thrown exception.
    try {
      audit({
        auditKey: auditKeyFor(proposal.proposalId, EVENTS.FAILED),
        event: EVENTS.FAILED,
        outcome: "failure",
        actor: proposal.completedBy || proposal.openedBy || null,
        resource: proposal.proposalId,
        correlationId: correlationId,
        context: { errorClass: failure.errorClass, attempts: result.attempts },
      });
    } catch (error) {
      // Swallowed deliberately, and deliberately not silent - without this line
      // it would be the empty catch CLAUDE.md forbids.
      logFailure(SERVICE_NAME, "proposal_delay_failure_unaudited", "UpstreamUnavailable", 0, {
        proposalId: proposal.proposalId,
      });
    }
    return {
      status: STATUSES.FAILED,
      notified: false,
      replayed: false,
      errorClass: failure.errorClass,
      attempts: result.attempts,
      proposalId: proposal.proposalId,
    };
  }

  // The page landed. Record it - and if THAT fails, report the page as sent
  // anyway, because it was: claiming otherwise would be a lie the caller acts
  // on. The cost is that the next call may page a second time, which is the
  // trade this module makes everywhere (see the header).
  let deduped = true;
  try {
    audit({
      auditKey: key,
      event: EVENTS.NOTIFIED,
      outcome: "success",
      actor: proposal.completedBy || proposal.openedBy || null,
      resource: proposal.proposalId,
      correlationId: correlationId,
      // Figures and codes only - never the subject line, which is built from
      // the proposal and would put its id and timings in twice.
      context: {
        overdueMs: sla.overdueMs,
        slaUnknown: sla.slaUnknown === true,
        attempts: result.attempts,
      },
    });
  } catch (error) {
    deduped = false;
    logFailure(SERVICE_NAME, "proposal_delay_notice_unaudited", "UpstreamUnavailable", 0, {
      proposalId: proposal.proposalId,
    });
  }

  return {
    status: STATUSES.NOTIFIED,
    notified: true,
    replayed: false,
    attempts: result.attempts,
    // False means this page is not deduped and a retry may page again. The
    // caller cannot fix it, but a log or a report can say so honestly.
    deduped: deduped,
    proposalId: proposal.proposalId,
  };
}

// Pages the advisor for every late OPEN draft handed to it.
//
// This is the half of AC-2 that completion cannot cover: "when it exceeds 30
// minutes" is true the moment the clock passes the deadline, not only when the
// advisor eventually clicks Complete. The caller supplies the records - see the
// header on why this does not read the store itself.
//
// One failure does not stop the sweep. A scheduled job that abandons the queue
// on the first bad row leaves every later advisor un-paged for reasons that
// have nothing to do with their proposal.
async function sweepBreachedProposals({ proposals, at = new Date().toISOString(), ...options }) {
  const queue = Array.isArray(proposals) ? proposals : [];
  const results = [];

  for (const proposal of queue) {
    // Sequential on purpose. These are pages to people, and firing a hundred at
    // once at a channel we do not control is how a notifier earns a rate limit.
    results.push(await notifyProposalDelay({ proposal: proposal, at: at, ...options }));
  }

  return {
    considered: queue.length,
    notified: results.filter(function (r) {
      return r.status === STATUSES.NOTIFIED;
    }).length,
    alreadyNotified: results.filter(function (r) {
      return r.status === STATUSES.ALREADY_NOTIFIED;
    }).length,
    failed: results.filter(function (r) {
      return r.status === STATUSES.FAILED;
    }).length,
    results: results,
  };
}

module.exports = {
  notifyProposalDelay,
  sweepBreachedProposals,
  defaultDelayNotifier,
  getOutbox,
  __clearOutboxForTests,
  EVENTS,
  STATUSES,
};
