// STORY-004: the boundary between this system and the accounting software.
//
// NOTHING HERE MAKES A REAL HTTP CALL. The default transport appends to an
// in-memory ledger, exactly as advisor/advisorNotifier.js does for advisor
// paging. Wiring a real vendor (QuickBooks, Xero, NetSuite) needs credentials
// this repo deliberately does not hold, and CLAUDE.md forbids tests touching
// real external systems. The real call slots in behind the injected `post`
// argument, and everything below - validation, timeout, capped retries, the
// auth contract, idempotency, the failure shapes - applies to it unchanged.
//
// THE RULE THAT MATTERS: ONLY A COMPLETED TRANSACTION REACHES THE BOOKS.
// This module posts what it is given and nothing else. Deciding WHICH
// transactions are completed is not its job - that is accounting/
// transactionRecorder.js, which also writes the audit entry that must exist for
// every transaction whether or not it was posted. Keeping the decision out of
// here is what keeps "log everything" and "post only successes" from fighting.
//
// NEVER THROWS. Every path returns a typed `status`, because the caller is in
// the middle of answering a customer and a bookkeeping problem must not turn a
// completed booking into an unhandled exception. The money already moved; the
// worst thing this module could do is hide that by crashing.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? The caller gets { posted: false } with a
//     status and a stable errorClass. The transaction is NOT recorded as
//     posted, so a later sweep or retry will try again. The audit entry that
//     proves the attempt happened is written by the recorder, before this is
//     ever called.
//  2. Will it retry? Only a timeout, at most DEFAULT_MAX_ATTEMPTS times with a
//     fixed pause - the shared policy in shared/callWithRetry.js. A transport
//     that THROWS is not retried, which is precisely why a rejected credential
//     costs one call and not a retry storm against something that will keep
//     saying no.
//  3. Recovery when retries are exhausted? The transaction stays absent from
//     POSTED, so re-running the same post with the same transactionId will
//     attempt it again and cannot duplicate it (see idempotency below). There
//     is no dead-letter store yet; inventing one before there is a real API to
//     fail against would be pretend machinery. What exists instead is honest
//     reporting plus an audit entry, so the gap is findable.
//  4. Handled here: malformed transaction data, a missing or rejected
//     credential, a slow transport, a throwing transport, the same transaction
//     posted twice, posting again after a restart, and a transport that
//     reports success in the wrong shape. NOT handled: partial posts inside a
//     multi-line journal entry (we post one transaction at a time), currency
//     conversion, and two processes posting concurrently for one transaction -
//     this store is single-process, and the real fix is a unique constraint in
//     Postgres, same as everywhere else in this repo.
//
// THE TIMEOUT / DOUBLE-POST PROBLEM, STATED PLAINLY. A timeout does not mean
// the far side did nothing; it means we stopped waiting. The retry could
// therefore land a second copy of a transaction that already posted. The fix is
// not on our side of the wire: we send `transactionId` to the transport as the
// idempotency key, so the accounting API dedups our retry the way we dedup our
// callers. A vendor without an idempotency key must be reconciled instead, and
// that is a decision for whoever picks the vendor - it is flagged here rather
// than papered over.

const { createJsonFileStore } = require("../shared/jsonFileStore");
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  callWithRetry,
  classifyFailure,
  logFailure,
} = require("../shared/callWithRetry");

const SERVICE_NAME = "accounting";

// Durable, unlike the advisor notifier's in-memory Set. The consequence of
// forgetting a paged advisor is a second page; the consequence of forgetting a
// posted transaction is a duplicate entry in someone's books.
const POSTED = createJsonFileStore("accounting-posted");

// Stand-in for the real ledger. Exported so tests and the demo can read what
// would have been sent.
const LEDGER = [];

const ENTRY_TYPES = ["sale", "refund"];
const MIN_ID_LENGTH = 8;
const MAX_ID_LENGTH = 128;
const MAX_MEMO_LENGTH = 200;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// The transport throws this to say "your credential was rejected". A distinct
// class matters twice over: callWithRetry does not retry a throw, so an
// unauthorized attempt costs exactly one call; and the log carries the stable
// `AuthError` class CLAUDE.md asks for rather than a generic Error.
class AccountingAuthError extends Error {
  constructor(message = "The accounting API rejected the credential.") {
    super(message);
    this.name = "AccountingAuthError";
    this.errorClass = "AuthError";
  }
}

function readConfiguredToken() {
  const token = process.env.COLABERRY_ACCOUNTING_API_TOKEN;
  return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

// Field-level problems, described but never echoed. A transaction can arrive
// from an untrusted caller, and an error message is a log line, a response body
// and sometimes a screen - none of which should carry an attacker's string.
function validateTransaction(transaction) {
  if (!transaction || typeof transaction !== "object") {
    return [{ field: "transaction", problem: "must be an object" }];
  }

  const errors = [];
  const {
    transactionId,
    customerId,
    entryType,
    amountCents,
    currency,
    occurredAt,
    memo,
  } = transaction;

  if (
    typeof transactionId !== "string" ||
    transactionId.trim().length < MIN_ID_LENGTH ||
    transactionId.length > MAX_ID_LENGTH
  ) {
    errors.push({
      field: "transactionId",
      problem: "must be a string of " + MIN_ID_LENGTH + "-" + MAX_ID_LENGTH + " characters",
    });
  }
  if (typeof customerId !== "string" || customerId.trim() === "") {
    errors.push({ field: "customerId", problem: "must be a non-empty string" });
  }
  if (!ENTRY_TYPES.includes(entryType)) {
    errors.push({ field: "entryType", problem: "must be one of " + ENTRY_TYPES.join(", ") });
  }
  // Integer cents, never a float. A float amount is a rounding defect waiting
  // to happen, and the place it surfaces is a customer's invoice.
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    errors.push({ field: "amountCents", problem: "must be a positive whole number of cents" });
  }
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    errors.push({ field: "currency", problem: "must be a 3-letter uppercase ISO 4217 code" });
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    errors.push({ field: "occurredAt", problem: "must be an ISO 8601 timestamp" });
  }
  if (memo !== undefined && (typeof memo !== "string" || memo.length > MAX_MEMO_LENGTH)) {
    errors.push({
      field: "memo",
      problem: "must be a string of at most " + MAX_MEMO_LENGTH + " characters",
    });
  }

  return errors;
}

// The default transport. Deliberately dumb: it checks it was handed a
// credential and appends. The credential check is unreachable through
// postTransaction (which refuses earlier when none is configured) and exists so
// the stand-in cannot become the one component that treats auth as optional.
async function defaultAccountingPoster({ transaction, credentials, idempotencyKey }) {
  if (!credentials || typeof credentials.token !== "string" || credentials.token.trim() === "") {
    throw new AccountingAuthError("No credential was presented to the accounting API.");
  }
  const existing = LEDGER.find(function (row) {
    return row.idempotencyKey === idempotencyKey;
  });
  if (existing) {
    // What a real vendor does with a repeated idempotency key: return the
    // original entry rather than creating a second one.
    return { reference: existing.reference, replayed: true };
  }
  const reference = "ACCT-" + String(LEDGER.length + 1).padStart(6, "0");
  LEDGER.push({
    reference: reference,
    idempotencyKey: idempotencyKey,
    transactionId: transaction.transactionId,
    customerId: transaction.customerId,
    entryType: transaction.entryType,
    amountCents: transaction.amountCents,
    currency: transaction.currency,
    occurredAt: transaction.occurredAt,
    memo: transaction.memo || null,
  });
  return { reference: reference, replayed: false };
}

function getLedger() {
  return LEDGER.map(function (row) {
    return Object.assign({}, row);
  });
}

function logAccountingEvent(event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      service: SERVICE_NAME,
      event: event,
      outcome: "success",
      context: context,
    })
  );
}

// Returns one of:
//   { status: "posted",            posted: true,  replayed: false, reference }
//   { status: "already_posted",    posted: true,  replayed: true,  reference }
//   { status: "posted_unverified", posted: true,  reference: null }
//   { status: "invalid_transaction", posted: false, errors }
//   { status: "not_configured",    posted: false }
//   { status: "unauthorized",      posted: false }
//   { status: "timeout" | "unavailable", posted: false }
// Failures always carry an errorClass; anything that reached the wire carries
// `attempts`.
async function postTransaction({
  transaction,
  post = defaultAccountingPoster,
  token = readConfiguredToken(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  // Malformed data never reaches the wire. Validating here rather than trusting
  // the far side to reject it means a bad payload costs nothing and cannot half
  // land.
  const errors = validateTransaction(transaction);
  if (errors.length > 0) {
    logFailure(SERVICE_NAME, "accounting_post_refused", "ValidationError", 0, {
      fields: errors.map(function (e) {
        return e.field;
      }),
    });
    return { status: "invalid_transaction", posted: false, errorClass: "ValidationError", errors };
  }

  // No credential configured is a deployment fault, not a transaction fault. We
  // refuse loudly rather than skipping the books quietly - the audit entry the
  // recorder already wrote is what stops this being a silent loss.
  if (typeof token !== "string" || token.trim() === "") {
    logFailure(SERVICE_NAME, "accounting_not_configured", "ConfigError", 0, {
      transactionId: transaction.transactionId,
    });
    return {
      status: "not_configured",
      posted: false,
      errorClass: "ConfigError",
      message:
        "COLABERRY_ACCOUNTING_API_TOKEN is not set, so nothing can be posted to the accounting software.",
    };
  }

  // Idempotency, checked BEFORE the call so a retry cannot reach the API at
  // all. Durable, so this holds across a restart too.
  const already = POSTED.get(transaction.transactionId);
  if (already) {
    return {
      status: "already_posted",
      posted: true,
      replayed: true,
      reference: already.reference,
      attempts: 0,
    };
  }

  const result = await callWithRetry(
    post,
    {
      transaction: transaction,
      // The token is handed to the transport and never logged, never echoed in
      // a return value, never written to the audit trail.
      credentials: { token: token },
      // Sent so the far side can dedup our retry after a timeout. See the
      // header note on the double-post problem.
      idempotencyKey: transaction.transactionId,
    },
    timeoutMs,
    maxAttempts
  );

  if (!result.ok) {
    // Checked before classifyFailure so the log carries "AuthError" rather than
    // the class name of whatever the transport happened to throw.
    if (result.error instanceof AccountingAuthError) {
      logFailure(SERVICE_NAME, "accounting_post_unauthorized", "AuthError", result.attempts, {
        transactionId: transaction.transactionId,
      });
      return {
        status: "unauthorized",
        posted: false,
        errorClass: "AuthError",
        attempts: result.attempts,
      };
    }

    const failure = classifyFailure(result);
    logFailure(SERVICE_NAME, "accounting_post_failed", failure.errorClass, result.attempts, {
      transactionId: transaction.transactionId,
    });
    return {
      status: failure.status,
      posted: false,
      errorClass: failure.errorClass,
      attempts: result.attempts,
    };
  }

  const reference = result.value && result.value.reference;
  if (typeof reference !== "string" || reference === "") {
    // A transport that reports success without a reference has probably posted
    // something we can no longer name. We record it as posted ANYWAY - a
    // duplicate in the books is worse than an entry we cannot cite - and say
    // plainly that it needs reconciling.
    POSTED.set(transaction.transactionId, {
      reference: null,
      unverified: true,
      postedAt: new Date().toISOString(),
    });
    logFailure(SERVICE_NAME, "accounting_post_unverified", "ContractViolation", result.attempts, {
      transactionId: transaction.transactionId,
    });
    return {
      status: "posted_unverified",
      posted: true,
      replayed: false,
      reference: null,
      errorClass: "ContractViolation",
      attempts: result.attempts,
      message: "The accounting API reported success without a reference; reconcile this entry.",
    };
  }

  POSTED.set(transaction.transactionId, {
    reference: reference,
    unverified: false,
    postedAt: new Date().toISOString(),
  });
  logAccountingEvent("accounting_post_succeeded", {
    transactionId: transaction.transactionId,
    reference: reference,
    attempts: result.attempts,
  });

  return {
    status: "posted",
    posted: true,
    replayed: false,
    reference: reference,
    attempts: result.attempts,
  };
}

function findPosted(transactionId) {
  return POSTED.get(transactionId) || null;
}

module.exports = {
  postTransaction,
  validateTransaction,
  defaultAccountingPoster,
  getLedger,
  findPosted,
  AccountingAuthError,
  ENTRY_TYPES,
};
