// STORY-001: mock payment processor — no real charge, deterministic outcome
// based on customerId so tests are repeatable. Replace with a real
// processor integration in a later story.
//
// STORY-004: it now takes and returns an AMOUNT. Before this it returned a bare
// { success: true }, which meant nothing downstream could say what had been
// charged - and an accounting integration that posts entries with no amount is
// not an accounting integration. A real processor tells you what it took; this
// mock does the same so the shape does not have to change when a real one lands.
//
// The returned amount is deliberately echoed from the request rather than
// recalculated. That mirrors how a real processor behaves (it confirms the
// charge it actually made) and it means the accounting entry is built from what
// the processor said, not from what the caller hoped.

const DECLINED_CUSTOMERS = new Set(["CUST-DECLINED"]);

// Integer cents only. A float amount is a rounding defect whose first visible
// symptom is a wrong number on a customer's invoice; the same rule is enforced
// at the accounting boundary in ../accounting/accountingClient.js.
function isChargeableAmount(amountCents) {
  return Number.isSafeInteger(amountCents) && amountCents > 0;
}

function processPayment({ customerId, amountCents, currency = "USD" }) {
  if (!isChargeableAmount(amountCents)) {
    return { success: false, message: "Payment amount is invalid." };
  }
  if (DECLINED_CUSTOMERS.has(customerId)) {
    return { success: false, message: "Payment could not be processed." };
  }
  return { success: true, amountCents: amountCents, currency: currency };
}

module.exports = { processPayment, isChargeableAmount, DECLINED_CUSTOMERS };
