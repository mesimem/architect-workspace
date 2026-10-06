// STORY-011, the account book. Runs in memory (COLABERRY_DATA_DIR unset);
// surviving a restart is proven separately in
// paymentAccountStore.durability.test.js, in a second process.
//
// Account used throughout: CUST-1 owes $5,000.00 (500000 cents) on TRIP-1.

const assert = require("assert");

const store = require("./paymentAccountStore");
const { getAuditEntries } = require("../audit/auditLog");

function silenceStderr(fn) {
  const original = console.error;
  console.error = function () {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function main() {
  // Opening an account.
  const opened = store.openAccount({
    customerId: "CUST-1",
    tripRef: "TRIP-1",
    totalCents: 500000,
    openedBy: "FIN-1",
  });
  assert.strictEqual(opened.status, "opened");
  assert.strictEqual(opened.account.accountId, "PA-CUST-1-TRIP-1");
  assert.strictEqual(opened.account.balanceCents, 500000);
  assert.strictEqual(opened.account.paidCents, 0);
  const accountId = opened.account.accountId;
  console.log("paymentAccountStore: an account opens with the full total owed");

  // Opening is a change, so it is audited, by the staff user who did it.
  const openedEntries = getAuditEntries().filter(function (e) {
    return e.event === "payments.account.opened" && e.resource === accountId;
  });
  assert.strictEqual(openedEntries.length, 1);
  assert.strictEqual(openedEntries[0].actor, "FIN-1");
  assert.strictEqual(openedEntries[0].context.totalCents, 500000);
  console.log("paymentAccountStore: opening an account is audited");

  // Reopening is idempotent; a different total is refused, not overwritten.
  const again = store.openAccount({
    customerId: "CUST-1",
    tripRef: "TRIP-1",
    totalCents: 500000,
    openedBy: "FIN-1",
  });
  assert.strictEqual(again.status, "already_open");
  assert.strictEqual(
    getAuditEntries().filter(function (e) {
      return e.event === "payments.account.opened" && e.resource === accountId;
    }).length,
    1,
    "a replayed open is audited once"
  );
  const changed = store.openAccount({
    customerId: "CUST-1",
    tripRef: "TRIP-1",
    totalCents: 400000,
    openedBy: "FIN-1",
  });
  assert.strictEqual(changed.status, "conflict");
  assert.strictEqual(store.getAccount(accountId).totalCents, 500000);
  console.log("paymentAccountStore: reopening replays; a changed total is a conflict");

  // Malformed input never reaches the store.
  assert.strictEqual(
    store.openAccount({ customerId: "../etc", tripRef: "T", totalCents: 1, openedBy: "F" }).status,
    "invalid"
  );
  assert.strictEqual(
    store.openAccount({ customerId: "C", tripRef: "T", totalCents: 10.5, openedBy: "F" }).status,
    "invalid"
  );
  assert.strictEqual(
    store.openAccount({ customerId: "C", tripRef: "T", totalCents: 100, currency: "usd", openedBy: "F" })
      .status,
    "invalid"
  );
  console.log("paymentAccountStore: malformed accounts are refused");

  // A succeeded payment reduces the balance.
  const first = store.recordPayment(accountId, {
    paymentId: "PAY-1",
    amountCents: 150000,
    status: "succeeded",
  });
  assert.strictEqual(first.status, "recorded");
  assert.strictEqual(first.account.balanceCents, 350000);
  assert.strictEqual(store.getAccount(accountId).balanceCents, 350000);
  console.log("paymentAccountStore: a succeeded payment reduces the balance");

  // Replaying it changes nothing.
  const replay = store.recordPayment(accountId, {
    paymentId: "PAY-1",
    amountCents: 150000,
    status: "succeeded",
  });
  assert.strictEqual(replay.status, "replayed");
  assert.strictEqual(store.getAccount(accountId).balanceCents, 350000);
  assert.strictEqual(store.getAccount(accountId).payments.length, 1);
  console.log("paymentAccountStore: a replayed payment is not counted twice");

  // A failed payment is history only; a later success under the same id
  // supersedes it; a succeeded payment cannot be downgraded.
  const failed = store.recordPayment(accountId, {
    paymentId: "PAY-2",
    amountCents: 100000,
    status: "failed",
    reason: "payment_declined",
  });
  assert.strictEqual(failed.status, "recorded");
  assert.strictEqual(failed.account.balanceCents, 350000);
  const retried = store.recordPayment(accountId, {
    paymentId: "PAY-2",
    amountCents: 100000,
    status: "succeeded",
  });
  assert.strictEqual(retried.status, "superseded_failure");
  assert.strictEqual(retried.account.balanceCents, 250000);
  assert.strictEqual(retried.account.payments.length, 2);
  const downgrade = store.recordPayment(accountId, {
    paymentId: "PAY-2",
    amountCents: 100000,
    status: "failed",
  });
  assert.strictEqual(downgrade.status, "replayed");
  assert.strictEqual(store.getAccount(accountId).balanceCents, 250000);
  console.log("paymentAccountStore: a failed payment can be retried to success, never undone");

  // Unknown account, malformed payment.
  assert.strictEqual(
    store.recordPayment("PA-NOPE", { paymentId: "P", amountCents: 1, status: "succeeded" }).status,
    "not_found"
  );
  assert.strictEqual(
    store.recordPayment(accountId, { paymentId: "P", amountCents: -5, status: "succeeded" }).status,
    "invalid"
  );
  console.log("paymentAccountStore: unknown accounts and malformed payments are refused");

  // FAILURE PATH "balance not updated": a store whose write throws, and one
  // whose write silently does not land. Both are reported; neither is shown as
  // a moved balance.
  const realSet = store._store.set;
  store._store.set = function () {
    throw new Error("disk full");
  };
  const threw = silenceStderr(function () {
    return store.recordPayment(accountId, { paymentId: "PAY-3", amountCents: 1000, status: "succeeded" });
  });
  assert.strictEqual(threw.ok, false);
  assert.strictEqual(threw.status, "write_failed");
  store._store.set = function () {
    return this;
  };
  const lost = silenceStderr(function () {
    return store.recordPayment(accountId, { paymentId: "PAY-3", amountCents: 1000, status: "succeeded" });
  });
  assert.strictEqual(lost.status, "write_failed");
  assert.strictEqual(lost.errorClass, "ContractViolation");
  store._store.set = realSet;
  assert.strictEqual(store.getAccount(accountId).balanceCents, 250000);
  console.log("paymentAccountStore: a write that fails or does not land is reported");

  // Returned views are copies.
  const viewed = store.getAccount(accountId);
  viewed.payments[0].amountCents = 1;
  assert.strictEqual(store.getAccount(accountId).balanceCents, 250000);
  assert.strictEqual(store.listAccountsForCustomer("CUST-1").length, 1);
  assert.strictEqual(store.listAccountsForCustomer("CUST-2").length, 0);
  console.log("paymentAccountStore: reads return copies, scoped to the customer");

  console.log("paymentAccountStore: all tests passed");
}

main();
