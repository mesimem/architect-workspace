// STORY-001: mock payment processor — no real charge, deterministic outcome
// based on customerId so tests are repeatable. Replace with a real
// processor integration in a later story.

const DECLINED_CUSTOMERS = new Set(["CUST-DECLINED"]);

function processPayment({ customerId }) {
  if (DECLINED_CUSTOMERS.has(customerId)) {
    return { success: false, message: "Payment could not be processed." };
  }
  return { success: true };
}

module.exports = { processPayment, DECLINED_CUSTOMERS };
