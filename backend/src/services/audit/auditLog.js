// STORY-004: the audit trail. One entry per thing that happened, keyed so a
// retry cannot write it twice, durable so a restart cannot lose it.
//
// WHY THIS IS SEPARATE FROM THE ACCOUNTING CLIENT. REQ-017 ("the system must
// maintain audit logs for all transactions and changes") and REQ-004 ("the
// system must integrate with accounting software") pull in opposite
// directions, and the acceptance criteria for this story make the difference
// explicit:
//
//                     | completed transaction | failed transaction
//   ------------------|-----------------------|-------------------
//   audit log (here)  | entry written         | entry written
//   accounting API    | posted                | NOT posted
//
// So the audit trail is NOT "the things we sent to accounting". It is the
// record of everything we attempted, including what we deliberately refused to
// send and why. A log that only records successes cannot answer the question an
// audit log exists to answer: what happened to the transaction that is missing
// from the books?
//
// WHY IT LIVES IN ITS OWN FOLDER rather than under accounting/. REQ-017 says
// "all transactions AND CHANGES". Financial transactions are the first caller,
// not the only intended one - STORY-006's permission changes belong here too.
// Putting it under accounting/ would make every later caller look like a
// layering violation.
//
// APPEND-ONLY IS ENFORCED BY THE EXPORT LIST, NOT BY A COMMENT. There is no
// update and no delete on this module's surface. Stored entries are frozen and
// reads hand back copies, so a caller cannot rewrite history by mutating an
// object it was given. That is the whole point: an audit trail an application
// can edit is a diary, not evidence.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? recordAudit THROWS. It does not return a
//     status. Every other failure path in this repo returns data because the
//     caller can carry on without the dependency - here it cannot. An
//     unauditable transaction is a compliance hole, so callers must treat a
//     throw as a refusal to serve, exactly as the services already do for
//     africa/interactionLog.js. The one thing this module must never do is
//     shrug and return.
//  2. Will it retry? No, and it needs no retry: the only I/O is a local
//     synchronous file write, and the caller-supplied auditKey makes the
//     caller's own retry safe. A duplicate key returns the first entry
//     untouched rather than appending a second.
//  3. Recovery if it fails anyway? Two cases. A bad entry (ValidationError) is
//     a programming error in the caller and is fixed in code, not at runtime.
//     A disk failure propagates as the underlying fs error and takes the
//     request down with it, which is correct - see (1). A corrupt store file
//     refuses to load at startup; recovery is documented in jsonFileStore.js.
//  4. Handled here: replayed keys, unusable keys, missing or unknown event /
//     outcome, secrets pasted into context, callers mutating what they are
//     given, and loss on restart. NOT handled: two processes appending
//     concurrently (single-process store - the real fix is Postgres, as
//     everywhere else in this repo), tamper-evidence (no hash chain; a person
//     with disk access can still edit the JSON, and detecting that needs
//     signing we have no key management for), and retention or rotation.

const { createJsonFileStore } = require("../shared/jsonFileStore");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise. Unset is right
// for tests - see the reasoning in shared/jsonFileStore.js.
const ENTRIES = createJsonFileStore("audit-log");

// Same bounds as the booking idempotency key and the interaction key, so the
// three agree and a caller can pass one key through all of them.
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;

// A closed set on purpose. "pending" means we recorded the attempt before
// finding out how it went - the write-ahead case, where the entry exists even
// if the process dies mid-call.
const OUTCOMES = ["success", "failure", "pending"];

// Anything whose KEY looks like a credential is replaced before it is written.
// This is a backstop, not a licence: callers still must not put secrets in
// context. But an audit log is the one store that persists arbitrary
// caller-supplied context to disk forever, so a stray token here is a leak that
// outlives the incident that caused it.
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|apikey|api_key|authorization|auth|credential|cookie|card|cvv|ssn)/i;
const REDACTED = "<redacted>";

// Depth cap so a deeply nested or self-referential context cannot spin here.
const MAX_CONTEXT_DEPTH = 4;
const TRUNCATED = "<truncated>";

class InvalidAuditEntryError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidAuditEntryError";
    this.errorClass = "ValidationError";
  }
}

function isValidAuditKey(auditKey) {
  return (
    typeof auditKey === "string" &&
    auditKey.trim().length >= MIN_KEY_LENGTH &&
    auditKey.length <= MAX_KEY_LENGTH
  );
}

// Describes the SHAPE of a bad key, never its value - a key can arrive from
// somewhere untrusted and this string ends up in an error and a log line.
function describeKey(auditKey) {
  return typeof auditKey === "string"
    ? "a string of length " + auditKey.length
    : "type " + typeof auditKey;
}

function redact(value, depth) {
  if (depth > MAX_CONTEXT_DEPTH) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return redact(item, depth + 1);
    });
  }
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach(function (key) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(value[key], depth + 1);
    });
    return out;
  }
  return value;
}

// Frozen one level down as well, so `entry.context.amount = 0` fails too.
// Object.freeze is shallow, which would otherwise leave the interesting part
// of the entry writable.
function freezeEntry(entry) {
  if (entry.context && typeof entry.context === "object") {
    Object.freeze(entry.context);
  }
  return Object.freeze(entry);
}

// Structured JSON to stderr, per CLAUDE.md's observability rules. IDs and
// codes only.
function logAuditEvent(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: "audit-log",
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

// Returns { entry, replayed }. The `replayed` flag is what the accounting
// recorder uses to tell "we just recorded this" from "we already had it", so it
// can report a retry honestly instead of claiming new work.
//
// This differs from africa/interactionLog.js, which returns the bare entry.
// The difference is deliberate: that module's callers only need the row, this
// module's caller needs to branch on whether the row is new.
function recordAudit({ auditKey, event, outcome, actor, resource, context, correlationId }) {
  if (!isValidAuditKey(auditKey)) {
    throw new InvalidAuditEntryError(
      "auditKey must be a string of " +
        MIN_KEY_LENGTH +
        "-" +
        MAX_KEY_LENGTH +
        " characters; received " +
        describeKey(auditKey)
    );
  }
  if (typeof event !== "string" || event.trim() === "") {
    throw new InvalidAuditEntryError("event must be a non-empty string naming what happened.");
  }
  if (!OUTCOMES.includes(outcome)) {
    throw new InvalidAuditEntryError(
      "outcome must be one of " + OUTCOMES.join(", ") + "; received " + JSON.stringify(outcome)
    );
  }

  const existing = ENTRIES.get(auditKey);
  if (existing) {
    // First write wins. An audit entry is never overwritten, so a retry that
    // arrives with different content cannot quietly rewrite what we recorded
    // the first time.
    return { entry: existing, replayed: true };
  }

  const entry = freezeEntry({
    auditKey: auditKey,
    recordedAt: new Date().toISOString(),
    event: event,
    outcome: outcome,
    actor: typeof actor === "string" && actor !== "" ? actor : null,
    resource: typeof resource === "string" && resource !== "" ? resource : null,
    correlationId: typeof correlationId === "string" && correlationId !== "" ? correlationId : null,
    context: context && typeof context === "object" ? redact(context, 0) : null,
  });

  ENTRIES.set(auditKey, entry);
  logAuditEvent("info", "audit_entry_recorded", {
    auditKey: auditKey,
    event: event,
    outcome: outcome,
    resource: entry.resource,
  });

  return { entry: entry, replayed: false };
}

// Builds a key for "the same business event, but a different outcome".
//
// WHY THIS EXISTS, AND WHY GETTING IT WRONG IS SUBTLE. Entries are
// first-write-wins, which is what stops a retry rewriting history. The trap is
// that a caller keyed on its own business id alone (a booking key, a request
// id) will find its SECOND, different outcome silently discarded: a payment
// that was declined and then succeeded on retry would be recorded forever as
// declined. Including the outcome in the key means each distinct outcome is
// recorded once and a genuine repeat still dedups.
//
// The base is truncated if the discriminator would push the key over the
// store's limit - two bases would have to agree on their first ~110 characters
// to collide, which the keys in this repo cannot. Returns "" for an unusable
// base so recordAudit refuses it, rather than quietly auditing under a key like
// "undefined:confirmed".
function deriveAuditKey(base, discriminator) {
  if (typeof base !== "string" || base.trim() === "") {
    return "";
  }
  const suffix = ":" + discriminator;
  const room = MAX_KEY_LENGTH - suffix.length;
  return (base.length > room ? base.slice(0, room) : base) + suffix;
}

// Reads. All return frozen entries, so there is no copying to do and no way to
// mutate the store through what comes back.
function getAuditEntries() {
  return Array.from(ENTRIES.values());
}

function findAuditEntry(auditKey) {
  return ENTRIES.get(auditKey) || null;
}

function hasAuditEntry(auditKey) {
  return ENTRIES.has(auditKey);
}

module.exports = {
  recordAudit,
  deriveAuditKey,
  getAuditEntries,
  findAuditEntry,
  hasAuditEntry,
  isValidAuditKey,
  InvalidAuditEntryError,
  OUTCOMES,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
};
