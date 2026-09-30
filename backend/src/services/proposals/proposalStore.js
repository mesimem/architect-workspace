// STORY-013: where a trip proposal lives, and the clock it is judged against.
//
// THE ONE DECISION THIS FILE IS BUILT AROUND. `startedAt` is written to the
// store BEFORE ANY WORK HAPPENS, and no later write ever touches it. Everything
// the story asks for falls out of that:
//   - AC-1 is measurable at all, because there is a start instant to measure
//     from that the advisor's client did not supply and cannot move.
//   - AC-2 works for a draft still open, not only for one that finished - the
//     clock is on disk and readable by a sweep (listBreachedOpenProposals).
//   - "system crash during proposal creation" cannot hide an overrun. A restart
//     reloads the ORIGINAL start instant, so a proposal that has been open for
//     forty minutes across a restart is forty minutes late, not freshly opened.
//     A clock kept in memory, or re-stamped on recovery, would quietly reset
//     the SLA every time the process died - which is precisely the moment the
//     advisor most needs to be told.
//
// WHY A PROPOSAL IS NOT A QUOTE, given that STORY-007 already ships one. A
// quote is a priced document that exists the instant it is issued. A proposal
// is the timed piece of WORK that produces one: it has a duration, a deadline
// and an SLA, and none of those are properties a quote has. That difference is
// the whole of REQ-003. What is NOT rebuilt here is the arithmetic: pricing
// goes through STORY-007's pure priceQuote, so there is one implementation of
// what a trip costs and a proposal cannot disagree with a quote about money.
//
// A LATE PROPOSAL IS STILL ISSUED. AC-2 asks for the advisor to be NOTIFIED of
// the delay, not for the work to be thrown away at 30:00. Refusing to issue at
// the deadline would destroy half an hour of an advisor's work to satisfy a
// timer, and leave the client with nothing. So completion always completes; the
// breach is recorded on the record and paged to the advisor.
//
// IDEMPOTENCY IS ON THE CORRELATION ID, the same rule as quoteStore.js. A
// retried start returns the first draft rather than opening a second at a new
// id, and a double-clicked Complete returns the issue it already made rather
// than bumping the version twice. Two drafts for one trip request is not a
// cosmetic problem: it is two clocks, and the advisor would be paged about the
// one nobody is working on.
//
// WHAT THIS FILE DOES NOT OWN, and each of the three is next door for a
// reason - they change for different reasons than the lifecycle does:
//   proposalClock.js     - the thirty-minute arithmetic and its verdict.
//   proposalAssembly.js  - the external boundary, its timeout and its retries.
//   quotes/quotePricing.js (STORY-007) - what a trip costs. Reused, not
//                          rebuilt, so a proposal cannot disagree with a quote
//                          about money.
//
// AN UNAUDITED PROPOSAL MUST NOT EXIST. Both writes go through the shared door
// in services/shared/auditedCommit.js, which reads the write back and rolls it
// back if the audit fails. Nothing in this file calls store.set directly. That
// is what makes the trust criterion true by construction rather than by
// remembering: the record cannot reach the store without its audit entry.
//
// WHY AN UNJUDGEABLE CLOCK COUNTS AS A BREACH. If proposalClock cannot read the
// timestamps it is given, the honest answer is "we do not know", and of the two
// ways to be wrong, silently reporting "on time" is the one that suppresses a
// page the advisor is owed. So an unreadable clock issues the proposal, marks
// it breached with slaUnknown, and lets the notification fire.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every outcome is { ok: false, reason,
//     problems }. Nothing here throws on caller input: these reasons become
//     HTTP statuses, and malformed trip details must be a 400, not a 500.
//  2. Will it retry? The optional assemble boundary retries on timeout, capped,
//     through the shared policy in shared/callWithRetry.js. The store writes do
//     not: the only I/O is a local synchronous write and retrying one that just
//     failed generally fails again. The CALLER may retry any of this safely,
//     which is what the correlationId dedup is for.
//  3. Recovery path? A refused completion leaves the draft exactly as it was -
//     still open, still clocked, still completable - so the advisor fixes the
//     details and resubmits with nothing to clean up. A failed start leaves no
//     row and no audit entry claiming one.
//  4. Handled here: missing ids, unknown proposals, re-issuing an issued
//     proposal, trip details that do not price, an assemble step that hangs or
//     throws, a write that does not persist, an audit that fails, replayed
//     requests, an unreadable clock, and a clock that ran backwards. NOT
//     handled: concurrent completion of one proposal by two advisors (last
//     write wins; needs row locking, which needs the database), editing a draft
//     in place between start and completion (STORY-015 owns itinerary detail),
//     converting an issued proposal into a customer-visible quote (quoteStore
//     owns that document, and doing both atomically needs a transaction across
//     two stores), and abandoning a draft.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit } = require("../audit/auditLog");
const { createAuditedCommit, REASONS: COMMIT_REASONS } = require("../shared/auditedCommit");
const { priceQuote, STATUSES: PRICING_STATUSES } = require("../quotes/quotePricing");
const { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, logFailure } = require("../shared/callWithRetry");
// The external boundary and its retry policy; the clock and its verdict; the
// page an advisor gets when their proposal is late. Each is a leaf: none of
// them requires this file back.
const { assembleDetails, REASONS: ASSEMBLY_REASONS } = require("./proposalAssembly");
const { judgeElapsed, judgeSlaForRecord, deadlineFor, SLA_MINUTES } = require("./proposalClock");
const { notifyProposalDelay } = require("./proposalDelayNotifier");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise - the same
// bargain every other store in this repo makes. See jsonFileStore.js. For this
// store the durable case is not a nicety: it is what stops a restart resetting
// the clock. The durability suite runs with it set, deliberately.
const PROPOSALS = createJsonFileStore("proposals");

const { commit, auditNoChange } = createAuditedCommit({
  subject: "proposal",
  service: "proposals",
});

const SERVICE_NAME = "proposals";

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;

// Two statuses, and no third. A draft is being worked on; an issued proposal is
// finished. "abandoned" and "expired" each imply a rule about who may still see
// it, and a visibility rule nobody has specified is worse than none at all -
// the same call quoteStore.js made about draft quotes.
const STATUSES = Object.freeze({
  DRAFTING: "drafting",
  ISSUED: "issued",
});

const EVENTS = Object.freeze({
  OPENED: "proposal.opened",
  ISSUED: "proposal.issued",
  REFUSED: "proposal.refused",
});

const REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  MISSING_CORRELATION_ID: "missing_correlation_id",
  UNKNOWN_PROPOSAL: "unknown_proposal",
  ALREADY_ISSUED: "already_issued",
  INVALID_DETAILS: "invalid_details",
  // Re-exported rather than restated, so a route maps every refusal onto an
  // HTTP status from ONE list. Two lists that must agree are one list that
  // will not.
  GENERATION_TIMEOUT: ASSEMBLY_REASONS.GENERATION_TIMEOUT,
  GENERATION_UNAVAILABLE: ASSEMBLY_REASONS.GENERATION_UNAVAILABLE,
  NOT_SAVED: COMMIT_REASONS.NOT_SAVED,
  AUDIT_UNAVAILABLE: COMMIT_REASONS.AUDIT_UNAVAILABLE,
});

function isUsableId(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID_LENGTH;
}

function optionalText(value, maxLength) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, maxLength) : null;
}

function nowIso() {
  return new Date().toISOString();
}

function refuse(reason, problems) {
  return { ok: false, reason: reason, problems: problems };
}

// A refusal changed nothing, so logging it is best effort - see the asymmetry
// explained in shared/auditedCommit.js.
function auditRefusal(audit, details) {
  return auditNoChange(audit, { event: EVENTS.REFUSED, outcome: "failure", ...details });
}

function allProposals(store) {
  return Array.from(store.values());
}

// A replay is the SAME request arriving twice, identified by its correlation id.
function findByCorrelation(store, field, correlationId) {
  return (
    allProposals(store).find(function (proposal) {
      return proposal && proposal[field] === correlationId;
    }) || null
  );
}

// Opens a draft and starts its clock. Returns { ok: true, proposal, replayed }
// or a refusal.
//
// Deliberately cheap: it takes who the trip is for and nothing else that could
// fail. The advisor has not typed the itinerary yet, and demanding it here would
// mean the clock only starts once the work is already half done - which would
// make AC-1 measure the wrong interval and always pass.
function startProposal(
  { customerId, tripReference, title, actor, correlationId },
  { store = PROPOSALS, audit = recordAudit, now = nowIso } = {}
) {
  if (!isUsableId(correlationId)) {
    // Our plumbing, not the caller's: server.js always supplies one.
    return refuse(REASONS.MISSING_CORRELATION_ID, ["correlationId is required."]);
  }

  const problems = [];
  if (!isUsableId(customerId)) {
    problems.push("customerId is required.");
  }
  if (!isUsableId(actor)) {
    problems.push("actor is required - a proposal records which advisor opened it.");
  }
  if (problems.length > 0) {
    auditRefusal(audit, { reason: REASONS.INVALID_REQUEST, actor, correlationId });
    return refuse(REASONS.INVALID_REQUEST, problems);
  }

  // Replay check BEFORE an id is generated, so a retry cannot burn a second
  // proposalId - or, worse, start a second clock.
  const replay = findByCorrelation(store, "createdWith", correlationId);
  if (replay) {
    return { ok: true, proposal: replay, replayed: true };
  }

  const startedAt = now();
  const proposal = Object.freeze({
    proposalId: "proposal_" + crypto.randomUUID(),
    customerId: customerId,
    tripReference: optionalText(tripReference, MAX_ID_LENGTH),
    title: optionalText(title, MAX_TITLE_LENGTH),
    status: STATUSES.DRAFTING,
    version: 1,
    // THE CLOCK. Written once, here, and never touched again.
    startedAt: startedAt,
    updatedAt: startedAt,
    completedAt: null,
    openedBy: actor,
    completedBy: null,
    customerNote: null,
    internalNotes: null,
    pricing: null,
    sla: null,
    createdWith: correlationId,
    lastModifiedWith: correlationId,
  });

  const committed = commit(store, audit, {
    id: proposal.proposalId,
    version: 1,
    record: proposal,
    previous: null,
    event: EVENTS.OPENED,
    actor: actor,
    correlationId: correlationId,
    context: {
      customerId: customerId,
      version: 1,
      startedAt: startedAt,
      slaMinutes: SLA_MINUTES,
      deadlineAt: deadlineFor(startedAt),
    },
  });
  if (!committed.ok) {
    return committed;
  }

  return { ok: true, proposal: proposal, replayed: false };
}

// Issues the proposal. Returns { ok: true, proposal, sla, replayed } or a
// refusal. Async because the assemble boundary above may be.
async function completeProposal(
  { proposalId, details, actor, correlationId },
  {
    store = PROPOSALS,
    audit = recordAudit,
    now = nowIso,
    assemble = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    // Injected so a test can watch it, defaulted so no caller has to remember
    // it - see the call site at the bottom of this function.
    notifyDelay = notifyProposalDelay,
  } = {}
) {
  if (!isUsableId(correlationId)) {
    return refuse(REASONS.MISSING_CORRELATION_ID, ["correlationId is required."]);
  }
  if (!isUsableId(actor)) {
    auditRefusal(audit, { reason: REASONS.INVALID_REQUEST, actor, correlationId });
    return refuse(REASONS.INVALID_REQUEST, ["actor is required - an issue records who made it."]);
  }

  const current = isUsableId(proposalId) ? store.get(proposalId) || null : null;
  if (!current) {
    auditRefusal(audit, {
      reason: REASONS.UNKNOWN_PROPOSAL,
      actor,
      correlationId,
      resource: isUsableId(proposalId) ? proposalId : "proposal",
    });
    return refuse(REASONS.UNKNOWN_PROPOSAL, ["No proposal with that id."]);
  }

  // A retried Complete returns the issue it already made. Without this, a
  // double-clicked button bumps the version twice and re-prices a finished
  // proposal.
  if (current.lastModifiedWith === correlationId) {
    return { ok: true, proposal: current, sla: current.sla, replayed: true };
  }

  // An issued proposal is finished. Re-issuing it is not an edit: the elapsed
  // time is already a recorded fact, and overwriting it would rewrite whether
  // this proposal met REQ-003.
  if (current.status === STATUSES.ISSUED) {
    auditRefusal(audit, { reason: REASONS.ALREADY_ISSUED, actor, correlationId, resource: proposalId });
    return refuse(REASONS.ALREADY_ISSUED, [
      "This proposal has already been issued. Open a new proposal instead.",
    ]);
  }

  const submitted = details !== null && typeof details === "object" && !Array.isArray(details) ? details : {};

  // Assembly FIRST, so a hang costs nothing: no pricing, no write, and the
  // draft is left exactly as it was with its clock still running.
  const assembled = await assembleDetails(submitted, {
    assemble: assemble,
    timeoutMs: timeoutMs,
    maxAttempts: maxAttempts,
  });
  if (!assembled.ok) {
    auditRefusal(audit, { reason: assembled.reason, actor, correlationId, resource: proposalId });
    return assembled;
  }
  const trip = assembled.details;

  // "Incorrect trip details" - judged by STORY-007's pricer, not by a second
  // set of rules here. It returns every problem at once so an advisor can fix
  // the whole form in one pass rather than one field per attempt.
  const priced = priceQuote({
    lines: trip.lines,
    currency: typeof trip.currency === "string" ? trip.currency : "USD",
    discountBasisPoints: trip.discountBasisPoints === undefined ? 0 : trip.discountBasisPoints,
  });
  if (priced.status !== PRICING_STATUSES.PRICED) {
    auditRefusal(audit, { reason: REASONS.INVALID_DETAILS, actor, correlationId, resource: proposalId });
    // The draft is untouched. A rejected completion must never leave a
    // half-priced proposal that someone could send to a client.
    return refuse(REASONS.INVALID_DETAILS, priced.problems);
  }

  const completedAt = now();
  const sla = judgeSlaForRecord(current.startedAt, completedAt);

  const issued = Object.freeze({
    ...current,
    // startedAt is NOT in this list, and that is the point - see the header.
    title: optionalText(trip.title, MAX_TITLE_LENGTH) || current.title,
    tripReference: optionalText(trip.tripReference, MAX_ID_LENGTH) || current.tripReference,
    customerNote: optionalText(trip.customerNote, MAX_NOTE_LENGTH),
    internalNotes: optionalText(trip.internalNotes, MAX_NOTE_LENGTH),
    status: STATUSES.ISSUED,
    version: current.version + 1,
    updatedAt: completedAt,
    completedAt: completedAt,
    completedBy: actor,
    pricing: priced.pricing,
    sla: Object.freeze(sla),
    lastModifiedWith: correlationId,
  });

  const committed = commit(store, audit, {
    id: issued.proposalId,
    version: issued.version,
    record: issued,
    previous: current,
    event: EVENTS.ISSUED,
    actor: actor,
    correlationId: correlationId,
    // Ids, figures and codes only - never the note text, which is free-form and
    // may quote the customer.
    context: {
      customerId: issued.customerId,
      version: issued.version,
      startedAt: current.startedAt,
      completedAt: completedAt,
      elapsedMs: sla.elapsedMs,
      slaState: sla.state,
      slaBreached: sla.breached,
      slaUnknown: sla.slaUnknown,
      totalCents: priced.pricing.totalCents,
      currency: priced.pricing.currency,
    },
  });
  if (!committed.ok) {
    return committed;
  }

  // AC-2, AND IT IS PART OF COMPLETION RATHER THAN SOMETHING A ROUTE REMEMBERS.
  // A notification that only happens when a caller thinks to ask for it is one
  // forgotten call site away from an advisor never being told - and the
  // forgotten call site is invisible in review, because the completion still
  // looks correct. The same reasoning as quoteStore's "there is no second copy
  // to update".
  //
  // AFTER the commit, and best-effort on top of it: the proposal is already
  // stored and its breach is already in the audit trail, so a failed page loses
  // an alert, never the record of the delay. Its outcome is reported, never
  // thrown, and never turns a successful completion into a failure - the
  // advisor's work is safe either way, which is the more important guarantee.
  let delayNotification = null;
  if (issued.sla.breached) {
    try {
      delayNotification = await notifyDelay({
        proposal: issued,
        at: completedAt,
        correlationId: correlationId,
      });
    } catch (error) {
      // notifyProposalDelay returns failure as data and does not throw, so
      // reaching here means a caller injected something that does. Swallowed
      // rather than propagated because the proposal IS issued and rolling that
      // back over a notification would destroy the advisor's work to protect an
      // alert. Deliberately not silent - see the log line.
      delayNotification = {
        status: "notification_failed",
        notified: false,
        errorClass: error && error.errorClass ? error.errorClass : "UpstreamUnavailable",
      };
      logFailure(SERVICE_NAME, "proposal_delay_notifier_threw", delayNotification.errorClass, 1, {
        proposalId: issued.proposalId,
      });
    }
  }

  return {
    ok: true,
    proposal: issued,
    sla: issued.sla,
    replayed: false,
    delayNotification: delayNotification,
  };
}

// READS.

// The advisor's read. Named so that its lack of a customer filter is a
// deliberate choice at the call site rather than an oversight - the same
// convention as quoteStore.getQuoteForStaff.
function getProposalForStaff({ proposalId }, { store = PROPOSALS } = {}) {
  return isUsableId(proposalId) ? store.get(proposalId) || null : null;
}

// Drafts that are ALREADY LATE and not yet issued.
//
// This is the half of AC-2 that completion cannot cover. "When it exceeds 30
// minutes" is true the moment the clock passes the deadline, not only when the
// advisor eventually clicks Complete - a proposal abandoned at minute 12 and
// picked up again at minute 90 has been late for an hour, and nothing would
// ever have paged anyone if the only check ran at completion.
function listBreachedOpenProposals({ at } = {}, { store = PROPOSALS, now = nowIso } = {}) {
  const instant = at || now();
  return allProposals(store)
    .filter(function (proposal) {
      if (!proposal || proposal.status !== STATUSES.DRAFTING) {
        return false;
      }
      const judged = judgeElapsed({ startedAt: proposal.startedAt, at: instant });
      // An unjudgeable draft is included, for the same reason
      // judgeSlaForRecord calls it a breach: not knowing is not a reason to
      // stay quiet.
      return judged.ok ? judged.breached : true;
    })
    .sort(function (a, b) {
      return String(a.startedAt || "").localeCompare(String(b.startedAt || ""));
    });
}

// Tests only. Not reachable over HTTP - erasing the proposal book is not an
// operation this system offers.
function __resetProposalsForTests() {
  for (const key of Array.from(PROPOSALS.keys())) {
    PROPOSALS.delete(key);
  }
}

module.exports = {
  startProposal,
  completeProposal,
  getProposalForStaff,
  listBreachedOpenProposals,
  __resetProposalsForTests,
  STATUSES,
  EVENTS,
  REASONS,
};
