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

// One row by tripId, or null. bookTripService uses it to recognise a booking
// it made before a restart, which its in-memory replay map has forgotten.
function findTransaction(tripId) {
  return (typeof tripId === "string" && TRANSACTIONS.get(tripId)) || null;
}

module.exports = { logTransaction, getLoggedTransactions, findTransaction };
