// STORY-011: the book of payment accounts - one per customer per trip - and
// the payments made against each.
//
// WHY A SEPARATE ACCOUNT AND NOT THE BOOKING. bookTripService charges the full
// trip price at booking, so a booking never has anything left to pay. A balance
// needs something that is owed over time: a finance user opens an account for
// the trip total, and the customer pays it down in instalments. The booking
// path is untouched.
//
// WHAT IS STORED, AND WHAT IS NOT. The account holds the total owed and the
// list of payments. It does NOT hold a balance - balanceLedger.js derives that
// on every read, so there is no counter that a crash can leave stale.
//
// EVERY WRITE IS READ BACK. A payment is only reported as recorded once a
// fresh read of the store shows it on the account. That is the guard against
// the story's "balance not updated" failure path: if the write did not land,
// the caller is told so and can retry, rather than told the balance moved
// when it did not.
//
// IDEMPOTENCY.
//   - openAccount is keyed on (customerId, tripRef). Opening the same account
//     with the same total returns the original; a DIFFERENT total is refused,
//     because silently changing what a customer owes is not a replay.
//   - recordPayment is keyed on paymentId. A succeeded payment is final - a
//     replay returns it untouched. A failed payment MAY be superseded by a
//     later success under the same paymentId: that is what "retry the payment"
//     means, and refusing it would wedge the customer's key on a declined card.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every function returns a typed result and
//     never throws. A store write that throws or does not read back returns
//     { ok: false, status: "write_failed", errorClass }.
//  2. Will it retry? Not here - the caller retries with the same paymentId,
//     which is safe because of the idempotency rules above.
//  3. Recovery when retries are exhausted? The audit log (written by
//     transactionRecorder before any of this) holds the payment; a reconciler
//     compares it with this store.
//  4. Handled: malformed ids, totals and payments; reopening an account;
//     replaying a payment; a failed payment followed by a success; a write
//     that throws or does not land; data surviving a restart. NOT handled: two
//     processes writing the same account at once (single-process store; the
//     real fix is a Postgres unique constraint), refunds, currency conversion.

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");
const { computeBalance, validateAccountTotal, PAYMENT_STATUSES } = require("./balanceLedger");

const SERVICE_NAME = "payment-accounts";
const ACCOUNTS = createJsonFileStore("payment-accounts");

// Ids end up in keys, logs and URLs, so they are restricted to a safe alphabet
// rather than escaped at every use.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function accountIdFor(customerId, tripRef) {
  return "PA-" + customerId + "-" + tripRef;
}

function logStoreFailure(event, errorClass, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: SERVICE_NAME,
      event: event,
      outcome: "failure",
      error_class: errorClass,
      context: context,
    })
  );
}

// Copies out, so a caller editing the returned object cannot edit the store.
function view(account) {
  const balance = computeBalance({ totalCents: account.totalCents, payments: account.payments });
  return {
    accountId: account.accountId,
    customerId: account.customerId,
    tripRef: account.tripRef,
    currency: account.currency,
    openedBy: account.openedBy,
    openedAt: account.openedAt,
    totalCents: account.totalCents,
    paidCents: balance.ok ? balance.paidCents : null,
    balanceCents: balance.ok ? balance.balanceCents : null,
    balanceProblems: balance.ok ? [] : balance.problems,
    payments: account.payments.map(function (p) {
      return Object.assign({}, p);
    }),
  };
}

// The single write path. Writes, then reads back and checks `landed`.
function writeVerified(accountId, account, landed, context) {
  try {
    ACCOUNTS.set(accountId, account);
  } catch (error) {
    const errorClass = error && error.errorClass ? error.errorClass : "StoreWriteError";
    logStoreFailure("payment_account_write_failed", errorClass, context);
    return { ok: false, status: "write_failed", errorClass: errorClass };
  }
  const stored = ACCOUNTS.get(accountId);
  if (!stored || !landed(stored)) {
    logStoreFailure("payment_account_write_not_visible", "ContractViolation", context);
    return { ok: false, status: "write_failed", errorClass: "ContractViolation" };
  }
  return { ok: true, stored: stored };
}

// Returns { ok: true, status: "opened" | "already_open", account }
//      or { ok: false, status: "invalid" | "conflict" | "write_failed", ... }.
function openAccount({ customerId, tripRef, totalCents, currency = "USD", openedBy, correlationId = null }) {
  const problems = [];
  if (!isId(customerId)) problems.push("customerId must be 1-64 letters, digits, - or _");
  if (!isId(tripRef)) problems.push("tripRef must be 1-64 letters, digits, - or _");
  if (!isId(openedBy)) problems.push("openedBy must identify the staff user");
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    problems.push("currency must be a 3-letter uppercase ISO 4217 code");
  }
  const total = validateAccountTotal(totalCents);
  if (!total.ok) problems.push(total.problem);
  if (problems.length > 0) {
    return { ok: false, status: "invalid", errorClass: "ValidationError", problems: problems };
  }

  const accountId = accountIdFor(customerId, tripRef);
  const existing = ACCOUNTS.get(accountId);
  if (existing) {
    if (existing.totalCents === totalCents && existing.currency === currency) {
      return { ok: true, status: "already_open", account: view(existing) };
    }
    return {
      ok: false,
      status: "conflict",
      errorClass: "ConflictError",
      problems: ["an account for this customer and trip already exists with a different total"],
    };
  }

  // Setting what a customer owes is a change, so it is audited - BEFORE the
  // write, and keyed on the account so a replayed open records once. No audit,
  // no account: an amount owed that nobody can trace is worse than a refusal.
  try {
    recordAudit({
      auditKey: deriveAuditKey(accountId, "opened"),
      event: "payments.account.opened",
      outcome: "success",
      actor: openedBy,
      resource: accountId,
      correlationId: correlationId,
      context: { customerId: customerId, tripRef: tripRef, totalCents: totalCents, currency: currency },
    });
  } catch (error) {
    const errorClass = error && error.errorClass ? error.errorClass : "AuditWriteError";
    logStoreFailure("payment_account_not_audited", errorClass, { accountId: accountId });
    return { ok: false, status: "write_failed", errorClass: errorClass };
  }

  const account = {
    accountId: accountId,
    customerId: customerId,
    tripRef: tripRef,
    currency: currency,
    totalCents: totalCents,
    openedBy: openedBy,
    openedAt: new Date().toISOString(),
    payments: [],
  };
  const written = writeVerified(accountId, account, function (stored) {
    return stored.totalCents === totalCents;
  }, { accountId: accountId });
  if (!written.ok) return written;
  return { ok: true, status: "opened", account: view(written.stored) };
}

function validatePayment(payment) {
  const problems = [];
  if (!payment || typeof payment !== "object") return ["payment must be an object"];
  if (!isId(payment.paymentId)) problems.push("paymentId must be 1-64 letters, digits, - or _");
  if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents <= 0) {
    problems.push("amountCents must be a positive whole number of cents");
  }
  if (!PAYMENT_STATUSES.includes(payment.status)) {
    problems.push("status must be one of " + PAYMENT_STATUSES.join(", "));
  }
  return problems;
}

// Returns { ok: true, status: "recorded" | "replayed" | "superseded_failure", account, payment }
//      or { ok: false, status: "invalid" | "not_found" | "write_failed", ... }.
function recordPayment(accountId, payment) {
  const problems = validatePayment(payment);
  if (problems.length > 0) {
    return { ok: false, status: "invalid", errorClass: "ValidationError", problems: problems };
  }
  const existing = typeof accountId === "string" ? ACCOUNTS.get(accountId) : undefined;
  if (!existing) {
    return { ok: false, status: "not_found", errorClass: "NotFoundError" };
  }

  const prior = existing.payments.find(function (p) {
    return p.paymentId === payment.paymentId;
  });
  // A succeeded payment is final, and a repeated failure adds nothing new.
  if (prior && (prior.status === "succeeded" || payment.status === "failed")) {
    return {
      ok: true,
      status: "replayed",
      account: view(existing),
      payment: Object.assign({}, prior),
    };
  }

  const entry = {
    paymentId: payment.paymentId,
    amountCents: payment.amountCents,
    status: payment.status,
    reason: typeof payment.reason === "string" ? payment.reason : null,
    processedAt: new Date().toISOString(),
  };
  // A new array, not a push onto the stored one, so a failed write cannot
  // leave a half-applied change sitting in memory.
  const others = existing.payments.filter(function (p) {
    return p.paymentId !== payment.paymentId;
  });
  const updated = Object.assign({}, existing, { payments: others.concat([entry]) });

  const written = writeVerified(accountId, updated, function (stored) {
    return stored.payments.some(function (p) {
      return p.paymentId === entry.paymentId && p.status === entry.status;
    });
  }, { accountId: accountId, paymentId: entry.paymentId });
  if (!written.ok) return written;

  return {
    ok: true,
    status: prior ? "superseded_failure" : "recorded",
    account: view(written.stored),
    payment: Object.assign({}, entry),
  };
}

function getAccount(accountId) {
  const account = typeof accountId === "string" ? ACCOUNTS.get(accountId) : undefined;
  return account ? view(account) : null;
}

function listAccountsForCustomer(customerId) {
  return Array.from(ACCOUNTS.values())
    .filter(function (account) {
      return account.customerId === customerId;
    })
    .map(view);
}

module.exports = {
  openAccount,
  recordPayment,
  getAccount,
  listAccountsForCustomer,
  accountIdFor,
  // Exposed for tests that need to simulate a store that fails to write.
  _store: ACCOUNTS,
};
