// STORY-011: a customer pays down the balance on one of their payment accounts.
//
// This module is the ORDER of operations; every rule it relies on lives
// elsewhere and is reused, not rebuilt:
//   balanceLedger.js        - is this amount payable against this balance?
//   booking/paymentService  - the (mock) card processor
//   transactionRecorder.js  - audit EVERY attempt; post only successes to the
//                             accounting software (STORY-004)
//   paymentAccountStore.js  - the account the balance is derived from
//
// THE ORDER, AND WHY:
//   1. ownership     - someone else's account answers "not found", so the
//                      endpoint cannot be used to discover which accounts exist
//   2. already paid? - if this paymentId already succeeded (on the account OR
//                      in the audit log) we NEVER charge again; we finish the
//                      bookkeeping instead. This is what makes a retry safe.
//   3. validate      - an invalid or over-balance amount never reaches the card
//   4. charge        - explicit timeout, ONE attempt (see "no automatic retry")
//   5. audit + post  - transactionRecorder writes the audit entry first
//   6. balance       - paymentAccountStore records the payment, read back
//
// Audit (5) is written BEFORE the balance (6) on purpose. If the process dies
// between them, the audit entry is the proof the card was charged, and step 2
// on the customer's retry finds it and finishes the job without charging twice.
//
// NO AUTOMATIC RETRY OF THE CHARGE. A timeout does not mean the processor did
// nothing - it means we stopped waiting. Retrying automatically could take the
// money twice. Instead the CUSTOMER retries, with the same paymentId, and the
// processor is handed a deterministic idempotency key derived from it so a real
// processor can dedup a charge that did land. (The mock has nothing to dedup.)
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A typed status, never an exception:
//       payment_failed      - card declined; balance unchanged; retryable
//       payment_error       - processor timed out or threw; balance unchanged
//       balance_not_updated - card WAS charged but the account write failed;
//                             retry with the same paymentId finishes it
//     Every attempt that reaches the processor has an audit entry.
//  2. Will it retry? The charge: no (above). The accounting post: yes, capped,
//     inside accountingClient.js. The store write: no - the caller retries.
//  3. Recovery when retries are exhausted? The audit log holds every charge;
//     a reconciler compares `transaction.processed` successes with the account.
//  4. Handled: wrong owner, unknown account, malformed or over-balance amount,
//     declined card, processor timeout or throw, audit write failure, account
//     write failure, the same paymentId sent twice, a paymentId reused with a
//     different amount. NOT handled: a processor that charges but times out AND
//     an audit write that fails at the same moment (the processor's idempotency
//     key is the only protection there), refunds, currency conversion.

const crypto = require("crypto");

const { processPayment } = require("../booking/paymentService");
const { recordTransaction } = require("../accounting/transactionRecorder");
const { deriveAuditKey, findAuditEntry } = require("../audit/auditLog");
const { callWithRetry, classifyFailure, logFailure } = require("../shared/callWithRetry");
const { validatePaymentAmount } = require("./balanceLedger");
const store = require("./paymentAccountStore");

const SERVICE_NAME = "customer-payments";
const CHARGE_TIMEOUT_MS = 10000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// One accounting transaction per (account, paymentId). Hashed so it is
// deterministic, globally unique across accounts, and within the 8-128
// character bound the accounting boundary enforces.
function transactionIdFor(accountId, paymentId) {
  const digest = crypto.createHash("sha256").update(accountId + "|" + paymentId).digest("hex");
  return "PMT-" + digest.slice(0, 32);
}

// The default charge: the existing mock processor, adapted to an async call
// that receives an idempotency key, which is the shape a real processor takes.
async function defaultCharge({ customerId, amountCents, currency }) {
  return processPayment({ customerId: customerId, amountCents: amountCents, currency: currency });
}

// recordTransaction is written not to throw; this makes sure of it, for the
// same reason bookTripService does - by now the money may have moved.
async function recordSafely(args) {
  try {
    return await recordTransaction(args);
  } catch (error) {
    const errorClass = error && error.errorClass ? error.errorClass : "UnknownError";
    logFailure(SERVICE_NAME, "payment_transaction_not_recorded", errorClass, 0, {
      auditKey: args.auditKey,
    });
    return { status: "audit_failed", audited: false, posted: false, reference: null };
  }
}

function transactionFor(account, txId, amountCents, memo) {
  return {
    transactionId: txId,
    customerId: account.customerId,
    entryType: "sale",
    amountCents: amountCents,
    currency: account.currency,
    occurredAt: new Date().toISOString(),
    memo: memo,
  };
}

function refuse(status, errorClass, message, extra) {
  return Object.assign({ ok: false, status: status, errorClass: errorClass, message: message }, extra);
}

// What the card processor already confirmed for this payment, from the account
// or - if the account write was lost - from the audit log.
function findConfirmedCharge(account, paymentId, successKey) {
  const prior = account.payments.find(function (p) {
    return p.paymentId === paymentId && p.status === "succeeded";
  });
  if (prior) return { amountCents: prior.amountCents };
  const audited = findAuditEntry(successKey);
  if (audited && audited.outcome === "success" && audited.context) {
    return { amountCents: audited.context.amountCents };
  }
  return null;
}

// Steps 5 and 6 for a charge that succeeded. Idempotent: called again on a
// retry, the audit entry replays, accounting dedups on transactionId, and the
// store replays the payment.
async function finalise({ account, paymentId, amountCents, txId, successKey, actor, correlationId, replay }) {
  const recorded = await recordSafely({
    auditKey: successKey,
    transaction: transactionFor(account, txId, amountCents, "Customer payment " + paymentId),
    completed: true,
    actor: actor,
    correlationId: correlationId,
  });
  const stored = store.recordPayment(account.accountId, {
    paymentId: paymentId,
    amountCents: amountCents,
    status: "succeeded",
  });
  const logging = {
    transactionLogged: recorded.audited === true,
    accounting: { status: recorded.status, posted: Boolean(recorded.posted), reference: recorded.reference || null },
  };
  if (!stored.ok) {
    return refuse(
      "balance_not_updated",
      stored.errorClass,
      "Your payment was taken but your balance could not be updated yet. Retry with the same payment id to finish it - you will not be charged again.",
      Object.assign({ charged: true, paymentId: paymentId, transactionId: txId }, logging)
    );
  }
  return Object.assign(
    {
      ok: true,
      status: replay ? "already_paid" : "paid",
      paymentId: paymentId,
      transactionId: txId,
      amountCents: amountCents,
      balanceCents: stored.account.balanceCents,
      account: stored.account,
    },
    logging
  );
}

// A charge that did not go through: audited under its own key (every real
// attempt is its own fact), never posted, recorded on the account as history.
async function recordFailedAttempt({ account, paymentId, amountCents, txId, reason, actor, correlationId }) {
  const recorded = await recordSafely({
    auditKey: deriveAuditKey(txId, "failed:" + crypto.randomUUID()),
    transaction: transactionFor(account, txId, amountCents, "Failed customer payment " + paymentId),
    completed: false,
    reason: reason,
    actor: actor,
    correlationId: correlationId,
  });
  store.recordPayment(account.accountId, {
    paymentId: paymentId,
    amountCents: amountCents,
    status: "failed",
    reason: reason,
  });
  return recorded.audited === true;
}

async function makePayment({
  accountId,
  customerId,
  paymentId,
  amountCents,
  correlationId = null,
  charge = defaultCharge,
  chargeTimeoutMs = CHARGE_TIMEOUT_MS,
}) {
  if (typeof paymentId !== "string" || !ID_PATTERN.test(paymentId)) {
    return refuse("invalid", "ValidationError", "paymentId must be 1-64 letters, digits, - or _");
  }
  const account = store.getAccount(accountId);
  if (!account || account.customerId !== customerId) {
    return refuse("not_found", "NotFoundError", "No such payment account.");
  }

  const txId = transactionIdFor(account.accountId, paymentId);
  const successKey = deriveAuditKey(txId, "succeeded");
  const context = { account, paymentId, txId, successKey, actor: customerId, correlationId };

  const confirmed = findConfirmedCharge(account, paymentId, successKey);
  if (confirmed) {
    if (confirmed.amountCents !== amountCents) {
      return refuse("conflict", "ConflictError", "This payment id was already used for a different amount.");
    }
    return finalise(Object.assign({ amountCents: amountCents, replay: true }, context));
  }

  if (account.balanceCents === null) {
    logFailure(SERVICE_NAME, "payment_account_unreadable", "ContractViolation", 0, { accountId: accountId });
    return refuse("account_error", "ContractViolation", "This account cannot take payments right now.");
  }
  const amount = validatePaymentAmount(amountCents, account.balanceCents);
  if (!amount.ok) {
    return refuse("invalid", "ValidationError", amount.problem);
  }

  const result = await callWithRetry(
    charge,
    { customerId: customerId, amountCents: amountCents, currency: account.currency, idempotencyKey: txId },
    chargeTimeoutMs,
    1
  );

  if (!result.ok) {
    const failure = classifyFailure(result);
    logFailure(SERVICE_NAME, "payment_charge_failed", failure.errorClass, result.attempts, { paymentId: paymentId });
    const logged = await recordFailedAttempt(
      Object.assign({ amountCents: amountCents, reason: "processor_" + failure.status }, context)
    );
    return refuse(
      "payment_error",
      failure.errorClass,
      "We could not reach the payment processor. Your balance has not changed; please try again.",
      { paymentId: paymentId, retryable: true, transactionLogged: logged, balanceCents: account.balanceCents }
    );
  }

  const outcome = result.value;
  if (!outcome || outcome.success !== true) {
    const logged = await recordFailedAttempt(
      Object.assign({ amountCents: amountCents, reason: "payment_declined" }, context)
    );
    return refuse(
      "payment_failed",
      "PaymentDeclined",
      (outcome && outcome.message) || "Payment could not be processed.",
      { paymentId: paymentId, retryable: true, transactionLogged: logged, balanceCents: account.balanceCents }
    );
  }

  // The books follow what the processor says it charged.
  return finalise(Object.assign({ amountCents: outcome.amountCents, replay: false }, context));
}

module.exports = { makePayment, transactionIdFor, CHARGE_TIMEOUT_MS };
