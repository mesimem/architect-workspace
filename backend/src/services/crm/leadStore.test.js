// STORY-014: the lead book's decisions, tested without HTTP.
//
// This suite proves the RULES: what a valid lead is, when two captures are the
// same person, and that nothing changes the book without leaving an audit
// entry. crmRoutes.test.js proves the WIRING - that the route asks for the
// right permission and that a caller without it cannot reach any of this.
//
// The story's three named failure paths are marked below. "Unauthorized data
// access" is not testable here on purpose: this module has no notion of a
// caller's role, because the permission gate in http/server.js is the single
// place that decides access. It is tested over real HTTP instead.

const assert = require("assert");

const {
  createLead,
  updateLead,
  getLead,
  listLeads,
  validateLead,
  LEAD_SOURCES,
  __resetLeadsForTests,
} = require("./leadStore");
const { findAuditEntry, deriveAuditKey } = require("../audit/auditLog");

// Each mutation needs its own correlationId, because audit entries are
// first-write-wins and reusing one across two assertions would have the second
// entry dedup away - which is the very bug this suite is here to catch.
let nextCorrelation = 0;
function correlation(label) {
  nextCorrelation += 1;
  return "test-crm-" + label + "-" + nextCorrelation;
}

function main() {
  __resetLeadsForTests();

  // ---------------------------------------------------------------------
  // ACCEPTANCE CRITERION 1: a new lead is visible in the lead list.
  // ---------------------------------------------------------------------
  const captureId = correlation("capture");
  const created = createLead({
    fullName: "Ada Mensah",
    email: "ada@example.com",
    source: "web",
    notes: "Asked about a 10-day Tanzania safari in June.",
    actor: "sales-1",
    correlationId: captureId,
  });

  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.replayed, false);
  assert.ok(created.lead.leadId.startsWith("lead_"));
  assert.strictEqual(created.lead.status, "new");
  assert.strictEqual(created.lead.createdBy, "sales-1");

  const listed = listLeads();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].leadId, created.lead.leadId);
  assert.strictEqual(listed[0].email, "ada@example.com");
  console.log("leadStore: a captured lead is visible in the lead list");

  // ---------------------------------------------------------------------
  // ACCEPTANCE CRITERION 3 (trust): the capture is audited.
  // ---------------------------------------------------------------------
  const createEntry = findAuditEntry(deriveAuditKey(created.lead.leadId, "crm.lead.created"));
  assert.ok(createEntry, "capturing a lead must write an audit entry");
  assert.strictEqual(createEntry.event, "crm.lead.created");
  assert.strictEqual(createEntry.outcome, "success");
  assert.strictEqual(createEntry.resource, created.lead.leadId);
  assert.strictEqual(createEntry.actor, "sales-1");
  assert.strictEqual(createEntry.correlationId, captureId);
  console.log("leadStore: capturing a lead writes an audit entry naming the actor and the lead");

  // The email is normalised on the way in, so the duplicate check and the
  // reports downstream see one spelling of one person.
  const messy = createLead({
    fullName: "  Kwame Osei  ",
    email: "  KWAME@Example.COM ",
    source: "Referral",
    actor: "sales-1",
    correlationId: correlation("normalise"),
  });
  assert.strictEqual(messy.ok, true);
  assert.strictEqual(messy.lead.email, "kwame@example.com");
  assert.strictEqual(messy.lead.source, "referral");
  assert.strictEqual(messy.lead.fullName, "Kwame Osei");
  assert.strictEqual(messy.lead.notes, null);
  console.log("leadStore: email, source and name are normalised on capture");

  // ---------------------------------------------------------------------
  // FAILURE PATH: lead duplication.
  // ---------------------------------------------------------------------
  const before = listLeads().length;
  const repeat = createLead({
    fullName: "Ada Mensah (web form, again)",
    email: "ADA@example.com ", // same person, different spelling
    source: "web",
    actor: "sales-2",
    correlationId: correlation("repeat"),
  });
  assert.strictEqual(repeat.ok, true);
  assert.strictEqual(repeat.replayed, true, "a repeat capture must report itself as a replay");
  assert.strictEqual(repeat.lead.leadId, created.lead.leadId, "it must return the ORIGINAL lead");
  assert.strictEqual(listLeads().length, before, "a repeat capture must not add a row");
  // And the original is untouched: the replay did not overwrite the name or
  // re-attribute the lead to whoever happened to submit the duplicate.
  assert.strictEqual(getLead(created.lead.leadId).fullName, "Ada Mensah");
  assert.strictEqual(getLead(created.lead.leadId).createdBy, "sales-1");
  console.log("leadStore: the same person from the same source captures once, and the first row wins");

  // Same email, DIFFERENT source, is a different commercial event and must be
  // its own row - a partner referral is not the web form.
  const otherSource = createLead({
    fullName: "Ada Mensah",
    email: "ada@example.com",
    source: "partner",
    actor: "sales-1",
    correlationId: correlation("othersource"),
  });
  assert.strictEqual(otherSource.ok, true);
  assert.strictEqual(otherSource.replayed, false);
  assert.notStrictEqual(otherSource.lead.leadId, created.lead.leadId);
  console.log("leadStore: the same email from a different source is a separate lead");

  // ---------------------------------------------------------------------
  // FAILURE PATH: data entry error.
  // ---------------------------------------------------------------------
  const rowsBeforeBadInput = listLeads().length;
  const badId = correlation("invalid");
  const bad = createLead({
    fullName: "   ",
    email: "not-an-email",
    source: "carrier-pigeon",
    actor: "sales-1",
    correlationId: badId,
  });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, "invalid_lead");
  // All three problems at once, not just the first - a form should not need
  // three round trips to be filled in.
  assert.strictEqual(bad.problems.length, 3);
  assert.ok(bad.problems.some((p) => p.includes("fullName")));
  assert.ok(bad.problems.some((p) => p.includes("email")));
  assert.ok(bad.problems.some((p) => p.includes("source")));
  assert.strictEqual(listLeads().length, rowsBeforeBadInput, "a refused lead must not be written");

  // A refusal is audited too.
  const refusedEntry = findAuditEntry(deriveAuditKey(badId, "crm.lead.refused"));
  assert.ok(refusedEntry, "a refused capture must leave an audit entry");
  assert.strictEqual(refusedEntry.outcome, "failure");
  assert.strictEqual(refusedEntry.context.reason, "invalid_lead");
  console.log("leadStore: a malformed lead is refused with every problem listed, and the refusal is audited");

  // The rejected value itself is never echoed into the audit entry or the
  // problem list, because it came from outside and both end up in logs.
  assert.ok(
    !JSON.stringify(refusedEntry).includes("carrier-pigeon"),
    "the audit entry must not echo untrusted input back"
  );
  console.log("leadStore: untrusted input is not echoed into the audit trail");

  // Boundary cases on the validator, checked directly.
  assert.deepStrictEqual(validateLead({ fullName: "A", email: "a@b.co", source: "web" }), []);
  assert.ok(
    validateLead({ fullName: "x".repeat(121), email: "a@b.co", source: "web" }).length === 1,
    "121 characters of name is one problem"
  );
  assert.deepStrictEqual(
    validateLead({ fullName: "x".repeat(120), email: "a@b.co", source: "web" }),
    [],
    "120 characters of name is the limit, not over it"
  );
  assert.ok(validateLead({ fullName: "A", email: "a@b.co", source: "web", notes: 42 }).length === 1);
  assert.ok(
    validateLead({ fullName: "A", email: "a@b.co", source: "web", status: "hot" }).length === 1,
    "an unknown status is refused"
  );
  LEAD_SOURCES.forEach(function (source) {
    assert.deepStrictEqual(
      validateLead({ fullName: "A", email: "a@b.co", source: source }),
      [],
      source + " must be an accepted source"
    );
  });
  console.log("leadStore: the validator holds at its boundaries and accepts every declared source");

  // ---------------------------------------------------------------------
  // ACCEPTANCE CRITERION 3 (trust), the harder half: an EDIT is audited, and
  // a SECOND edit is audited too.
  //
  // This is the regression test for the trap auditLog.js documents: entries
  // are first-write-wins, so a module that keyed edits on the leadId would
  // record the first edit to a lead and silently lose every later one. Both
  // entries below must exist and must differ.
  // ---------------------------------------------------------------------
  const firstEditId = correlation("edit");
  const firstEdit = updateLead({
    leadId: created.lead.leadId,
    changes: { status: "contacted" },
    actor: "sales-2",
    correlationId: firstEditId,
  });
  assert.strictEqual(firstEdit.ok, true);
  assert.deepStrictEqual(firstEdit.changed, ["status"]);
  assert.strictEqual(firstEdit.lead.status, "contacted");
  assert.strictEqual(getLead(created.lead.leadId).status, "contacted");

  const firstEntry = findAuditEntry(deriveAuditKey(firstEditId, "crm.lead.updated"));
  assert.ok(firstEntry, "the first edit must be audited");
  assert.deepStrictEqual(firstEntry.context.fields, ["status"]);
  assert.deepStrictEqual(firstEntry.context.before, { status: "new" });
  assert.deepStrictEqual(firstEntry.context.after, { status: "contacted" });
  assert.strictEqual(firstEntry.actor, "sales-2");

  const secondEditId = correlation("edit");
  const secondEdit = updateLead({
    leadId: created.lead.leadId,
    changes: { status: "qualified", notes: "Budget confirmed." },
    actor: "sales-3",
    correlationId: secondEditId,
  });
  assert.strictEqual(secondEdit.ok, true);
  assert.deepStrictEqual(secondEdit.changed.slice().sort(), ["notes", "status"]);

  const secondEntry = findAuditEntry(deriveAuditKey(secondEditId, "crm.lead.updated"));
  assert.ok(secondEntry, "the SECOND edit must be audited too, not deduped away");
  assert.notStrictEqual(secondEntry.auditKey, firstEntry.auditKey);
  assert.deepStrictEqual(secondEntry.context.before.status, "contacted");
  assert.deepStrictEqual(secondEntry.context.after.status, "qualified");
  // The trail is now readable end to end: new -> contacted -> qualified.
  console.log("leadStore: every edit is audited with its before and after, including the second one");

  // createdAt and createdBy survive an edit; updatedAt moves.
  assert.strictEqual(secondEdit.lead.createdAt, created.lead.createdAt);
  assert.strictEqual(secondEdit.lead.createdBy, "sales-1");
  assert.ok(secondEdit.lead.updatedAt >= created.lead.updatedAt);
  console.log("leadStore: an edit cannot rewrite who captured the lead or when");

  // A save that changes nothing is recorded as such rather than vanishing.
  const noopId = correlation("noop");
  const noop = updateLead({
    leadId: created.lead.leadId,
    changes: { email: " ADA@example.com " }, // same value, different spelling
    actor: "sales-2",
    correlationId: noopId,
  });
  assert.strictEqual(noop.ok, true);
  assert.strictEqual(noop.unchanged, true);
  assert.deepStrictEqual(noop.changed, []);
  assert.ok(findAuditEntry(deriveAuditKey(noopId, "crm.lead.unchanged")));
  assert.strictEqual(
    findAuditEntry(deriveAuditKey(noopId, "crm.lead.updated")),
    null,
    "a no-op must not claim fields changed"
  );
  console.log("leadStore: a save that changes nothing is audited as unchanged, not as an edit");

  // ---------------------------------------------------------------------
  // FAILURE PATHS on edit.
  // ---------------------------------------------------------------------
  const missingId = correlation("missing");
  const missing = updateLead({
    leadId: "lead_does-not-exist",
    changes: { status: "lost" },
    actor: "sales-1",
    correlationId: missingId,
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, "unknown_lead");
  assert.ok(findAuditEntry(deriveAuditKey(missingId, "crm.lead.refused")));

  // Fields outside the allow-list are refused outright rather than ignored.
  // Silently dropping them is worse: the caller is told the save succeeded.
  const tamper = updateLead({
    leadId: created.lead.leadId,
    changes: { createdBy: "sales-9", status: "lost" },
    actor: "sales-9",
    correlationId: correlation("tamper"),
  });
  assert.strictEqual(tamper.ok, false);
  assert.strictEqual(tamper.reason, "unknown_fields");
  assert.strictEqual(getLead(created.lead.leadId).createdBy, "sales-1");
  assert.strictEqual(getLead(created.lead.leadId).status, "qualified", "the legal half must not apply either");

  // Prototype-chain keys are just unknown fields, not a way in.
  const poison = updateLead({
    leadId: created.lead.leadId,
    changes: { constructor: "x" },
    actor: "sales-1",
    correlationId: correlation("poison"),
  });
  assert.strictEqual(poison.ok, false);
  assert.strictEqual(poison.reason, "unknown_fields");

  const empty = updateLead({
    leadId: created.lead.leadId,
    changes: {},
    actor: "sales-1",
    correlationId: correlation("empty"),
  });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, "empty_update");
  console.log("leadStore: an edit is refused unless it names at least one editable field");

  // An edit that would move a lead onto another lead's (email + source) is the
  // duplicate createLead prevents, arriving through the other door.
  const clash = updateLead({
    leadId: otherSource.lead.leadId,
    changes: { source: "web" }, // would collide with the original ada/web lead
    actor: "sales-1",
    correlationId: correlation("clash"),
  });
  assert.strictEqual(clash.ok, false);
  assert.strictEqual(clash.reason, "duplicate_lead");
  assert.strictEqual(getLead(otherSource.lead.leadId).source, "partner");
  console.log("leadStore: an edit cannot create the duplicate that capture refuses");

  // No correlationId means no auditable trail, so the change is refused
  // rather than performed unaudited.
  const unauditable = updateLead({
    leadId: created.lead.leadId,
    changes: { status: "lost" },
    actor: "sales-1",
    correlationId: "",
  });
  assert.strictEqual(unauditable.ok, false);
  assert.strictEqual(unauditable.reason, "missing_correlation_id");
  assert.strictEqual(getLead(created.lead.leadId).status, "qualified");
  assert.strictEqual(
    createLead({ fullName: "A", email: "a@b.co", source: "web" }).reason,
    "missing_correlation_id"
  );
  console.log("leadStore: a change that cannot be audited is refused rather than made silently");

  // A caller cannot edit the book through a record it was handed.
  const handed = listLeads()[0];
  assert.throws(function () {
    "use strict";
    handed.status = "converted";
  }, TypeError);
  console.log("leadStore: records are frozen, so the only way to change one is updateLead");

  // Newest first.
  const order = listLeads();
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1].createdAt >= order[i].createdAt, "the lead list must be newest first");
  }
  console.log("leadStore: the lead list reads newest first");

  __resetLeadsForTests();
  assert.deepStrictEqual(listLeads(), []);

  console.log("leadStore: all tests passed");
}

main();
