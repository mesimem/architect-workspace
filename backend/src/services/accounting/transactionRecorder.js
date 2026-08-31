// STORY-004: the one place that decides what gets audited and what gets posted.
//
// This module exists because the story's three acceptance criteria pull in two
// directions and something has to hold both:
//
//   1. a COMPLETED transaction is logged in the accounting software
//   2. a FAILED transaction is NOT logged in the accounting software
//   3. ANY transaction produces an audit log entry
//
// (1) and (2) are about the external books. (3) is about our own record. Put
// them in one store and you must break one of them: filter failures out and (3)
// dies, keep them in and (2) dies. So there are two stores, and this module is
// the only thing that talks to both.
//
// THE ORDER IS THE DESIGN. The audit entry is written BEFORE the accounting
// call and does not depend on it succeeding. That is what makes (3) hold even
// when (1) cannot: if the accounting API is down, or the process dies mid-post,
// the audit log still says "this transaction completed, $2,499, at this time",
// and the absence of a matching accounting.post entry tells a reconciler
// exactly what to go and check. Writing the audit entry afterwards would mean
// the one situation where you most need a record is the one where you have
// none.
//
// NO AUDIT, NO POST. If the audit write fails we refuse to post, and say so.
// This looks backwards - surely getting the money into the books matters more?
// It does not. An entry in someone's books that we cannot trace back to
// anything is a worse position than a missing entry we know is missing: the
// missing one is findable, the untraceable one is discovered at year-end by an
// accountant. An audit write only fails on a programming error or a disk
// failure, both of which need a human anyway.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? The caller gets a typed status and never an
//     exception - it is mid-booking, and the payment has usually already gone
//     through. Nothing is silently dropped: every outcome, including our own
//     refusals, is in the audit log.
//  2. Will it retry? Not here. Timeout and retry policy live one layer down in
//     accountingClient.js, so there is exactly one place that decides what is
//     worth retrying. Retrying at two layers multiplies the attempts and nobody
//     notices until the vendor rate-limits us.
//  3. Recovery when the post fails? Call this again with the SAME auditKey.
//     The audit entry replays instead of duplicating, and the post is attempted
//     again - which is safe because accountingClient dedups on transactionId.
//     That is the deliberate reason a replayed audit entry does NOT short-
//     circuit the post: the previous run may have died before it got that far.
//  4. Handled here: a transaction that did not complete, an unusable audit key,
//     an audit store that refuses the write, every accounting failure the
//     client can report, and being called twice for one transaction. NOT
//     handled: reversing a post once it has landed (that is a refund, a
//     separate entryType and a separate story), and multi-currency conversion.

const { recordAudit, isValidAuditKey, deriveAuditKey } = require("../audit/auditLog");
const { postTransaction } = require("./accountingClient");

const SERVICE_NAME = "transaction-recorder";

// The accounting attempt gets its own audit entry, because the audit log is
// append-only and the first entry cannot be amended once the post resolves. So
// a completed transaction produces two entries: what happened, then what we
// did about it in the books.
//
// THE STATUS IS PART OF THE KEY, AND THAT IS THE WHOLE TRICK. Keying this on
// the caller's auditKey alone looked right and was wrong: the audit log is
// first-write-wins, so a post that failed and was later retried successfully
// would keep the `failure` entry forever and silently drop the recovery. An
// audit trail that cannot record "it failed, then it worked" is worse than
// none, because it reads as authoritative.
//
// Including the accounting status means each DISTINCT outcome is recorded once.
// A retry that fails the same way again dedups - repeated identical failures
// are an alerting concern, already on stderr, not an audit fact worth storing
// twice. A retry that succeeds writes a new entry, so the trail shows both.
// Deterministic on purpose: no clock and no counter in the key, so it is
// replay-safe across a restart.
//
// The truncation and the unusable-base rule live in auditLog.deriveAuditKey,
// because bookTripService hit the identical trap on its own booking keys and
// two copies of a key-derivation rule is how they diverge.
function accountingAuditKey(auditKey, status) {
  return deriveAuditKey(auditKey, "acct:" + status);
}

function logRecorderEvent(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: SERVICE_NAME,
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

// Only fields we are willing to keep forever, and only from a shape we have
// checked. auditLog redacts credential-shaped keys on the way in, but the
// cheaper protection is not handing it the whole caller-supplied object.
function summarise(transaction) {
  if (!transaction || typeof transaction !== "object") {
    return { transactionId: null };
  }
  return {
    transactionId: typeof transaction.transactionId === "string" ? transaction.transactionId : null,
    entryType: transaction.entryType || null,
    amountCents: typeof transaction.amountCents === "number" ? transaction.amountCents : null,
    currency: typeof transaction.currency === "string" ? transaction.currency : null,
  };
}

// Returns one of:
//   { status: "recorded_and_posted",  audited: true,  posted: true }
//   { status: "recorded_not_posted",  audited: true,  posted: false }  <- criterion 2
//   { status: "recorded_post_failed", audited: true,  posted: false }
//   { status: "audit_failed",         audited: false, posted: false }
// Always carries auditKey, replayed, reference and the raw accounting result
// (null when we never called).
//
// `completed` is the caller's answer to "did this transaction actually go
// through?" - a boolean, not something inferred here. The booking service knows
// whether the payment succeeded; this module must not try to guess it from the
// shape of a payload.
async function recordTransaction({
  auditKey,
  transaction,
  completed,
  reason = null,
  actor = null,
  correlationId = null,
  post,
  token,
  timeoutMs,
  maxAttempts,
}) {
  const summary = summarise(transaction);

  // Checked before we do anything, so the "no audit, no post" rule cannot be
  // reached by accident further down.
  if (!isValidAuditKey(auditKey)) {
    logRecorderEvent("error", "transaction_not_recorded", {
      error_class: "ValidationError",
      reason: "unusable_audit_key",
      transactionId: summary.transactionId,
    });
    return {
      status: "audit_failed",
      audited: false,
      posted: false,
      auditKey: null,
      replayed: false,
      reference: null,
      accounting: null,
      errorClass: "ValidationError",
    };
  }

  // WRITE-AHEAD. This lands before the accounting call, so a crash during the
  // call still leaves evidence the transaction happened.
  let audited;
  try {
    audited = recordAudit({
      auditKey: auditKey,
      event: "transaction.processed",
      outcome: completed === true ? "success" : "failure",
      actor: actor,
      resource: summary.transactionId,
      correlationId: correlationId,
      context: Object.assign({ completed: completed === true, reason: reason }, summary),
    });
  } catch (error) {
    // Never swallowed. We refuse to post rather than move money we cannot
    // account for - see the header.
    logRecorderEvent("error", "transaction_not_recorded", {
      error_class: error && error.errorClass ? error.errorClass : "UnknownError",
      transactionId: summary.transactionId,
    });
    return {
      status: "audit_failed",
      audited: false,
      posted: false,
      auditKey: auditKey,
      replayed: false,
      reference: null,
      accounting: null,
      errorClass: error && error.errorClass ? error.errorClass : "UnknownError",
    };
  }

  // CRITERION 2. A transaction that did not complete is audited and stops here.
  // The accounting API is never called, so there is nothing to undo.
  if (completed !== true) {
    logRecorderEvent("info", "failed_transaction_not_posted", {
      auditKey: auditKey,
      transactionId: summary.transactionId,
      reason: reason,
    });
    return {
      status: "recorded_not_posted",
      audited: true,
      posted: false,
      auditKey: auditKey,
      replayed: audited.replayed,
      reference: null,
      accounting: null,
    };
  }

  // CRITERION 1. Attempted even when the audit entry replayed: a previous run
  // may have died between the two, and accountingClient dedups on
  // transactionId so a second attempt cannot double-post.
  const accounting = await postTransaction({
    transaction: transaction,
    post: post,
    token: token,
    timeoutMs: timeoutMs,
    maxAttempts: maxAttempts,
  });

  // The second audit entry: what we did about the books. Its own key, so it is
  // idempotent in its own right.
  const postAuditKey = accountingAuditKey(auditKey, accounting.status);
  let accountingAudited;
  try {
    accountingAudited = recordAudit({
      auditKey: postAuditKey,
      event: "accounting.post",
      outcome: accounting.posted ? "success" : "failure",
      actor: actor,
      resource: summary.transactionId,
      correlationId: correlationId,
      context: {
        accountingStatus: accounting.status,
        reference: accounting.reference || null,
        errorClass: accounting.errorClass || null,
        attempts: typeof accounting.attempts === "number" ? accounting.attempts : null,
      },
    });
  } catch (error) {
    // The post itself may well have succeeded, so this is reported, not hidden.
    // The first entry is already on disk, which is what makes this recoverable.
    logRecorderEvent("error", "accounting_result_not_recorded", {
      error_class: error && error.errorClass ? error.errorClass : "UnknownError",
      auditKey: auditKey,
      accountingStatus: accounting.status,
    });
    accountingAudited = null;
  }

  return {
    status: accounting.posted ? "recorded_and_posted" : "recorded_post_failed",
    audited: true,
    accountingAudited: accountingAudited !== null,
    posted: Boolean(accounting.posted),
    auditKey: auditKey,
    postAuditKey: postAuditKey,
    replayed: audited.replayed,
    reference: accounting.reference || null,
    accounting: accounting,
  };
}

module.exports = { recordTransaction, accountingAuditKey };
