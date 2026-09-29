// STORY-014: the lead book. Leads come in from the website, from referrals and
// from the phone; a sales manager reads them back and works them.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It owns lead
// records and nothing else. It does not own customers, and it does not own
// booking history - a customer's bookings already live in
// booking/crmTransactionLog.js, written by bookTripService on every confirmed
// booking, and crm/customerRecord.js reads them from there. Copying bookings
// into a CRM table would create a second answer to "what has this customer
// bought?", and the second answer is always the one that goes stale.
//
// THE THREE FAILURE PATHS THE STORY NAMES, AND WHERE EACH IS HANDLED.
//   Data entry error     -> validateLead(), below. Refused with a list of
//                           problems, never half-written.
//   Lead duplication     -> dedup on normalised (email + source), the key
//                           CLAUDE.md mandates for lead capture. A repeat
//                           create returns the record that already exists.
//   Unauthorized access  -> NOT here. It is enforced once, centrally, by the
//                           permission gate in http/server.js against the
//                           crm.leads.* permissions the route declares. A
//                           second check in this module would be a second
//                           policy, and two policies can disagree.
//
// WHY EVERY MUTATION NEEDS A correlationId. An audit entry is keyed, and keys
// are first-write-wins (see auditLog.js). A module that audited every update
// under "<leadId>:updated" would record the FIRST edit to a lead and silently
// discard every later one - the exact trap auditLog.js documents. The honest
// key for "an edit happened" is the request that made it, so updates key on the
// caller's correlationId. That has a consequence worth stating plainly: a
// mutation that arrives with no correlationId is REFUSED rather than performed
// unaudited. The project guardrail is that all changes are audited, so "I
// cannot audit this" has to mean "I will not do this".
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A refusal returns { ok: false, reason } and
//     writes an audit entry recording the refusal. Nothing is partially
//     written: validation runs to completion before the store is touched, and
//     the store write is a single synchronous set of one frozen record.
//  2. Will it retry? There is nothing to retry - no network, no clock skew,
//     one synchronous local write. Callers may safely re-send: create dedups
//     on (email + source), update dedups on correlationId.
//  3. Recovery path if it fails anyway? The caller gets the reason and the
//     problem list and can correct and re-send. A disk-level failure surfaces
//     as a thrown error from jsonFileStore rather than a silent success.
//  4. Handled: blank and over-long fields, malformed email, unknown source and
//     status, prototype-chain keys in `changes`, duplicate capture, missing
//     correlationId, callers mutating a record they were handed. NOT handled:
//     lead assignment to a named owner, merge of two leads discovered to be
//     the same person, and any index over the book - listLeads scans, which is
//     correct and O(n). STORY-016 is the scalability story; an index is a
//     second copy of the data that can desync, so it waits until there is a
//     measured reason for it.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise, same as every
// other store here. A lead book that forgets on restart loses the pipeline.
const LEADS = createJsonFileStore("crm-leads");

// Where a lead came from. A closed set, because "source" is what sales reports
// on - a free-text source field becomes "web", "Web", "website" and "web form"
// within a month, and then the report is wrong rather than merely ugly.
const LEAD_SOURCES = Object.freeze(["web", "referral", "phone", "partner", "event"]);

// The pipeline. `new` on capture; the rest are set by a later edit.
const LEAD_STATUSES = Object.freeze(["new", "contacted", "qualified", "converted", "lost"]);

// Only these may be changed after capture. Notably absent: leadId, createdAt,
// createdBy. An "update" that can rewrite who captured a lead and when is not
// an update, it is a way to erase the trail.
const MUTABLE_FIELDS = Object.freeze(["fullName", "email", "source", "status", "notes"]);

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 ceiling.
const MAX_NOTES_LENGTH = 2000;

// Deliberately loose and linear: one @, something either side, a dot in the
// domain. It rejects the typos that matter (missing @, trailing comma, a name
// pasted into the email box) and does not try to decide whether a exotic
// address is legal - only delivery can answer that. Linear so that a pasted
// 10KB string cannot make it backtrack.
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Lower-cased and trimmed, because "Ada@Example.com " and "ada@example.com"
// are one person, and the duplicate check is only as good as this function.
function normaliseEmail(email) {
  return isNonBlankString(email) ? email.trim().toLowerCase() : "";
}

function normaliseSource(source) {
  return isNonBlankString(source) ? source.trim().toLowerCase() : "";
}

// The duplicate identity: same person, same way in. Same email from a
// different source is intentionally NOT a duplicate - a referral from a
// partner is a different commercial event from the same person filling in the
// web form, and sales needs both rows.
function dedupKeyFor(email, source) {
  return normaliseEmail(email) + "|" + normaliseSource(source);
}

// Returns a list of problems, empty when the lead is well-formed. A list
// rather than the first problem found, so a caller fixing a form gets all of
// it at once instead of one round trip per field.
function validateLead(candidate) {
  const problems = [];
  const lead = candidate && typeof candidate === "object" ? candidate : {};

  if (!isNonBlankString(lead.fullName)) {
    problems.push("fullName is required and must not be blank.");
  } else if (lead.fullName.trim().length > MAX_NAME_LENGTH) {
    problems.push("fullName must be at most " + MAX_NAME_LENGTH + " characters.");
  }

  if (!isNonBlankString(lead.email)) {
    problems.push("email is required and must not be blank.");
  } else if (lead.email.trim().length > MAX_EMAIL_LENGTH) {
    problems.push("email must be at most " + MAX_EMAIL_LENGTH + " characters.");
  } else if (!EMAIL_PATTERN.test(lead.email.trim())) {
    // The value is not echoed back: it came from outside and this string ends
    // up in a log line and an HTTP response.
    problems.push("email is not a valid address.");
  }

  if (!LEAD_SOURCES.includes(normaliseSource(lead.source))) {
    problems.push("source must be one of " + LEAD_SOURCES.join(", ") + ".");
  }

  // Status is absent on capture (it is forced to "new") and present on edit.
  if (lead.status !== undefined && !LEAD_STATUSES.includes(lead.status)) {
    problems.push("status must be one of " + LEAD_STATUSES.join(", ") + ".");
  }

  if (lead.notes !== undefined && lead.notes !== null) {
    if (typeof lead.notes !== "string") {
      problems.push("notes must be a string when present.");
    } else if (lead.notes.length > MAX_NOTES_LENGTH) {
      problems.push("notes must be at most " + MAX_NOTES_LENGTH + " characters.");
    }
  }

  return problems;
}

// Frozen one level down, like an audit entry. A caller that was handed a lead
// cannot edit the book through it - every change goes through updateLead, which
// is the only thing that writes an audit entry.
function freezeLead(lead) {
  return Object.freeze(lead);
}

function refuse(reason, problems, details) {
  // A refusal is audited too. "Someone tried to put a malformed lead in the
  // book" and "someone tried to edit a lead that does not exist" are both
  // things you want to find later; a refusal that leaves no trace is
  // indistinguishable from a request that was never made.
  const auditKey = deriveAuditKey(details.correlationId, "crm.lead.refused");
  if (auditKey !== "") {
    recordAudit({
      auditKey: auditKey,
      event: "crm.lead.refused",
      outcome: "failure",
      actor: details.actor,
      resource: details.resource || "crm.lead",
      correlationId: details.correlationId,
      context: { reason: reason, problems: problems },
    });
  }
  return { ok: false, reason: reason, problems: problems };
}

// Captures a new lead. Idempotent on (email + source): calling it twice with
// the same person returns the record from the first call, writes no second
// row and no second audit entry, and says so with replayed: true.
function createLead({ fullName, email, source, notes, actor, correlationId }) {
  if (!isNonBlankString(correlationId)) {
    // Refused before validation and before any write - see the header. Not
    // audited, because there is no id to audit it under; the HTTP layer always
    // supplies one, so reaching this means a programming error, not a bad
    // request.
    return { ok: false, reason: "missing_correlation_id", problems: ["correlationId is required."] };
  }

  const problems = validateLead({ fullName, email, source, notes });
  if (problems.length > 0) {
    return refuse("invalid_lead", problems, { actor, correlationId });
  }

  // Duplicate check BEFORE the id is generated, so a repeat capture does not
  // burn a new leadId and does not depend on the store's own key.
  const dedupKey = dedupKeyFor(email, source);
  const existing = findByDedupKey(dedupKey);
  if (existing) {
    return { ok: true, lead: existing, replayed: true };
  }

  const now = new Date().toISOString();
  const leadId = "lead_" + crypto.randomUUID();
  const lead = freezeLead({
    leadId: leadId,
    fullName: fullName.trim(),
    email: normaliseEmail(email),
    source: normaliseSource(source),
    status: "new",
    notes: isNonBlankString(notes) ? notes.trim() : null,
    createdAt: now,
    updatedAt: now,
    createdBy: isNonBlankString(actor) ? actor : null,
  });

  LEADS.set(leadId, lead);

  // Keyed on the leadId, which was generated a moment ago and so cannot
  // collide with an earlier entry. Updates cannot use this key - see header.
  recordAudit({
    auditKey: deriveAuditKey(leadId, "crm.lead.created"),
    event: "crm.lead.created",
    outcome: "success",
    actor: lead.createdBy,
    resource: leadId,
    correlationId: correlationId,
    context: { source: lead.source, status: lead.status },
  });

  return { ok: true, lead: lead, replayed: false };
}

// Edits an existing lead. Every accepted edit writes one audit entry naming
// the fields that changed and their before/after values, which is the story's
// trust criterion.
function updateLead({ leadId, changes, actor, correlationId }) {
  if (!isNonBlankString(correlationId)) {
    return { ok: false, reason: "missing_correlation_id", problems: ["correlationId is required."] };
  }

  const current = getLead(leadId);
  if (!current) {
    return refuse("unknown_lead", ["No lead with that id."], {
      actor,
      correlationId,
      resource: typeof leadId === "string" ? leadId : "crm.lead",
    });
  }

  const requested = changes && typeof changes === "object" ? changes : {};

  // hasOwnProperty, not `key in requested`: a body of { "constructor": ... }
  // arrives from a request more often than anyone expects, and MUTABLE_FIELDS
  // is the allow-list that stops anything else being written at all.
  const offered = MUTABLE_FIELDS.filter(function (field) {
    return Object.prototype.hasOwnProperty.call(requested, field);
  });
  const rejected = Object.keys(requested).filter(function (field) {
    return !MUTABLE_FIELDS.includes(field);
  });
  if (rejected.length > 0) {
    return refuse("unknown_fields", ["Not editable: " + rejected.join(", ") + "."], {
      actor,
      correlationId,
      resource: current.leadId,
    });
  }
  if (offered.length === 0) {
    return refuse("empty_update", ["changes must name at least one editable field."], {
      actor,
      correlationId,
      resource: current.leadId,
    });
  }

  // Validate the MERGED record, not the patch. A patch that is legal in
  // isolation can still leave the lead invalid, and the record is what has to
  // hold up.
  const merged = {};
  MUTABLE_FIELDS.forEach(function (field) {
    merged[field] = offered.includes(field) ? requested[field] : current[field];
  });
  const problems = validateLead(merged);
  if (problems.length > 0) {
    return refuse("invalid_lead", problems, {
      actor,
      correlationId,
      resource: current.leadId,
    });
  }

  const normalised = {
    fullName: merged.fullName.trim(),
    email: normaliseEmail(merged.email),
    source: normaliseSource(merged.source),
    status: merged.status,
    notes: isNonBlankString(merged.notes) ? merged.notes.trim() : null,
  };

  // An edit that changes the (email + source) pair onto another lead's would
  // create the duplicate that createLead exists to prevent. Same rule, applied
  // to the other door into the book.
  const newDedupKey = dedupKeyFor(normalised.email, normalised.source);
  if (newDedupKey !== dedupKeyFor(current.email, current.source)) {
    const clash = findByDedupKey(newDedupKey);
    if (clash && clash.leadId !== current.leadId) {
      return refuse("duplicate_lead", ["Another lead already holds that email and source."], {
        actor,
        correlationId,
        resource: current.leadId,
      });
    }
  }

  // Compare against the normalised values, so re-sending "Ada@Example.com "
  // for an email already stored as "ada@example.com" is correctly no change.
  const changed = MUTABLE_FIELDS.filter(function (field) {
    return normalised[field] !== current[field];
  });
  if (changed.length === 0) {
    // Audited as a success with no diff, rather than skipped. "Sales opened
    // this lead and saved it unchanged" is a real event, and recording it
    // stops a reader of the trail assuming the request never arrived.
    recordAudit({
      auditKey: deriveAuditKey(correlationId, "crm.lead.unchanged"),
      event: "crm.lead.unchanged",
      outcome: "success",
      actor: isNonBlankString(actor) ? actor : null,
      resource: current.leadId,
      correlationId: correlationId,
      context: { leadId: current.leadId },
    });
    return { ok: true, lead: current, changed: [], unchanged: true };
  }

  const before = {};
  const after = {};
  changed.forEach(function (field) {
    before[field] = current[field];
    after[field] = normalised[field];
  });

  const updated = freezeLead(
    Object.assign({}, current, normalised, { updatedAt: new Date().toISOString() })
  );

  LEADS.set(updated.leadId, updated);

  recordAudit({
    auditKey: deriveAuditKey(correlationId, "crm.lead.updated"),
    event: "crm.lead.updated",
    outcome: "success",
    actor: isNonBlankString(actor) ? actor : null,
    resource: updated.leadId,
    correlationId: correlationId,
    context: { fields: changed, before: before, after: after },
  });

  return { ok: true, lead: updated, changed: changed, unchanged: false };
}

// A linear scan. There are two of these (here and listLeads) and both are
// O(n) on purpose - see the header's note on STORY-016.
function findByDedupKey(dedupKey) {
  const leads = Array.from(LEADS.values());
  for (const lead of leads) {
    if (dedupKeyFor(lead.email, lead.source) === dedupKey) {
      return lead;
    }
  }
  return null;
}

function getLead(leadId) {
  if (!isNonBlankString(leadId)) {
    return null;
  }
  return LEADS.get(leadId) || null;
}

// Newest first, because the question a sales manager asks the lead list is
// "what came in?" far more often than "what is the oldest thing here?".
// Records are frozen, so there is nothing to copy defensively.
function listLeads() {
  return Array.from(LEADS.values()).sort(function (a, b) {
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

// Tests only. The store is process-wide, so a suite that did not reset it
// would pass or fail depending on the order its files happened to run in.
function __resetLeadsForTests() {
  Array.from(LEADS.keys()).forEach(function (key) {
    LEADS.delete(key);
  });
}

module.exports = {
  createLead,
  updateLead,
  getLead,
  listLeads,
  validateLead,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MUTABLE_FIELDS,
  __resetLeadsForTests,
};
