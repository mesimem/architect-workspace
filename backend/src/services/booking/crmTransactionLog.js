// STORY-001: in-memory stand-in for CRM transaction logging until a real
// CRM integration exists. Idempotent by tripId: logging the same trip twice
// must not create a duplicate entry.

const { createJsonFileStore } = require("../shared/jsonFileStore");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise (STORY-003).
// A CRM transaction log that forgets every booking on restart is the clearest
// case of the audit guardrail going unmet.
const TRANSACTIONS = createJsonFileStore("crm-transactions");

function logTransaction(record) {
  if (TRANSACTIONS.has(record.tripId)) {
    return TRANSACTIONS.get(record.tripId);
  }
  TRANSACTIONS.set(record.tripId, record);
  return record;
}

function getLoggedTransactions() {
  return Array.from(TRANSACTIONS.values());
}

module.exports = { logTransaction, getLoggedTransactions };
