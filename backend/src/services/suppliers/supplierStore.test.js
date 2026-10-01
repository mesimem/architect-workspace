// STORY-010, the storage-and-audit half. The story's three acceptance criteria
// are marked below, and two of its three failure paths live here: "supplier not
// added" and "update failure". The third, "data mismatch", is proved in
// supplierContracts.test.js and re-proved here at the one point that matters
// for storage - that an update validates the MERGED record, so a patch which is
// legal on its own cannot leave the stored supplier self-contradictory.
//
// The rule these tests hold the module to: a refused change leaves the stored
// supplier EXACTLY as it was, and an accepted change is visible on the very next
// read. Both halves are asserted every time, because a store that refuses an
// edit and half-applies it is worse than one that accepts a bad edit - the
// advisor is told no and the book says otherwise.

const assert = require("assert");

const {
  createSupplier,
  updateSupplier,
  getSupplier,
  listSuppliers,
  __resetSuppliersForTests,
} = require("./supplierStore");
const { findAuditEntry, deriveAuditKey, getAuditEntries } = require("../audit/auditLog");

function sampleSupplier(overrides) {
  return Object.assign(
    {
      name: "Serengeti Serena Safari Lodge",
      country: "Tanzania",
      supplierType: "lodge",
      contactEmail: "reservations@serena.example",
      contactPhone: "+255 27 254 0000",
      contracts: [
        {
          contractRef: "TZ-SERENA-2026",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          currency: "USD",
          status: "active",
        },
      ],
      rates: [
        {
          contractRef: "TZ-SERENA-2026",
          description: "Standard double room, full board",
          currency: "USD",
          amountCents: 48000,
          unit: "per_person_per_night",
        },
      ],
      actor: "ADV-1",
      correlationId: "corr-supplier-create-0001",
    },
    overrides || {}
  );
}

// The audit entry a create writes, looked up by the key the module derives.
function createdEntry(supplierId) {
  return findAuditEntry(deriveAuditKey(supplierId, "suppliers.created"));
}

// The audit entry a given REQUEST wrote. Updates and refusals key on the
// correlationId, not the supplier id - see the store's header on why.
function entryFor(correlationId, event) {
  return findAuditEntry(deriveAuditKey(correlationId, event));
}

function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetSuppliersForTests();

  // ----- CRITERION 1: a saved supplier appears in the supplier list --------

  const created = createSupplier(sampleSupplier());
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.replayed, false);

  const supplier = created.supplier;
  assert.ok(supplier.supplierId.startsWith("supplier_"));
  assert.strictEqual(supplier.name, "Serengeti Serena Safari Lodge");
  assert.strictEqual(supplier.country, "Tanzania");
  assert.strictEqual(supplier.supplierType, "lodge");
  assert.strictEqual(supplier.version, 1);
  assert.strictEqual(supplier.createdBy, "ADV-1");

  // The contracts and rates - REQ-012's "including contracts and rates" - are
  // stored, not dropped. A supplier record without them would satisfy the
  // acceptance wording and miss the requirement.
  assert.strictEqual(supplier.contracts.length, 1);
  assert.strictEqual(supplier.contracts[0].contractRef, "TZ-SERENA-2026");
  assert.strictEqual(supplier.contracts[0].status, "active");
  assert.strictEqual(supplier.rates.length, 1);
  assert.strictEqual(supplier.rates[0].amountCents, 48000);

  // IT APPEARS IN THE LIST, and is readable by id. Both, because a book that
  // can be written and not read back is not a book.
  const listed = listSuppliers();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].supplierId, supplier.supplierId);
  assert.deepStrictEqual(getSupplier(supplier.supplierId), supplier);
  console.log("supplierStore: criterion 1 - a saved supplier appears in the list");

  // ----- CRITERION 3 (trust): the create is audited -----------------------

  const createAudit = createdEntry(supplier.supplierId);
  assert.ok(createAudit, "a created supplier must leave an audit entry");
  assert.strictEqual(createAudit.event, "suppliers.created");
  assert.strictEqual(createAudit.outcome, "success");
  assert.strictEqual(createAudit.actor, "ADV-1");
  assert.strictEqual(createAudit.resource, supplier.supplierId);
  assert.strictEqual(createAudit.correlationId, "corr-supplier-create-0001");
  // A DIGEST, not the contracts themselves - see the store's header on why
  // writing the entries would produce "<truncated>" where the evidence goes.
  assert.deepStrictEqual(createAudit.context.contracts, {
    count: 1,
    refs: ["TZ-SERENA-2026"],
  });
  assert.deepStrictEqual(createAudit.context.rates, { count: 1, refs: ["TZ-SERENA-2026"] });
  console.log("supplierStore: criterion 3 - a create is audited with a contract digest");

  // ----- IDEMPOTENCY: the same supplier twice is one row -------------------
  // CLAUDE.md is explicit that a script which works once and breaks on the
  // second run is broken, not fragile.

  const replay = createSupplier(
    sampleSupplier({ correlationId: "corr-supplier-create-0002" })
  );
  assert.strictEqual(replay.ok, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.supplier.supplierId, supplier.supplierId);
  assert.strictEqual(listSuppliers().length, 1, "a replay must not add a second row");
  // No second create entry, and the FIRST request's id is still the one on
  // record. An audit trail that moved to the retry's correlation id would point
  // at the wrong request.
  assert.strictEqual(createdEntry(supplier.supplierId).correlationId, "corr-supplier-create-0001");
  console.log("supplierStore: the same supplier submitted twice is one row, audited once");

  // Case and surrounding space do not make it a different business.
  const casedReplay = createSupplier(
    sampleSupplier({
      name: "  serengeti serena safari lodge  ",
      country: " tanzania ",
      correlationId: "corr-supplier-create-0003",
    })
  );
  assert.strictEqual(casedReplay.replayed, true);
  assert.strictEqual(listSuppliers().length, 1);
  console.log("supplierStore: the duplicate check ignores case and surrounding space");

  // A REPLAY DOES NOT APPLY THE RETRY'S CONTENT. If the contracts differ, that
  // is an edit, and accepting it here would re-contract a supplier under an
  // audit entry that says "created".
  const divergent = createSupplier(
    sampleSupplier({
      correlationId: "corr-supplier-create-0004",
      contracts: [
        {
          contractRef: "TZ-SERENA-2026",
          startDate: "2026-01-01",
          endDate: "2026-06-30",
          currency: "USD",
          status: "terminated",
        },
      ],
    })
  );
  assert.strictEqual(divergent.replayed, true);
  assert.strictEqual(
    getSupplier(supplier.supplierId).contracts[0].status,
    "active",
    "a replayed create silently applied the retry's content"
  );
  assert.strictEqual(getSupplier(supplier.supplierId).version, 1);
  console.log("supplierStore: a replayed create does not quietly apply new terms");

  // The same name in a DIFFERENT country is a different supplier - a chain with
  // a lodge in two countries is invoiced twice.
  const kenya = createSupplier(
    sampleSupplier({
      country: "Kenya",
      contracts: [
        {
          contractRef: "KE-SERENA-2026",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          currency: "USD",
          status: "active",
        },
      ],
      rates: [],
      correlationId: "corr-supplier-create-0005",
    })
  );
  assert.strictEqual(kenya.ok, true);
  assert.strictEqual(kenya.replayed, false);
  assert.strictEqual(listSuppliers().length, 2);
  console.log("supplierStore: the same name in another country is a separate supplier");

  // ----- FAILURE PATH: SUPPLIER NOT ADDED, AND VISIBLY SO -----------------
  // A refusal that leaves no trace is indistinguishable from a request never
  // sent, so each one is asserted to have BOTH refused and been audited.

  const before = listSuppliers().length;
  const orphanRate = createSupplier(
    sampleSupplier({
      name: "Orphan Rate Lodge",
      correlationId: "corr-supplier-refuse-0001",
      rates: [
        {
          contractRef: "TZ-NOT-SIGNED",
          description: "Room, full board",
          currency: "USD",
          amountCents: 48000,
          unit: "per_person_per_night",
        },
      ],
    })
  );
  assert.strictEqual(orphanRate.ok, false);
  assert.strictEqual(orphanRate.reason, "invalid_supplier");
  assert.ok(
    orphanRate.problems.some(function (problem) {
      return problem.includes("no contract on this supplier matches the reference TZ-NOT-SIGNED");
    }),
    "the refusal should name the orphan rate"
  );
  assert.strictEqual(listSuppliers().length, before, "a refused supplier was stored anyway");

  const refusalAudit = entryFor("corr-supplier-refuse-0001", "suppliers.refused");
  assert.ok(refusalAudit, "a refused create must leave an audit entry");
  assert.strictEqual(refusalAudit.outcome, "failure");
  assert.strictEqual(refusalAudit.context.reason, "invalid_supplier");
  console.log("supplierStore: a refused supplier is not stored, and the refusal is audited");

  // A MISSING correlationId is refused before anything else happens. It cannot
  // be audited - there is no id to audit it under - so the module refuses to
  // act rather than acting unaudited. The project guardrail is that all changes
  // are audited, which makes "I cannot audit this" mean "I will not do this".
  const unaudited = createSupplier(
    sampleSupplier({ name: "No Correlation Lodge", correlationId: "" })
  );
  assert.strictEqual(unaudited.ok, false);
  assert.strictEqual(unaudited.reason, "missing_correlation_id");
  assert.strictEqual(listSuppliers().length, before);
  console.log("supplierStore: a mutation that cannot be audited is refused, not performed");

  // ----- CRITERION 2: an updated supplier reflects the changes ------------

  const update = updateSupplier({
    supplierId: supplier.supplierId,
    changes: {
      contactPhone: "+255 27 254 9999",
      rates: [
        {
          contractRef: "TZ-SERENA-2026",
          description: "Standard double room, full board",
          currency: "USD",
          amountCents: 52000,
          unit: "per_person_per_night",
        },
      ],
    },
    actor: "ADV-2",
    correlationId: "corr-supplier-update-0001",
  });
  assert.strictEqual(update.ok, true);
  assert.strictEqual(update.unchanged, false);
  assert.deepStrictEqual(update.changed.slice().sort(), ["contactPhone", "rates"]);

  // THE SYSTEM REFLECTS THE UPDATE - asserted on a fresh read, not on the
  // returned object. A store that returns the new record and persists the old
  // one passes a weaker test than this.
  const reread = getSupplier(supplier.supplierId);
  assert.strictEqual(reread.contactPhone, "+255 27 254 9999");
  assert.strictEqual(reread.rates[0].amountCents, 52000);
  assert.strictEqual(reread.version, 2, "an accepted edit is a new revision");
  assert.strictEqual(reread.updatedBy, "ADV-2");
  // Untouched fields survive, and the authorship trail is not rewritten by an
  // edit from a different advisor.
  assert.strictEqual(reread.name, "Serengeti Serena Safari Lodge");
  assert.strictEqual(reread.contactEmail, "reservations@serena.example");
  assert.strictEqual(reread.createdBy, "ADV-1");
  assert.strictEqual(reread.createdAt, supplier.createdAt);
  console.log("supplierStore: criterion 2 - an update is reflected on the next read");

  // ----- CRITERION 3 (trust): the update is audited, naming what moved ----

  const updateAudit = entryFor("corr-supplier-update-0001", "suppliers.updated");
  assert.ok(updateAudit, "an updated supplier must leave an audit entry");
  assert.strictEqual(updateAudit.outcome, "success");
  assert.strictEqual(updateAudit.actor, "ADV-2");
  assert.strictEqual(updateAudit.resource, supplier.supplierId);
  assert.deepStrictEqual(updateAudit.context.fields.slice().sort(), ["contactPhone", "rates"]);
  assert.strictEqual(updateAudit.context.version, 2);
  // Before AND after. "The rates changed" is not an answer to "what changed?",
  // which is the question asked when a supplier disputes an invoice.
  assert.strictEqual(updateAudit.context.before.contactPhone, "+255 27 254 0000");
  assert.strictEqual(updateAudit.context.after.contactPhone, "+255 27 254 9999");
  assert.deepStrictEqual(updateAudit.context.ratesChanged, ["TZ-SERENA-2026"]);
  console.log("supplierStore: criterion 3 - an update is audited with before, after and refs");

  // EVERY EDIT IS AUDITED, NOT JUST THE FIRST. This is why updates key on the
  // correlationId: keyed on the supplier id, audit entries being
  // first-write-wins would record this edit and silently discard the next, so a
  // supplier re-contracted three times would show its original terms forever.
  const secondUpdate = updateSupplier({
    supplierId: supplier.supplierId,
    changes: { notes: "Renegotiating 2027 rates." },
    actor: "ADV-2",
    correlationId: "corr-supplier-update-0002",
  });
  assert.strictEqual(secondUpdate.ok, true);
  assert.strictEqual(getSupplier(supplier.supplierId).version, 3);
  assert.ok(
    entryFor("corr-supplier-update-0002", "suppliers.updated"),
    "the second edit to one supplier must also be audited"
  );
  console.log("supplierStore: a second edit to the same supplier is audited too");

  // A SAVE THAT CHANGED NOTHING is audited as such, and does not bump the
  // version. Recording it stops a reader of the trail assuming the request
  // never arrived.
  const noop = updateSupplier({
    supplierId: supplier.supplierId,
    changes: { name: "  Serengeti Serena Safari Lodge  " },
    actor: "ADV-2",
    correlationId: "corr-supplier-update-0003",
  });
  assert.strictEqual(noop.ok, true);
  assert.strictEqual(noop.unchanged, true);
  assert.deepStrictEqual(noop.changed, []);
  assert.strictEqual(getSupplier(supplier.supplierId).version, 3, "an empty save is not a revision");
  assert.ok(entryFor("corr-supplier-update-0003", "suppliers.unchanged"));
  console.log("supplierStore: a save that changed nothing is audited and is not a new revision");

  // Re-sending the same rate card in a DIFFERENT ORDER is also no change. This
  // is what the normalisers' sorting buys: without it every reordered form
  // submission would be audited as an edit nobody made.
  const reordered = updateSupplier({
    supplierId: supplier.supplierId,
    changes: {
      rates: [
        {
          contractRef: "tz-serena-2026",
          description: "Standard double room, full board",
          currency: "USD",
          amountCents: 52000,
          unit: "per_person_per_night",
        },
      ],
    },
    correlationId: "corr-supplier-update-0004",
  });
  assert.strictEqual(reordered.unchanged, true);
  console.log("supplierStore: the same rate card in another form is correctly no change");

  // ----- FAILURE PATH: UPDATE FAILURE -------------------------------------
  // Each refusal asserts the same two things: it was refused by name, and the
  // stored record is untouched.

  const versionBefore = getSupplier(supplier.supplierId).version;

  const unknown = updateSupplier({
    supplierId: "supplier_does-not-exist",
    changes: { notes: "x" },
    correlationId: "corr-supplier-update-0010",
  });
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.reason, "unknown_supplier");
  assert.ok(entryFor("corr-supplier-update-0010", "suppliers.refused"));
  console.log("supplierStore: editing a supplier that does not exist is refused and audited");

  // The allow-list is what stops an edit rewriting authorship. Refused BY NAME,
  // so an advisor learns the field is not editable instead of watching their
  // change vanish.
  const notEditable = updateSupplier({
    supplierId: supplier.supplierId,
    changes: { createdBy: "ADV-9", version: 99 },
    correlationId: "corr-supplier-update-0011",
  });
  assert.strictEqual(notEditable.ok, false);
  assert.strictEqual(notEditable.reason, "unknown_fields");
  assert.ok(notEditable.problems[0].includes("createdBy"));
  assert.ok(notEditable.problems[0].includes("version"));
  assert.strictEqual(getSupplier(supplier.supplierId).createdBy, "ADV-1");
  assert.strictEqual(getSupplier(supplier.supplierId).version, versionBefore);
  console.log("supplierStore: an edit to a non-editable field is refused by name");

  // A prototype-chain key is an unknown field, not a silent write.
  const prototypeKey = updateSupplier({
    supplierId: supplier.supplierId,
    changes: { constructor: "nope" },
    correlationId: "corr-supplier-update-0012",
  });
  assert.strictEqual(prototypeKey.ok, false);
  assert.strictEqual(prototypeKey.reason, "unknown_fields");
  console.log("supplierStore: a prototype-chain key in a patch is refused");

  // An empty patch is refused rather than treated as a no-op save. A caller
  // sending {} has a bug, and answering "saved, nothing changed" hides it.
  [{}, null, undefined, [], "name"].forEach(function (changes) {
    const empty = updateSupplier({
      supplierId: supplier.supplierId,
      changes: changes,
      correlationId: "corr-supplier-update-0013",
    });
    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.reason, "empty_update");
  });
  assert.strictEqual(getSupplier(supplier.supplierId).version, versionBefore);
  console.log("supplierStore: a patch naming no editable field is refused");

  // THE MERGED-RECORD CHECK. The single most important test in this file, and
  // the story's "data mismatch" path on the update side.
  //
  // Removing this contract is a perfectly legal patch IN ISOLATION - one
  // well-formed contract replacing another. What makes it illegal is the rate
  // ALREADY STORED against TZ-SERENA-2026, which the patch never mentions. A
  // store that validated the patch would accept this and leave a rate quoted
  // under an agreement the supplier does not hold.
  const orphaning = updateSupplier({
    supplierId: supplier.supplierId,
    changes: {
      contracts: [
        {
          contractRef: "TZ-SERENA-2027",
          startDate: "2027-01-01",
          endDate: "2027-12-31",
          currency: "USD",
          status: "draft",
        },
      ],
    },
    correlationId: "corr-supplier-update-0014",
  });
  assert.strictEqual(orphaning.ok, false);
  assert.strictEqual(orphaning.reason, "invalid_supplier");
  assert.ok(
    orphaning.problems.some(function (problem) {
      return problem.includes("no contract on this supplier matches the reference TZ-SERENA-2026");
    }),
    "replacing a contract must be checked against the rates already stored"
  );
  assert.strictEqual(
    getSupplier(supplier.supplierId).contracts[0].contractRef,
    "TZ-SERENA-2026",
    "a refused update was partially applied"
  );
  assert.strictEqual(getSupplier(supplier.supplierId).version, versionBefore);
  console.log("supplierStore: an update is validated against the merged record, not the patch");

  // Replacing BOTH together is the correct way to re-contract, and it works.
  // The refusal above must be a real constraint, not a wall that makes
  // legitimate work impossible.
  const recontract = updateSupplier({
    supplierId: supplier.supplierId,
    changes: {
      contracts: [
        {
          contractRef: "TZ-SERENA-2027",
          startDate: "2027-01-01",
          endDate: "2027-12-31",
          currency: "USD",
          status: "active",
        },
      ],
      rates: [
        {
          contractRef: "TZ-SERENA-2027",
          description: "Standard double room, full board",
          currency: "USD",
          amountCents: 55000,
          unit: "per_person_per_night",
        },
      ],
    },
    actor: "ADV-2",
    correlationId: "corr-supplier-update-0015",
  });
  assert.strictEqual(recontract.ok, true);
  assert.deepStrictEqual(recontract.changed.slice().sort(), ["contracts", "rates"]);
  assert.strictEqual(getSupplier(supplier.supplierId).contracts[0].contractRef, "TZ-SERENA-2027");

  // The audit entry names BOTH the old and new references, which is what makes
  // the trail answer "when did we move off the 2026 contract?".
  const recontractAudit = entryFor("corr-supplier-update-0015", "suppliers.updated");
  assert.deepStrictEqual(recontractAudit.context.contractsChanged, [
    "TZ-SERENA-2026",
    "TZ-SERENA-2027",
  ]);
  assert.deepStrictEqual(recontractAudit.context.before.contracts, {
    count: 1,
    refs: ["TZ-SERENA-2026"],
  });
  assert.deepStrictEqual(recontractAudit.context.after.contracts, {
    count: 1,
    refs: ["TZ-SERENA-2027"],
  });
  console.log("supplierStore: re-contracting both halves together is accepted and audited");

  // Clearing the only remaining contact is refused for the same reason: legal
  // as a patch, leaves a supplier nobody can reach.
  const emailOnly = updateSupplier({
    supplierId: supplier.supplierId,
    changes: { contactPhone: null },
    correlationId: "corr-supplier-update-0016",
  });
  assert.strictEqual(emailOnly.ok, true, "clearing one of two contacts is fine");
  const bothCleared = updateSupplier({
    supplierId: supplier.supplierId,
    changes: { contactEmail: null },
    correlationId: "corr-supplier-update-0017",
  });
  assert.strictEqual(bothCleared.ok, false);
  assert.ok(
    bothCleared.problems.some(function (problem) {
      return problem.includes("at least one of contactEmail or contactPhone is required");
    })
  );
  assert.strictEqual(
    getSupplier(supplier.supplierId).contactEmail,
    "reservations@serena.example",
    "a refused update cleared the contact anyway"
  );
  console.log("supplierStore: clearing the last way to contact a supplier is refused");

  // An edit that moves this supplier onto another's (name + country) would
  // create the duplicate createSupplier exists to prevent.
  const collide = updateSupplier({
    supplierId: kenya.supplier.supplierId,
    changes: { country: "Tanzania" },
    correlationId: "corr-supplier-update-0018",
  });
  assert.strictEqual(collide.ok, false);
  assert.strictEqual(collide.reason, "duplicate_supplier");
  assert.strictEqual(getSupplier(kenya.supplier.supplierId).country, "Kenya");
  console.log("supplierStore: an edit onto another supplier's identity is refused");

  // ----- THE BOOK IS READ BY NAME -----------------------------------------

  createSupplier(
    sampleSupplier({
      name: "Amboseli Transfers Ltd",
      country: "Kenya",
      supplierType: "transport",
      contactPhone: "+254 20 555 0000",
      contactEmail: undefined,
      contracts: [
        {
          contractRef: "KE-AMBO-2026",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          currency: "USD",
          status: "active",
        },
      ],
      rates: [],
      correlationId: "corr-supplier-create-0006",
    })
  );
  const names = listSuppliers().map(function (entry) {
    return entry.name;
  });
  assert.deepStrictEqual(names, [
    "Amboseli Transfers Ltd",
    "Serengeti Serena Safari Lodge",
    "Serengeti Serena Safari Lodge",
  ]);
  // Two same-named suppliers are ordered by country to break the tie, so the
  // list is stable rather than depending on insertion order.
  const sameName = listSuppliers().filter(function (entry) {
    return entry.name === "Serengeti Serena Safari Lodge";
  });
  assert.deepStrictEqual(
    sameName.map(function (entry) {
      return entry.country;
    }),
    ["Kenya", "Tanzania"]
  );
  console.log("supplierStore: the book lists by name, then country to break a tie");

  // A supplier contactable by phone alone is recordable - the create path must
  // agree with the validator about which fields are optional.
  const phoneOnlySupplier = listSuppliers()[0];
  assert.strictEqual(phoneOnlySupplier.contactEmail, null);
  assert.strictEqual(phoneOnlySupplier.contactPhone, "+254 20 555 0000");
  assert.strictEqual(phoneOnlySupplier.notes, null, "an absent note is stored as null");
  console.log("supplierStore: an absent optional field is stored as null, not missing");

  // ----- RECORDS HANDED OUT ARE NOT A WAY INTO THE BOOK -------------------
  // Every change must go through updateSupplier, because that is the only thing
  // that writes an audit entry. A mutable record handed to a caller is an
  // unaudited write channel.

  const handed = getSupplier(supplier.supplierId);
  assert.ok(Object.isFrozen(handed));
  assert.ok(Object.isFrozen(handed.contracts));
  assert.ok(Object.isFrozen(handed.contracts[0]));
  assert.ok(Object.isFrozen(handed.rates));
  assert.throws(function () {
    "use strict";
    handed.name = "Hijacked Lodge";
  });
  assert.strictEqual(getSupplier(supplier.supplierId).name, "Serengeti Serena Safari Lodge");
  console.log("supplierStore: a record handed to a caller cannot be edited through");

  // ----- NO CHANGE WENT UNAUDITED -----------------------------------------
  // The story's trust criterion is "the system logs ALL supplier data changes",
  // so this counts them: every supplier in the book has a created entry, and
  // every accepted edit has its own entry keyed on its own request.

  listSuppliers().forEach(function (entry) {
    assert.ok(
      createdEntry(entry.supplierId),
      "supplier " + entry.supplierId + " has no created audit entry"
    );
  });
  const supplierEvents = getAuditEntries().filter(function (entry) {
    return entry.event.startsWith("suppliers.");
  });
  assert.strictEqual(
    supplierEvents.filter(function (entry) {
      return entry.event === "suppliers.created";
    }).length,
    3,
    "one created entry per supplier, no more and no fewer"
  );
  assert.ok(
    supplierEvents.filter(function (entry) {
      return entry.event === "suppliers.refused";
    }).length >= 5,
    "every refusal should have left a trace"
  );
  console.log("supplierStore: criterion 3 - every supplier and every change is on the trail");

  console.log("supplierStore: all tests passed");
}

main();
