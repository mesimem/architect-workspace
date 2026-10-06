// STORY-019: the segments a sales manager has defined, and who is in each.
//
// A segment row stores the NAME and the RULE (segmentRules.js), never the
// members. Members are computed from the CRM on every read, so the answer to
// "who is in this segment" is always today's answer.
//
// ONE SEGMENT PER NAME. The id is derived from the name, so defining the same
// segment twice is a replay that returns the first one, and reusing a name for
// a different rule is a conflict rather than a silent redefinition - a
// campaign already sent to "Repeat safari travellers" must keep meaning the
// rule it was sent under. Segments are not edited in place for the same
// reason; define a new one.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every outcome is { ok, reason, problems };
//     nothing throws. A segment that cannot be audited is rolled back
//     (shared/auditedCommit.js) and reported as audit_unavailable.
//  2. Will it retry? No - local store only. A client retry is safe because
//     defining the same name and rule again is a replay.
//  3. Recovery path? A refused definition leaves nothing behind to clean up.
//  4. Handled: malformed input, unknown criteria, name reused with a different
//     rule, store write lost, audit failure. NOT handled: deleting or editing a
//     segment (deliberately absent), pagination of members.

const crypto = require("crypto");
const { createJsonFileStore } = require("../shared/jsonFileStore");
const { createAuditedCommit } = require("../shared/auditedCommit");
const { recordAudit } = require("../audit/auditLog");
const { listCustomers } = require("../crm/customerRecord");
const { validateSegment, normaliseCriteria, matchCustomers } = require("./segmentRules");

const SEGMENTS = createJsonFileStore("marketing-segments");
const guard = createAuditedCommit({ subject: "segment", service: "marketing" });

const REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  CONFLICT: "conflict",
  NOT_FOUND: "not_found",
  NOT_SAVED: guard.REASONS.NOT_SAVED,
  AUDIT_UNAVAILABLE: guard.REASONS.AUDIT_UNAVAILABLE,
});

function segmentIdFor(name) {
  const digest = crypto.createHash("sha256").update(name.trim().toLowerCase()).digest("hex");
  return "SEG-" + digest.slice(0, 16);
}

// What a sales manager sees of a member: the relationship figures the rule
// was written against, and nothing else.
function memberView(customer) {
  return Object.freeze({
    customerId: customer.customerId,
    bookingCount: customer.bookingCount,
    lifetimeValueCents: customer.lifetimeValueCents,
    lastBookedAt: customer.lastBookedAt,
  });
}

function membersOf(segment, deps) {
  const customers = (deps && deps.listCustomers ? deps.listCustomers : listCustomers)();
  return matchCustomers(customers, segment.criteria).map(memberView);
}

function defineSegment({ input, actor, correlationId }, deps = {}) {
  const store = deps.store || SEGMENTS;
  const problems = validateSegment(input);
  if (problems.length > 0) {
    return { ok: false, reason: REASONS.INVALID_REQUEST, problems: problems };
  }
  const name = input.name.trim();
  const criteria = normaliseCriteria(input.criteria || {});
  const segmentId = segmentIdFor(name);

  const existing = store.get(segmentId);
  if (existing) {
    if (JSON.stringify(existing.criteria) === JSON.stringify(criteria)) {
      return { ok: true, replayed: true, segment: existing, members: membersOf(existing, deps) };
    }
    return {
      ok: false,
      reason: REASONS.CONFLICT,
      problems: ['A segment named "' + existing.name + '" already exists with a different rule. Use a new name.'],
    };
  }

  const record = Object.freeze({
    segmentId: segmentId,
    name: name,
    criteria: criteria,
    version: 1,
    createdAt: new Date().toISOString(),
    createdBy: actor || null,
  });
  const result = guard.commit(store, deps.audit || recordAudit, {
    id: segmentId,
    version: 1,
    record: record,
    previous: null,
    event: "marketing.segment.defined",
    actor: actor,
    correlationId: correlationId,
    context: { name: name, criteria: criteria },
  });
  if (!result.ok) return result;
  return { ok: true, replayed: false, segment: record, members: membersOf(record, deps) };
}

function getSegment(segmentId, deps = {}) {
  const store = deps.store || SEGMENTS;
  const segment = typeof segmentId === "string" ? store.get(segmentId) : null;
  if (!segment) {
    return { ok: false, reason: REASONS.NOT_FOUND, problems: ["No segment with that id."] };
  }
  return { ok: true, segment: segment, members: membersOf(segment, deps) };
}

function listSegments(deps = {}) {
  const store = deps.store || SEGMENTS;
  return Array.from(store.values()).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
}

module.exports = { defineSegment, getSegment, listSegments, segmentIdFor, REASONS };
