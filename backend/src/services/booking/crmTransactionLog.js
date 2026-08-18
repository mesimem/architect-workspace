// STORY-001: in-memory stand-in for CRM transaction logging until a real
// CRM integration exists. Idempotent by tripId: logging the same trip twice
// must not create a duplicate entry.

const TRANSACTIONS = new Map();

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
