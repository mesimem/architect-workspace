// STORY-011, the payment flow. Each acceptance criterion and each named
// failure path has its own block below, labelled.
//
// Every test counts calls to the processor, because "retry is safe" is only
// proven by showing the card was NOT charged a second time.

// Deterministic accounting, as in bookTripService.test.js: with no token the
// client refuses to post, and these tests would pass or fail for that reason.
process.env.COLABERRY_ACCOUNTING_API_TOKEN = "test-token-not-a-secret";

const assert = require("assert");

const { makePayment, transactionIdFor } = require("./customerPaymentService");
const store = require("./paymentAccountStore");
const { getLedger } = require("../accounting/accountingClient");
const { getAuditEntries } = require("../audit/auditLog");

let calls = 0;
function approving({ amountCents, currency }) {
  calls += 1;
  return { success: true, amountCents: amountCents, currency: currency };
}
function declining() {
  calls += 1;
  return { success: false, message: "Payment could not be processed." };
}
function hanging() {
  calls += 1;
  return new Promise(function () {});
}

function open(customerId, tripRef, totalCents) {
  return store.openAccount({ customerId, tripRef, totalCents, openedBy: "FIN-1" }).account.accountId;
}

function auditFor(accountId, paymentId) {
  const txId = transactionIdFor(accountId, paymentId);
  return getAuditEntries().filter(function (e) {
    return e.event === "transaction.processed" && e.resource === txId;
  });
}

function ledgerFor(accountId, paymentId) {
  const txId = transactionIdFor(accountId, paymentId);
  return getLedger().filter(function (r) {
    return r.transactionId === txId;
  });
}

async function quietly(fn) {
  const original = console.error;
  console.error = function () {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

async function main() {
  // $5,000.00 owed.
  const acct = open("CUST-1", "TRIP-1", 500000);

  // ACCEPTANCE 1: a payment is made, processed, and the balance is updated.
  calls = 0;
  const paid = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-1", amountCents: 150000, charge: approving });
  });
  assert.strictEqual(paid.status, "paid");
  assert.strictEqual(paid.balanceCents, 350000);
  assert.strictEqual(store.getAccount(acct).balanceCents, 350000);
  assert.strictEqual(paid.transactionLogged, true);
  assert.strictEqual(paid.accounting.posted, true);
  assert.strictEqual(calls, 1);
  console.log("customerPayments: AC1 a processed payment updates the balance");

  // TRUST: the payment is in the audit log and, being a success, in the books.
  const audited = auditFor(acct, "PAY-1");
  assert.strictEqual(audited.length, 1);
  assert.strictEqual(audited[0].outcome, "success");
  assert.strictEqual(audited[0].actor, "CUST-1");
  assert.strictEqual(audited[0].context.amountCents, 150000);
  assert.strictEqual(ledgerFor(acct, "PAY-1").length, 1);
  console.log("customerPayments: TRUST a successful payment is audited and posted");

  // IDEMPOTENCY: the same payment again charges nothing and changes nothing.
  const again = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-1", amountCents: 150000, charge: approving });
  });
  assert.strictEqual(again.status, "already_paid");
  assert.strictEqual(again.balanceCents, 350000);
  assert.strictEqual(calls, 1);
  assert.strictEqual(ledgerFor(acct, "PAY-1").length, 1);
  const reused = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-1", amountCents: 1, charge: approving });
  });
  assert.strictEqual(reused.status, "conflict");
  assert.strictEqual(calls, 1);
  console.log("customerPayments: a repeated payment id never charges twice");

  // ACCEPTANCE 2 + FAILURE PATH "payment failure": declined, then retried.
  const declined = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-2", amountCents: 100000, charge: declining });
  });
  assert.strictEqual(declined.ok, false);
  assert.strictEqual(declined.status, "payment_failed");
  assert.strictEqual(declined.retryable, true);
  assert.ok(declined.message.length > 0);
  assert.strictEqual(declined.balanceCents, 350000);
  assert.strictEqual(store.getAccount(acct).balanceCents, 350000);
  assert.strictEqual(ledgerFor(acct, "PAY-2").length, 0); // a failure never reaches the books

  const declinedAgain = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-2", amountCents: 100000, charge: declining });
  });
  assert.strictEqual(declinedAgain.status, "payment_failed"); // retry fails: shows an error

  const retried = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-2", amountCents: 100000, charge: approving });
  });
  assert.strictEqual(retried.status, "paid"); // retry succeeds: processed again
  assert.strictEqual(retried.balanceCents, 250000);
  assert.strictEqual(ledgerFor(acct, "PAY-2").length, 1);

  // TRUST: all three attempts are on record - two failures, one success.
  const attempts = auditFor(acct, "PAY-2");
  assert.strictEqual(attempts.filter((e) => e.outcome === "failure").length, 2);
  assert.strictEqual(attempts.filter((e) => e.outcome === "success").length, 1);
  console.log("customerPayments: AC2 a failed payment shows an error, and a retry processes it");

  // The real mock processor's declined customer, end to end with no injection.
  const declinedAcct = open("CUST-DECLINED", "TRIP-9", 200000);
  const realDecline = await quietly(function () {
    return makePayment({ accountId: declinedAcct, customerId: "CUST-DECLINED", paymentId: "PAY-9", amountCents: 50000 });
  });
  assert.strictEqual(realDecline.status, "payment_failed");
  assert.strictEqual(store.getAccount(declinedAcct).balanceCents, 200000);
  console.log("customerPayments: the default processor's decline is handled");

  // A processor that hangs: bounded by the timeout, one attempt, audited.
  calls = 0;
  const timedOut = await quietly(function () {
    return makePayment({
      accountId: acct,
      customerId: "CUST-1",
      paymentId: "PAY-3",
      amountCents: 1000,
      charge: hanging,
      chargeTimeoutMs: 50,
    });
  });
  assert.strictEqual(timedOut.status, "payment_error");
  assert.strictEqual(timedOut.errorClass, "TimeoutError");
  assert.strictEqual(calls, 1); // never retried automatically
  assert.strictEqual(store.getAccount(acct).balanceCents, 250000);
  assert.strictEqual(auditFor(acct, "PAY-3")[0].outcome, "failure");
  console.log("customerPayments: a hung processor times out after one attempt");

  // FAILURE PATH "balance not updated": charged, but the account write fails.
  calls = 0;
  const realSet = store._store.set;
  store._store.set = function () {
    throw new Error("disk full");
  };
  const stuck = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-4", amountCents: 50000, charge: approving });
  });
  store._store.set = realSet;
  assert.strictEqual(stuck.ok, false);
  assert.strictEqual(stuck.status, "balance_not_updated");
  assert.strictEqual(stuck.charged, true);
  assert.strictEqual(stuck.transactionLogged, true); // audit landed first
  assert.strictEqual(store.getAccount(acct).balanceCents, 250000);

  // The retry finds the charge in the audit log and finishes WITHOUT charging.
  const healed = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-4", amountCents: 50000, charge: approving });
  });
  assert.strictEqual(healed.status, "already_paid");
  assert.strictEqual(healed.balanceCents, 200000);
  assert.strictEqual(calls, 1);
  assert.strictEqual(ledgerFor(acct, "PAY-4").length, 1);
  console.log("customerPayments: a balance that failed to update is fixed by a retry, no second charge");

  // Refusals that never reach the processor.
  calls = 0;
  const over = await makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-5", amountCents: 200001, charge: approving });
  assert.strictEqual(over.status, "invalid");
  const fractional = await makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-5", amountCents: 10.5, charge: approving });
  assert.strictEqual(fractional.status, "invalid");
  const badId = await makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "x y", amountCents: 100, charge: approving });
  assert.strictEqual(badId.status, "invalid");
  const notMine = await makePayment({ accountId: acct, customerId: "CUST-2", paymentId: "PAY-6", amountCents: 100, charge: approving });
  assert.strictEqual(notMine.status, "not_found");
  const missing = await makePayment({ accountId: "PA-NOPE", customerId: "CUST-1", paymentId: "PAY-7", amountCents: 100, charge: approving });
  assert.strictEqual(missing.status, "not_found");
  assert.strictEqual(calls, 0);
  assert.strictEqual(store.getAccount(acct).balanceCents, 200000);
  console.log("customerPayments: invalid, over-balance and other customers' payments are refused before charging");

  // Paying off exactly, then nothing more can be charged.
  const payoff = await quietly(function () {
    return makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-8", amountCents: 200000, charge: approving });
  });
  assert.strictEqual(payoff.balanceCents, 0);
  const extra = await makePayment({ accountId: acct, customerId: "CUST-1", paymentId: "PAY-10", amountCents: 1, charge: approving });
  assert.strictEqual(extra.status, "invalid");
  console.log("customerPayments: a settled account takes no further payments");

  console.log("customerPayments: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
