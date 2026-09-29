// STORY-007, acceptance criteria 2 and 3:
//   "Given a quote is modified, when it is saved, then the system updates the
//    customer view."
//   "Trust: The system logs all quote generations and modifications."
// plus the story's "quote not saved" failure path, which is exercised against
// a store that accepts writes and loses them - the silent version, because the
// loud version was never the dangerous one.

const assert = require("assert");

const {
  generateQuote,
  modifyQuote,
  getQuoteForCustomer,
  listQuotesForCustomer,
  getQuoteForStaff,
  __resetQuotesForTests,
  MUTABLE_FIELDS,
  REASONS,
  EVENTS,
} = require("./quoteStore");
const { customerQuoteView } = require("./quoteView");

// A Map-shaped store, like the real one but disposable per test.
function fakeStore() {
  const rows = new Map();
  return {
    get: rows.get.bind(rows),
    set: function (key, value) {
      rows.set(key, value);
      return this;
    },
    has: rows.has.bind(rows),
    delete: rows.delete.bind(rows),
    keys: rows.keys.bind(rows),
    values: rows.values.bind(rows),
    get size() {
      return rows.size;
    },
  };
}

// Accepts every write and keeps none - the silent save failure.
function droppingStore() {
  const store = fakeStore();
  return { ...store, set: function () { return this; }, get: function () { return undefined; } };
}

// Records what was audited so the trust criterion can be checked by content,
// not just by count.
function auditSpy() {
  const entries = [];
  const spy = function (entry) {
    entries.push(entry);
    return { entry: entry, replayed: false };
  };
  spy.entries = entries;
  return spy;
}

function failingAudit() {
  return function () {
    const error = new Error("audit store unavailable");
    error.errorClass = "UpstreamUnavailable";
    throw error;
  };
}

function sampleLines() {
  return [
    { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
    { label: "Airport transfer", unitCostCents: 14000, unitSellCents: 20000, quantity: 1 },
  ];
}

function newQuote(store, audit, overrides = {}) {
  return generateQuote(
    {
      customerId: "CUST-77",
      tripReference: "TRIP-9",
      title: "Tanzania, two travellers",
      lines: sampleLines(),
      currency: "USD",
      customerNote: "Prices hold for 14 days.",
      internalNotes: "Supplier may discount.",
      actor: "ADVISOR-3",
      correlationId: "corr-generate-0001",
      ...overrides,
    },
    { store: store, audit: audit }
  );
}

function main() {
  // ===== HAPPY PATH: GENERATE =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const result = newQuote(store, audit);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.replayed, false);
    assert.strictEqual(result.quote.version, 1);
    assert.strictEqual(result.quote.status, "issued");
    assert.strictEqual(result.quote.issuedBy, "ADVISOR-3");
    assert.strictEqual(result.quote.pricing.totalCents, 1020000);
    assert.ok(result.quote.quoteId.startsWith("quote_"));
    // It is really in the store, not just in the returned object.
    assert.strictEqual(store.get(result.quote.quoteId).version, 1);
    console.log("quoteStore: a generated quote is priced, versioned and persisted");

    // ===== CRITERION 3, first half: the generation is logged =====
    const generated = audit.entries.filter((e) => e.event === EVENTS.GENERATED);
    assert.strictEqual(generated.length, 1);
    assert.strictEqual(generated[0].outcome, "success");
    assert.strictEqual(generated[0].actor, "ADVISOR-3");
    assert.strictEqual(generated[0].resource, result.quote.quoteId);
    assert.strictEqual(generated[0].correlationId, "corr-generate-0001");
    assert.strictEqual(generated[0].context.totalCents, 1020000);
    // The note text is NOT in the audit context: free-form text may quote the
    // customer, and this trail is written to disk forever.
    assert.ok(!JSON.stringify(generated[0].context).includes("Supplier may discount"));
    console.log("quoteStore: generating a quote writes one audit entry naming who, what and how much");
  }

  // ===== IDEMPOTENCY: a retried generate does not issue a second quote =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const first = newQuote(store, audit);
    const retry = newQuote(store, audit);

    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.replayed, true);
    assert.strictEqual(retry.quote.quoteId, first.quote.quoteId);
    assert.strictEqual(store.size, 1, "a retry must not create a second quote");
    assert.strictEqual(audit.entries.filter((e) => e.event === EVENTS.GENERATED).length, 1);
    console.log("quoteStore: a retried generate returns the first quote and issues no second one");
  }

  // ===== CRITERION 2: a modification updates the customer view =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const created = newQuote(store, audit);
    const quoteId = created.quote.quoteId;

    const before = customerQuoteView(getQuoteForCustomer({ customerId: "CUST-77", quoteId }, { store }));
    assert.strictEqual(before.totalCents, 1020000);
    assert.strictEqual(before.version, 1);

    // The advisor drops the transfer and adds a 10% discount.
    const revised = modifyQuote(
      {
        quoteId: quoteId,
        changes: {
          lines: [sampleLines()[0]],
          discountBasisPoints: 1000,
          customerNote: "Transfer removed at your request.",
        },
        actor: "ADVISOR-4",
        correlationId: "corr-modify-0001",
      },
      { store: store, audit: audit }
    );

    assert.strictEqual(revised.ok, true);
    assert.strictEqual(revised.changed, true);
    assert.strictEqual(revised.quote.version, 2);

    // THE CRITERION ITSELF: read the customer view back out of the store and
    // check it reflects the save - not the object the write handed back, which
    // would prove nothing about what a customer would actually fetch.
    const after = customerQuoteView(getQuoteForCustomer({ customerId: "CUST-77", quoteId }, { store }));
    assert.strictEqual(after.version, 2);
    assert.strictEqual(after.lines.length, 1);
    assert.strictEqual(after.subtotalCents, 1000000);
    assert.strictEqual(after.discountCents, 100000);
    assert.strictEqual(after.totalCents, 900000);
    assert.strictEqual(after.customerNote, "Transfer removed at your request.");
    assert.notStrictEqual(after.totalCents, before.totalCents);
    // And it is still a clean customer document after the revision - the
    // criterion-1 guarantee must survive a modification, not just a create.
    assert.ok(!JSON.stringify(after).includes("420000"));
    assert.ok(!JSON.stringify(after).includes("Supplier may discount"));
    console.log("quoteStore: a saved modification is what the customer view returns, still without costs");

    // ===== CRITERION 3, second half: the modification is logged =====
    const modified = audit.entries.filter((e) => e.event === EVENTS.MODIFIED);
    assert.strictEqual(modified.length, 1);
    assert.strictEqual(modified[0].outcome, "success");
    assert.strictEqual(modified[0].actor, "ADVISOR-4");
    assert.strictEqual(modified[0].resource, quoteId);
    assert.strictEqual(modified[0].context.version, 2);
    assert.strictEqual(modified[0].context.totalCentsBefore, 1020000);
    assert.strictEqual(modified[0].context.totalCentsAfter, 900000);
    assert.deepStrictEqual(modified[0].context.fields.sort(), [
      "customerNote",
      "discountBasisPoints",
      "lines",
    ]);
    // Distinct audit keys: v1 and v2 are two events, and a first-write-wins
    // trail would otherwise keep only the first.
    assert.notStrictEqual(modified[0].auditKey, audit.entries[0].auditKey);
    console.log("quoteStore: modifying a quote logs the before, the after and who changed it");
  }

  // ===== A TEXT-ONLY EDIT REPRICES TO THE SAME FIGURES =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const created = newQuote(store, audit);
    const revised = modifyQuote(
      {
        quoteId: created.quote.quoteId,
        changes: { title: "Tanzania, revised" },
        actor: "ADVISOR-3",
        correlationId: "corr-title-0001",
      },
      { store: store, audit: audit }
    );
    assert.strictEqual(revised.ok, true);
    assert.strictEqual(revised.quote.version, 2);
    // Repricing from the reconstructed lines must land on exactly the old
    // figures. If this drifts, the reconstruction is lossy.
    assert.deepStrictEqual(revised.quote.pricing, created.quote.pricing);
    console.log("quoteStore: an edit that touches no price reprices to identical figures");
  }

  // ===== IDEMPOTENCY: a double-clicked save does not bump the version twice =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const created = newQuote(store, audit);
    const change = {
      quoteId: created.quote.quoteId,
      changes: { discountBasisPoints: 500 },
      actor: "ADVISOR-3",
      correlationId: "corr-double-click",
    };
    const first = modifyQuote(change, { store: store, audit: audit });
    const second = modifyQuote(change, { store: store, audit: audit });

    assert.strictEqual(first.quote.version, 2);
    assert.strictEqual(second.replayed, true);
    assert.strictEqual(second.quote.version, 2, "a replayed save must not bump the version again");
    assert.strictEqual(audit.entries.filter((e) => e.event === EVENTS.MODIFIED).length, 1);
    console.log("quoteStore: a double-clicked save revises once, not twice");
  }

  // ===== A NO-OP EDIT IS NOT A REVISION =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const created = newQuote(store, audit);
    const noop = modifyQuote(
      {
        quoteId: created.quote.quoteId,
        changes: { title: "Tanzania, two travellers" },
        actor: "ADVISOR-3",
        correlationId: "corr-noop-0001",
      },
      { store: store, audit: audit }
    );
    assert.strictEqual(noop.ok, true);
    assert.strictEqual(noop.changed, false);
    assert.strictEqual(noop.quote.version, 1, "an edit that changed nothing must not bump the version");
    // Still recorded - as an unchanged event, and not as a failure.
    const unchanged = audit.entries.filter((e) => e.event === EVENTS.UNCHANGED);
    assert.strictEqual(unchanged.length, 1);
    assert.strictEqual(unchanged[0].outcome, "success");
    console.log("quoteStore: a save that changes nothing is recorded as unchanged, not as a revision");
  }

  // ===== FAILURE PATH: QUOTE NOT SAVED (the silent kind) =====
  {
    const audit = auditSpy();
    const result = newQuote(droppingStore(), audit);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, REASONS.NOT_SAVED);
    // The advisor must NOT be told the quote exists, and no audit entry may
    // claim a generation that did not persist.
    assert.strictEqual(result.quote, undefined);
    assert.strictEqual(audit.entries.filter((e) => e.event === EVENTS.GENERATED).length, 0);
    console.log("quoteStore: a write that does not persist is reported as a failure, not confirmed");
  }

  // A modification that will not persist leaves the ORIGINAL readable. A
  // half-saved revision is the worst outcome here: the customer would be
  // looking at a document nobody agreed to.
  {
    const store = fakeStore();
    const audit = auditSpy();
    const created = newQuote(store, audit);
    const lossy = { ...store, set: function () { return this; } };
    const failed = modifyQuote(
      {
        quoteId: created.quote.quoteId,
        changes: { discountBasisPoints: 2000 },
        actor: "ADVISOR-3",
        correlationId: "corr-lost-save",
      },
      { store: lossy, audit: audit }
    );
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.reason, REASONS.NOT_SAVED);
    const stillThere = getQuoteForCustomer({ customerId: "CUST-77", quoteId: created.quote.quoteId }, { store });
    assert.strictEqual(stillThere.version, 1);
    assert.strictEqual(stillThere.pricing.totalCents, 1020000);
    console.log("quoteStore: a modification that fails to save leaves the original quote intact");
  }

  // ===== FAILURE PATH: AUDIT UNAVAILABLE ROLLS THE WRITE BACK =====
  // The guardrail is "maintain audit logs for all transactions and changes".
  // An unauditable quote must therefore not exist at all.
  {
    const store = fakeStore();
    const result = newQuote(store, failingAudit());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, REASONS.AUDIT_UNAVAILABLE);
    assert.strictEqual(store.size, 0, "an unauditable quote must not be left in the store");
    console.log("quoteStore: a quote that cannot be audited is rolled back, not silently kept");
  }

  {
    const store = fakeStore();
    const created = newQuote(store, auditSpy());
    const failed = modifyQuote(
      {
        quoteId: created.quote.quoteId,
        changes: { discountBasisPoints: 2000 },
        actor: "ADVISOR-3",
        correlationId: "corr-audit-down",
      },
      { store: store, audit: failingAudit() }
    );
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.reason, REASONS.AUDIT_UNAVAILABLE);
    // Rolled back to v1 exactly - not left at v2, and not deleted either.
    const current = store.get(created.quote.quoteId);
    assert.strictEqual(current.version, 1);
    assert.deepStrictEqual(current.pricing, created.quote.pricing);
    console.log("quoteStore: an unauditable revision is rolled back to the previous version");
  }

  // ===== FAILURE PATH: REFUSALS, all as data and never as a throw =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const created = newQuote(store, audit);
    const quoteId = created.quote.quoteId;

    // Bad pricing on generate.
    assert.strictEqual(
      newQuote(store, audit, {
        lines: [{ label: "Guide", unitCostCents: 90000, unitSellCents: 900, quantity: 1 }],
        correlationId: "corr-bad-price",
      }).reason,
      REASONS.INVALID_QUOTE
    );

    // Missing plumbing and missing ids.
    assert.strictEqual(newQuote(store, audit, { correlationId: "" }).reason, REASONS.MISSING_CORRELATION_ID);
    assert.strictEqual(
      newQuote(store, audit, { customerId: "", correlationId: "corr-no-customer" }).reason,
      REASONS.INVALID_REQUEST
    );
    assert.strictEqual(
      newQuote(store, audit, { actor: null, correlationId: "corr-no-actor" }).reason,
      REASONS.INVALID_REQUEST
    );

    // Unknown quote, and a quoteId that is not even a string.
    for (const badId of ["quote_nope", "", null, 42, "x".repeat(200)]) {
      const result = modifyQuote(
        { quoteId: badId, changes: { title: "x" }, actor: "A", correlationId: "corr-" + String(badId).slice(0, 8) },
        { store: store, audit: audit }
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, REASONS.UNKNOWN_QUOTE);
    }

    // Fields outside the allow-list, including a prototype-chain name.
    const rejected = modifyQuote(
      {
        quoteId: quoteId,
        changes: { customerId: "CUST-OTHER", version: 99, constructor: "x" },
        actor: "ADVISOR-3",
        correlationId: "corr-unknown-fields",
      },
      { store: store, audit: audit }
    );
    assert.strictEqual(rejected.reason, REASONS.UNKNOWN_FIELDS);
    assert.strictEqual(store.get(quoteId).customerId, "CUST-77", "the allow-list must hold");
    assert.strictEqual(store.get(quoteId).version, 1);

    // Nothing to change.
    for (const changes of [{}, null, "not an object", []]) {
      const empty = modifyQuote(
        { quoteId: quoteId, changes: changes, actor: "ADVISOR-3", correlationId: "corr-empty-" + typeof changes },
        { store: store, audit: audit }
      );
      assert.strictEqual(empty.reason, REASONS.EMPTY_UPDATE);
    }

    // A revision that would price badly leaves the stored quote untouched.
    const badRevision = modifyQuote(
      {
        quoteId: quoteId,
        changes: { lines: [{ label: "Guide", unitCostCents: -1, unitSellCents: 2, quantity: 1 }] },
        actor: "ADVISOR-3",
        correlationId: "corr-bad-revision",
      },
      { store: store, audit: audit }
    );
    assert.strictEqual(badRevision.reason, REASONS.INVALID_QUOTE);
    assert.strictEqual(store.get(quoteId).version, 1);
    assert.strictEqual(store.get(quoteId).pricing.totalCents, 1020000);

    // Every refusal above was logged.
    assert.ok(audit.entries.filter((e) => e.event === EVENTS.REFUSED).length >= 5);
    console.log("quoteStore: every refusal is returned as data, audited, and changes nothing");
  }

  // ===== OWNERSHIP: a stranger cannot read a quote =====
  {
    const store = fakeStore();
    const audit = auditSpy();
    const mine = newQuote(store, audit);
    newQuote(store, audit, { customerId: "CUST-99", correlationId: "corr-other-customer" });

    assert.ok(getQuoteForCustomer({ customerId: "CUST-77", quoteId: mine.quote.quoteId }, { store }));
    // Someone else's quote is indistinguishable from one that does not exist.
    assert.strictEqual(
      getQuoteForCustomer({ customerId: "CUST-99", quoteId: mine.quote.quoteId }, { store }),
      null
    );
    assert.strictEqual(getQuoteForCustomer({ customerId: "CUST-77", quoteId: "quote_nope" }, { store }), null);
    assert.strictEqual(getQuoteForCustomer({ customerId: "", quoteId: mine.quote.quoteId }, { store }), null);

    const mineOnly = listQuotesForCustomer({ customerId: "CUST-77" }, { store });
    assert.strictEqual(mineOnly.length, 1);
    assert.strictEqual(mineOnly[0].quoteId, mine.quote.quoteId);
    assert.strictEqual(listQuotesForCustomer({ customerId: "" }, { store }).length, 0);
    // Staff read is the one without a customer filter, and it is named for it.
    assert.ok(getQuoteForStaff({ quoteId: mine.quote.quoteId }, { store }));
    console.log("quoteStore: a quote is readable by its own customer and by staff, and by nobody else");
  }

  // ===== THE DEFAULT STORE WORKS TOO =====
  // Everything above injects a store. This proves the real module-level one is
  // wired up, so a passing suite cannot coexist with a broken default.
  {
    __resetQuotesForTests();
    const created = generateQuote({
      customerId: "CUST-DEFAULT",
      lines: sampleLines(),
      actor: "ADVISOR-1",
      correlationId: "corr-default-store",
    });
    assert.strictEqual(created.ok, true);
    const read = getQuoteForCustomer({ customerId: "CUST-DEFAULT", quoteId: created.quote.quoteId });
    assert.strictEqual(read.quoteId, created.quote.quoteId);
    assert.strictEqual(listQuotesForCustomer({ customerId: "CUST-DEFAULT" }).length, 1);
    __resetQuotesForTests();
    assert.strictEqual(listQuotesForCustomer({ customerId: "CUST-DEFAULT" }).length, 0);
    console.log("quoteStore: the real default store and audit log are wired up");
  }

  // The allow-list is part of the contract; a route builds its error message
  // from it, so an accidental widening should fail here first.
  assert.deepStrictEqual(MUTABLE_FIELDS.slice().sort(), [
    "customerNote",
    "discountBasisPoints",
    "internalNotes",
    "lines",
    "title",
    "tripReference",
  ]);

  console.log("quoteStore: all tests passed");
}

main();
