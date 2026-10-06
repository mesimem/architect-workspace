// STORY-011, the arithmetic. Every expected figure is WRITTEN OUT BY HAND, not
// recomputed from the implementation's formula, so a wrong formula fails here.
//
// Account used throughout: a $5,000.00 trip (500000 cents).

const assert = require("assert");

const {
  computeBalance,
  validateAccountTotal,
  validatePaymentAmount,
  MAX_AMOUNT_CENTS,
} = require("./balanceLedger");

function paid(paymentId, amountCents) {
  return { paymentId: paymentId, amountCents: amountCents, status: "succeeded" };
}

function declined(paymentId, amountCents) {
  return { paymentId: paymentId, amountCents: amountCents, status: "failed" };
}

function main() {
  // Happy path: nothing paid yet, then a deposit, then the rest.
  const fresh = computeBalance({ totalCents: 500000, payments: [] });
  assert.deepStrictEqual(fresh, {
    ok: true,
    totalCents: 500000,
    paidCents: 0,
    balanceCents: 500000,
    paymentCount: 0,
  });

  const afterDeposit = computeBalance({ totalCents: 500000, payments: [paid("PAY-1", 150000)] });
  assert.strictEqual(afterDeposit.balanceCents, 350000);
  assert.strictEqual(afterDeposit.paidCents, 150000);

  const settled = computeBalance({
    totalCents: 500000,
    payments: [paid("PAY-1", 150000), paid("PAY-2", 350000)],
  });
  assert.strictEqual(settled.balanceCents, 0);
  assert.strictEqual(settled.paymentCount, 2);
  console.log("balanceLedger: succeeded payments reduce the balance");

  // Failure path: a declined payment is history, not money.
  const withDecline = computeBalance({
    totalCents: 500000,
    payments: [declined("PAY-1", 150000), paid("PAY-2", 100000)],
  });
  assert.strictEqual(withDecline.balanceCents, 400000);
  assert.strictEqual(withDecline.paymentCount, 1);
  console.log("balanceLedger: a failed payment does not move the balance");

  // Idempotency: one paymentId recorded twice counts once.
  const duplicated = computeBalance({
    totalCents: 500000,
    payments: [paid("PAY-1", 150000), paid("PAY-1", 150000)],
  });
  assert.strictEqual(duplicated.balanceCents, 350000);
  console.log("balanceLedger: a duplicated paymentId is counted once");

  // Corrupt data is reported, never shown as a negative balance.
  const overpaid = computeBalance({ totalCents: 100000, payments: [paid("PAY-1", 150000)] });
  assert.strictEqual(overpaid.ok, false);
  assert.ok(overpaid.problems.includes("succeeded payments exceed the account total"));
  assert.strictEqual(computeBalance({ totalCents: 500000, payments: null }).ok, false);
  assert.strictEqual(computeBalance({ totalCents: 0, payments: [] }).ok, false);
  assert.strictEqual(
    computeBalance({ totalCents: 500000, payments: [{ paymentId: "PAY-1", status: "pending" }] }).ok,
    false
  );
  console.log("balanceLedger: corrupt account data is reported, not thrown");

  // Amount validation, checked before any charge.
  assert.strictEqual(validatePaymentAmount(150000, 500000).ok, true);
  assert.strictEqual(validatePaymentAmount(500000, 500000).ok, true); // boundary: exact payoff
  assert.strictEqual(validatePaymentAmount(500001, 500000).ok, false); // off by one cent
  assert.strictEqual(validatePaymentAmount(0, 500000).ok, false);
  assert.strictEqual(validatePaymentAmount(-100, 500000).ok, false);
  assert.strictEqual(validatePaymentAmount(100.5, 500000).ok, false); // fractional cents
  assert.strictEqual(validatePaymentAmount("150000", 500000).ok, false);
  assert.strictEqual(validatePaymentAmount(100, 0).ok, false); // nothing owed
  console.log("balanceLedger: payment amounts are validated before charging");

  assert.strictEqual(validateAccountTotal(500000).ok, true);
  assert.strictEqual(validateAccountTotal(MAX_AMOUNT_CENTS).ok, true);
  assert.strictEqual(validateAccountTotal(MAX_AMOUNT_CENTS + 1).ok, false);
  assert.strictEqual(validateAccountTotal(0).ok, false);
  console.log("balanceLedger: account totals are bounded");

  console.log("balanceLedger: all tests passed");
}

main();
