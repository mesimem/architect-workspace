// STORY-011: what a customer owes, worked out from what they were charged and
// what they have successfully paid. PURE - no store, no clock, no I/O - so the
// arithmetic can be tested on its own and every other module asks THIS file
// rather than doing its own subtraction.
//
// THE BALANCE IS DERIVED, NEVER STORED. The account keeps the total owed and
// the list of payments; the balance is recomputed from them on every read.
// A stored balance is a second copy of the truth, and the failure path "balance
// not updated" is exactly what happens when the copy and the payments drift
// apart - a payment lands, the counter update does not. With nothing to update,
// there is nothing to forget to update.
//
// ONLY A SUCCEEDED PAYMENT REDUCES THE BALANCE. A declined payment stays on the
// account as history (the customer tried, and the audit log says so) but it
// moved no money, so it must not move the balance either.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Nothing throws. Malformed input returns
//     { ok: false, problems } so the caller can refuse the request cleanly.
//  2. Will it retry? Nothing to retry - this is arithmetic.
//  3. Recovery? Not applicable; callers decide what to do with ok: false.
//  4. Handled: float or negative amounts, amounts past the ceiling, paying
//     more than is owed, a payment recorded twice under one paymentId, and a
//     payment list whose succeeded total exceeds the account total (corrupt
//     data, reported rather than shown as a negative balance). NOT handled:
//     currency conversion (one account, one currency) and refunds (a separate
//     entryType and a separate story).

// $100,000 in cents. A per-trip ceiling well above any real African itinerary
// in this catalog; its job is to catch a typo'd extra zero, not to cap sales.
const MAX_AMOUNT_CENTS = 10000000;

const PAYMENT_STATUSES = Object.freeze(["succeeded", "failed"]);

function isWholeCents(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT_CENTS;
}

// The total a finance user opens an account with.
function validateAccountTotal(totalCents) {
  if (!isWholeCents(totalCents)) {
    return {
      ok: false,
      problem: "totalCents must be a whole number of cents between 1 and " + MAX_AMOUNT_CENTS,
    };
  }
  return { ok: true };
}

// Called BEFORE the processor is asked to charge anything, so an overpayment
// or a malformed amount costs nothing and never reaches the card.
function validatePaymentAmount(amountCents, balanceCents) {
  if (!isWholeCents(amountCents)) {
    return {
      ok: false,
      problem: "amountCents must be a whole number of cents between 1 and " + MAX_AMOUNT_CENTS,
    };
  }
  if (!Number.isSafeInteger(balanceCents) || balanceCents <= 0) {
    return { ok: false, problem: "nothing is owed on this account" };
  }
  if (amountCents > balanceCents) {
    return { ok: false, problem: "amountCents exceeds the remaining balance" };
  }
  return { ok: true };
}

// Returns { ok: true, totalCents, paidCents, balanceCents, paymentCount }
//      or { ok: false, problems }.
function computeBalance({ totalCents, payments }) {
  const problems = [];
  if (!isWholeCents(totalCents)) {
    problems.push("totalCents is not a valid amount");
  }
  if (!Array.isArray(payments)) {
    problems.push("payments must be an array");
  }
  if (problems.length > 0) {
    return { ok: false, problems: problems };
  }

  // Counted once per paymentId. The store should never hold a duplicate, but
  // if one slipped in, counting it twice would silently under-report what the
  // customer owes - the most expensive direction for this number to be wrong.
  const counted = new Set();
  let paidCents = 0;
  for (const payment of payments) {
    if (!payment || typeof payment.paymentId !== "string") {
      problems.push("a payment has no paymentId");
      continue;
    }
    if (!PAYMENT_STATUSES.includes(payment.status)) {
      problems.push("payment " + payment.paymentId + " has an unknown status");
      continue;
    }
    if (payment.status !== "succeeded" || counted.has(payment.paymentId)) {
      continue;
    }
    if (!isWholeCents(payment.amountCents)) {
      problems.push("payment " + payment.paymentId + " has an invalid amount");
      continue;
    }
    counted.add(payment.paymentId);
    paidCents += payment.amountCents;
  }

  if (paidCents > totalCents) {
    problems.push("succeeded payments exceed the account total");
  }
  if (problems.length > 0) {
    return { ok: false, problems: problems };
  }

  return {
    ok: true,
    totalCents: totalCents,
    paidCents: paidCents,
    balanceCents: totalCents - paidCents,
    paymentCount: counted.size,
  };
}

module.exports = {
  computeBalance,
  validateAccountTotal,
  validatePaymentAmount,
  MAX_AMOUNT_CENTS,
  PAYMENT_STATUSES,
};
