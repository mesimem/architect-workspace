// STORY-019: where a customer can be emailed, and whether they agreed to be.
//
// WHY THIS EXISTS. Nothing else in the build holds a customer's email address
// - a customer is a customerId with bookings (crm/customerRecord.js), and
// portal identity holds no address. A campaign cannot invent one, so this is
// the one place an address is recorded for marketing, and a customer with no
// row here is skipped with "no_email_on_file" rather than guessed at.
//
// OPT-OUT WINS, ALWAYS. optedOut is checked before the address is used, and
// setting a new address does not clear an opt-out - only an explicit
// optedOut:false does. A customer who said no stays at no until they say yes.
//
// ONLY CUSTOMERS. Preferences are refused for a customerId with no bookings:
// the campaign rules only ever reach customers, and an address stored against
// an id nothing else knows is contact data with no purpose.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? { ok:false, reason, problems }, never a
//     throw; a change that cannot be audited is rolled back.
//  2. Will it retry? No - local store. Re-sending the same change is a no-op
//     that writes nothing and bumps no version.
//  3. Recovery path? Nothing to clean up after a refusal.
//  4. Handled: unknown customer, malformed email, empty or unknown fields,
//     lost write, audit failure. NOT handled: verifying the address actually
//     receives mail, and a customer-facing unsubscribe link (no portal route).

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { createAuditedCommit } = require("../shared/auditedCommit");
const { recordAudit } = require("../audit/auditLog");
const { getCustomerRecord, STATUSES } = require("../crm/customerRecord");

const CONTACTS = createJsonFileStore("marketing-contacts");
const guard = createAuditedCommit({ subject: "contact", service: "marketing" });

const MAX_EMAIL_LENGTH = 254;
// Deliberately loose: one @, something either side, a dot in the domain.
// Whether an address really receives mail is only known by sending to it.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = Object.freeze(["email", "optedOut"]);

const REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  NOT_FOUND: "not_found",
  NOT_SAVED: guard.REASONS.NOT_SAVED,
  AUDIT_UNAVAILABLE: guard.REASONS.AUDIT_UNAVAILABLE,
});

function validateChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    return [{ field: "body", problem: "must be an object" }];
  }
  const problems = [];
  Object.keys(change).forEach(function (key) {
    if (!FIELDS.includes(key)) problems.push({ field: key, problem: "is not a contact preference (" + FIELDS.join(", ") + ")" });
  });
  if (change.email === undefined && change.optedOut === undefined) {
    problems.push({ field: "body", problem: "must set email, optedOut, or both" });
  }
  if (change.email !== undefined &&
      (typeof change.email !== "string" || change.email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(change.email.trim()))) {
    problems.push({ field: "email", problem: "must be an email address" });
  }
  if (change.optedOut !== undefined && typeof change.optedOut !== "boolean") {
    problems.push({ field: "optedOut", problem: "must be true or false" });
  }
  return problems;
}

function setPreferences({ customerId, change, actor, correlationId }, deps = {}) {
  const store = deps.store || CONTACTS;
  const problems = validateChange(change);
  if (problems.length > 0) return { ok: false, reason: REASONS.INVALID_REQUEST, problems: problems };

  const customer = (deps.getCustomerRecord || getCustomerRecord)({ customerId: customerId });
  if (customer.status !== STATUSES.OK) {
    return { ok: false, reason: REASONS.NOT_FOUND, problems: ["No customer with that id has booked."] };
  }

  const previous = store.get(customerId) || null;
  const next = {
    email: change.email !== undefined ? change.email.trim().toLowerCase() : previous ? previous.email : null,
    optedOut: change.optedOut !== undefined ? change.optedOut : previous ? previous.optedOut : false,
  };
  if (previous && previous.email === next.email && previous.optedOut === next.optedOut) {
    return { ok: true, changed: false, contact: previous };
  }

  const version = previous ? previous.version + 1 : 1;
  const record = Object.freeze({
    customerId: customerId,
    email: next.email,
    optedOut: next.optedOut,
    version: version,
    updatedAt: new Date().toISOString(),
    updatedBy: actor || null,
  });
  const result = guard.commit(store, deps.audit || recordAudit, {
    id: customerId,
    version: version,
    record: record,
    previous: previous,
    event: "marketing.contact.updated",
    actor: actor,
    correlationId: correlationId,
    // The address itself is NOT put in the audit trail - the trail says that
    // it changed, and who changed it. Contact data stays in one store.
    context: {
      customerId: customerId,
      emailChanged: !previous || previous.email !== next.email,
      optedOut: next.optedOut,
      version: version,
    },
  });
  if (!result.ok) return result;
  return { ok: true, changed: true, contact: record };
}

function getPreferences(customerId, deps = {}) {
  const store = deps.store || CONTACTS;
  return (typeof customerId === "string" && store.get(customerId)) || null;
}

module.exports = { setPreferences, getPreferences, REASONS };
