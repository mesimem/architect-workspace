// STORY-017, the write path. The story's second named failure path - "package
// creation fails due to system error" - lives here, and it is the one that
// cannot be provoked by typing something wrong: the store accepts the write and
// the audit log then refuses it. The test forces exactly that, and asserts the
// thing that matters, which is that NOTHING IS LEFT BEHIND.
//
// The first failure path (incompatible products) is proved exhaustively in
// packageCompatibility.test.js and checked here only at the seam - that the
// store calls the validator, audits the refusal, and writes nothing. The third
// (unauthorized access) is a property of the HTTP boundary and lives in
// http/packages.test.js.
//
// EVERY DEPENDENCY IS INJECTED - store, audit, product resolver and clock - so
// not one assertion below depends on the real product book being seeded, on
// disk, or on what another test file did first.

const assert = require("assert");

const {
  createPackage,
  updatePackage,
  getPackage,
  listPackages,
  MUTABLE_FIELDS,
  EVENTS,
  REASONS,
} = require("./packageStore");

// mara:     Kenya,    6 days, sells $4,450, costs $3,300
// amboseli: Kenya,    5 days, sells $2,950, costs $2,200
// serengeti:Tanzania, 5 days, sells $5,200, costs $4,200
const BOOK = Object.freeze({
  safari_mara: {
    productId: "safari_mara",
    country: "Kenya",
    durationDays: 6,
    pricing: {
      currency: "USD",
      perPersonCents: 445000,
      singleSupplementCents: 78000,
      internal: { costPerPersonCents: 330000, marginPerPersonCents: 115000 },
    },
  },
  safari_amboseli: {
    productId: "safari_amboseli",
    country: "Kenya",
    durationDays: 5,
    pricing: {
      currency: "USD",
      perPersonCents: 295000,
      singleSupplementCents: 46000,
      internal: { costPerPersonCents: 220000, marginPerPersonCents: 75000 },
    },
  },
  safari_serengeti: {
    productId: "safari_serengeti",
    country: "Tanzania",
    durationDays: 5,
    pricing: {
      currency: "USD",
      perPersonCents: 520000,
      singleSupplementCents: 90000,
      internal: { costPerPersonCents: 420000, marginPerPersonCents: 100000 },
    },
  },
});

function resolve(productId) {
  return Object.prototype.hasOwnProperty.call(BOOK, productId) ? BOOK[productId] : null;
}

// A recording audit. Returns the entries it was given, so a test can assert on
// the trail rather than on a call count.
function recordingAudit() {
  const entries = [];
  const audit = function (entry) {
    entries.push(entry);
  };
  audit.entries = entries;
  return audit;
}

// An audit that refuses everything, the way the real one does when an entry is
// malformed or the underlying store is unwritable.
function refusingAudit() {
  return function () {
    throw new Error("audit unavailable");
  };
}

function deps(overrides) {
  return Object.assign(
    { store: new Map(), audit: recordingAudit(), resolveProduct: resolve, now: function () {
      return "2026-10-01T09:00:00.000Z";
    } },
    overrides
  );
}

// Two Kenyan safaris, days 1-6 and 8-12. One free day between them.
function validComponents() {
  return [
    { kind: "safari", productId: "safari_mara", startDay: 1 },
    { kind: "safari", productId: "safari_amboseli", startDay: 8 },
  ];
}

function validPackage(overrides) {
  return Object.assign(
    {
      name: "Kenya Grand Circuit",
      summary: "The Mara and Amboseli combined into one journey.",
      components: validComponents(),
      actor: "advisor-1",
      correlationId: "corr-00000001",
    },
    overrides
  );
}

function eventsIn(audit) {
  return audit.entries.map(function (entry) {
    return entry.event;
  });
}

function mentions(problems, fragment) {
  return problems.some(function (problem) {
    return problem.includes(fragment);
  });
}

function main() {
  // ------------------------------------------------------- ACCEPTANCE 1 + 3

  // THE FIRST ACCEPTANCE CRITERION. An advisor selects multiple products and
  // gets back ONE offering - with its own id, its own name, and a price that
  // is the sum of its parts (445000 + 295000 = 740000, written out by hand).
  const d1 = deps();
  const created = createPackage(validPackage(), d1);
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.replayed, false);
  assert.ok(created.travelPackage.packageId.startsWith("package_"));
  assert.strictEqual(created.travelPackage.components.length, 2);
  assert.strictEqual(created.travelPackage.pricing.perPersonCents, 740000);
  assert.strictEqual(created.travelPackage.pricing.internal.costPerPersonCents, 550000);
  assert.strictEqual(created.travelPackage.version, 1);
  assert.strictEqual(created.travelPackage.createdBy, "advisor-1");
  console.log("packageStore: multiple products combine into a single offering");

  // THE TRUST CRITERION. One audit entry, naming the products that went in and
  // the margin they produce. A trail that recorded the sell price but not the
  // margin could not answer "was this sold at a loss?".
  assert.deepStrictEqual(eventsIn(d1.audit), [EVENTS.CREATED]);
  const createdEntry = d1.audit.entries[0];
  assert.strictEqual(createdEntry.outcome, "success");
  assert.strictEqual(createdEntry.actor, "advisor-1");
  assert.strictEqual(createdEntry.resource, created.travelPackage.packageId);
  assert.strictEqual(createdEntry.correlationId, "corr-00000001");
  assert.deepStrictEqual(createdEntry.context.components.productIds, [
    "safari_mara",
    "safari_amboseli",
  ]);
  assert.strictEqual(createdEntry.context.pricing.marginPerPersonCents, 190000);
  console.log("packageStore: creation is audited with the components and the margin");

  // The record is FROZEN, and the components with it. A caller handed a package
  // cannot edit the book through it - every change goes through updatePackage,
  // which is the only thing that writes a second audit entry.
  assert.ok(Object.isFrozen(created.travelPackage));
  assert.ok(Object.isFrozen(created.travelPackage.components));
  assert.ok(Object.isFrozen(created.travelPackage.components[0]));
  console.log("packageStore: a stored package is frozen");

  // IDEMPOTENT ON THE NAME. The same submission twice is one row and one audit
  // entry, and the second call says so.
  const replay = createPackage(validPackage(), d1);
  assert.strictEqual(replay.ok, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.travelPackage.packageId, created.travelPackage.packageId);
  assert.strictEqual(d1.store.size, 1);
  assert.deepStrictEqual(eventsIn(d1.audit), [EVENTS.CREATED]);
  console.log("packageStore: a replayed create writes no second row and no second entry");

  // A replay does NOT apply the retry's content. Re-sending with a discount
  // returns the ORIGINAL, undiscounted package - because a changed price is an
  // edit, and accepting it here would reprice an offering under an entry that
  // says "created".
  const replayWithDiscount = createPackage(validPackage({ discountBasisPoints: 1000 }), d1);
  assert.strictEqual(replayWithDiscount.travelPackage.pricing.perPersonCents, 740000);
  assert.strictEqual(replayWithDiscount.travelPackage.discountBasisPoints, 0);
  console.log("packageStore: a replayed create does not apply the retry's content");

  // ------------------------------------------------------------ ACCEPTANCE 2

  // THE SECOND ACCEPTANCE CRITERION. Incompatible products are refused with a
  // message, nothing is written, and the refusal is in the trail - a refusal
  // that leaves no trace is indistinguishable from a request never made.
  const d2 = deps();
  const overlapping = createPackage(
    validPackage({
      components: [
        { kind: "safari", productId: "safari_mara", startDay: 1 },
        { kind: "safari", productId: "safari_amboseli", startDay: 4 },
      ],
    }),
    d2
  );
  assert.strictEqual(overlapping.ok, false);
  assert.strictEqual(overlapping.reason, REASONS.INVALID_PACKAGE);
  assert.ok(mentions(overlapping.problems, "overlap"));
  assert.strictEqual(d2.store.size, 0);
  assert.deepStrictEqual(eventsIn(d2.audit), [EVENTS.REFUSED]);
  assert.strictEqual(d2.audit.entries[0].outcome, "failure");
  assert.strictEqual(d2.audit.entries[0].context.reason, REASONS.INVALID_PACKAGE);
  console.log("packageStore: incompatible products are refused, audited, and not stored");

  // Cross-country with no travel day - same seam, the other rule.
  const d3 = deps();
  const noTravelDay = createPackage(
    validPackage({
      components: [
        { kind: "safari", productId: "safari_mara", startDay: 1 },
        { kind: "safari", productId: "safari_serengeti", startDay: 7 },
      ],
    }),
    d3
  );
  assert.strictEqual(noTravelDay.ok, false);
  assert.ok(mentions(noTravelDay.problems, "cross-country components need a travel day"));
  assert.strictEqual(d3.store.size, 0);
  console.log("packageStore: cross-country components with no gap are refused");

  // A PRICING fault is a DIFFERENT reason code from a compatibility fault, even
  // though both are the caller's to fix. They send an advisor to two different
  // parts of the same form.
  const d4 = deps();
  const belowCost = createPackage(validPackage({ discountBasisPoints: 3000 }), d4);
  assert.strictEqual(belowCost.ok, false);
  assert.strictEqual(belowCost.reason, REASONS.INVALID_PRICING);
  assert.ok(mentions(belowCost.problems, "below the combined cost"));
  assert.strictEqual(d4.store.size, 0);
  console.log("packageStore: a below-cost discount is refused under its own reason code");

  // COMPATIBILITY IS CHECKED BEFORE PRICE. A package that both overlaps AND
  // sells below cost is told about the overlap - pricing products that cannot
  // be taken together produces a number with no meaning.
  const bothWrong = createPackage(
    validPackage({
      components: [
        { kind: "safari", productId: "safari_mara", startDay: 1 },
        { kind: "safari", productId: "safari_amboseli", startDay: 4 },
      ],
      discountBasisPoints: 4000,
    }),
    deps()
  );
  assert.strictEqual(bothWrong.reason, REASONS.INVALID_PACKAGE);
  console.log("packageStore: compatibility is reported before price");

  // ------------------------------------------------- the system-error path

  // THE STORY'S SECOND FAILURE PATH. The write lands and the audit log then
  // refuses it. The package must NOT survive: a stored offering nobody can
  // account for is the one state this module refuses to leave behind.
  const rollbackStore = new Map();
  const rolledBack = createPackage(
    validPackage(),
    deps({ store: rollbackStore, audit: refusingAudit() })
  );
  assert.strictEqual(rolledBack.ok, false);
  assert.strictEqual(rolledBack.reason, REASONS.AUDIT_UNAVAILABLE);
  assert.strictEqual(rollbackStore.size, 0);
  console.log("packageStore: a package that cannot be audited is rolled back, not kept");

  // A store that ACCEPTS the write and loses it is caught by the read-back,
  // rather than reported to the caller as a success.
  const forgetfulStore = new Map();
  forgetfulStore.set = function () {
    return forgetfulStore;
  };
  const notSaved = createPackage(validPackage(), deps({ store: forgetfulStore }));
  assert.strictEqual(notSaved.ok, false);
  assert.strictEqual(notSaved.reason, REASONS.NOT_SAVED);
  console.log("packageStore: a write that does not persist is refused, not reported as saved");

  // A mutation with no correlationId is REFUSED rather than performed
  // unaudited. Nothing is written and - deliberately - nothing is audited,
  // because there is no id to key the entry on.
  const d5 = deps();
  const unkeyed = createPackage(validPackage({ correlationId: "  " }), d5);
  assert.strictEqual(unkeyed.ok, false);
  assert.strictEqual(unkeyed.reason, REASONS.MISSING_CORRELATION_ID);
  assert.strictEqual(d5.store.size, 0);
  assert.strictEqual(d5.audit.entries.length, 0);
  console.log("packageStore: a mutation that cannot be audited is refused");

  // ------------------------------------------------------------- the edits

  const d6 = deps();
  const base = createPackage(validPackage(), d6);
  const packageId = base.travelPackage.packageId;

  // A real edit: the version moves, the changed field is named, and the trail
  // gains a SECOND entry rather than overwriting the first.
  const renamed = updatePackage(
    { packageId: packageId, changes: { name: "Kenya Classic Circuit" }, actor: "advisor-2", correlationId: "corr-00000002" },
    d6
  );
  assert.strictEqual(renamed.ok, true);
  assert.deepStrictEqual(renamed.changed, ["name"]);
  assert.strictEqual(renamed.travelPackage.version, 2);
  assert.strictEqual(renamed.travelPackage.updatedBy, "advisor-2");
  // createdBy is NOT editable - an update that could rewrite who built a
  // package is a way to erase the trail.
  assert.strictEqual(renamed.travelPackage.createdBy, "advisor-1");
  assert.deepStrictEqual(eventsIn(d6.audit), [EVENTS.CREATED, EVENTS.UPDATED]);
  assert.deepStrictEqual(d6.audit.entries[1].context.fields, ["name"]);
  console.log("packageStore: an edit bumps the version and is audited separately");

  // THE MERGE IS WHAT IS VALIDATED, NOT THE PATCH. Raising the discount alone
  // is a legal-looking one-field change that pushes a package below the cost of
  // components it still holds. Refused, and the stored record is untouched.
  const pushedBelowCost = updatePackage(
    { packageId: packageId, changes: { discountBasisPoints: 3000 }, actor: "advisor-2", correlationId: "corr-00000003" },
    d6
  );
  assert.strictEqual(pushedBelowCost.ok, false);
  assert.strictEqual(pushedBelowCost.reason, REASONS.INVALID_PRICING);
  assert.strictEqual(getPackage(packageId, d6).version, 2);
  assert.strictEqual(getPackage(packageId, d6).discountBasisPoints, 0);
  console.log("packageStore: an edit is validated against the merged record");

  // Adding a component that overlaps the ones already stored - the same rule,
  // on the compatibility side.
  const overlapOnUpdate = updatePackage(
    {
      packageId: packageId,
      changes: {
        components: [
          { kind: "safari", productId: "safari_mara", startDay: 1 },
          { kind: "safari", productId: "safari_amboseli", startDay: 3 },
        ],
      },
      actor: "advisor-2",
      correlationId: "corr-00000004",
    },
    d6
  );
  assert.strictEqual(overlapOnUpdate.reason, REASONS.INVALID_PACKAGE);
  assert.strictEqual(getPackage(packageId, d6).components.length, 2);
  console.log("packageStore: an edit that introduces an overlap is refused");

  // AN ACCEPTED EDIT RE-DERIVES THE PRICE, even when the edit is a discount
  // well inside the floor. 740000 at 1000bp = 666000.
  const discounted = updatePackage(
    { packageId: packageId, changes: { discountBasisPoints: 1000 }, actor: "advisor-2", correlationId: "corr-00000005" },
    d6
  );
  assert.strictEqual(discounted.ok, true);
  assert.strictEqual(discounted.travelPackage.pricing.perPersonCents, 666000);
  assert.strictEqual(discounted.travelPackage.version, 3);
  console.log("packageStore: an accepted edit re-derives the price");

  // A SAVE THAT CHANGES NOTHING is audited as such and does NOT move the
  // version. Re-sending the same name with different whitespace is correctly no
  // change, because the comparison is against the normalised value.
  const unchanged = updatePackage(
    { packageId: packageId, changes: { name: "  Kenya Classic Circuit  " }, actor: "advisor-2", correlationId: "corr-00000006" },
    d6
  );
  assert.strictEqual(unchanged.ok, true);
  assert.strictEqual(unchanged.unchanged, true);
  assert.deepStrictEqual(unchanged.changed, []);
  assert.strictEqual(unchanged.travelPackage.version, 3);
  assert.ok(eventsIn(d6.audit).includes(EVENTS.UNCHANGED));
  console.log("packageStore: a save that changes nothing is audited and does not bump the version");

  // Submission ORDER is not a change either - components normalise sorted by
  // start day.
  const reordered = updatePackage(
    {
      packageId: packageId,
      changes: {
        components: [
          { kind: "safari", productId: "safari_amboseli", startDay: 8 },
          { kind: "safari", productId: "safari_mara", startDay: 1 },
        ],
      },
      actor: "advisor-2",
      correlationId: "corr-00000007",
    },
    d6
  );
  assert.strictEqual(reordered.unchanged, true);
  console.log("packageStore: reordering the same components is not a change");

  // The patch allow-list. Unknown fields are refused BY NAME rather than
  // ignored - a "pricing" key in the body is someone trying to set a derived
  // figure, and silently dropping it would let them believe they had.
  const unknownField = updatePackage(
    { packageId: packageId, changes: { pricing: { perPersonCents: 1 } }, actor: "a", correlationId: "corr-00000008" },
    d6
  );
  assert.strictEqual(unknownField.reason, REASONS.UNKNOWN_FIELDS);
  assert.ok(mentions(unknownField.problems, "Not editable: pricing."));
  console.log("packageStore: a patch naming a derived field is refused by name");

  assert.strictEqual(
    updatePackage({ packageId: packageId, changes: {}, actor: "a", correlationId: "corr-00000009" }, d6).reason,
    REASONS.EMPTY_UPDATE
  );
  assert.strictEqual(
    updatePackage({ packageId: "package_nope", changes: { name: "x" }, actor: "a", correlationId: "corr-00000010" }, d6)
      .reason,
    REASONS.UNKNOWN_PACKAGE
  );
  console.log("packageStore: empty patches and unknown packages are refused");

  // A prototype-chain key in the patch reaches the allow-list, not the record.
  assert.strictEqual(
    updatePackage(
      { packageId: packageId, changes: { constructor: "x" }, actor: "a", correlationId: "corr-00000011" },
      d6
    ).reason,
    REASONS.UNKNOWN_FIELDS
  );
  console.log("packageStore: a prototype-chain key in a patch is refused");

  // RENAMING ONTO ANOTHER PACKAGE'S NAME is the duplicate createPackage exists
  // to prevent, arriving through the other door.
  createPackage(
    validPackage({ name: "Tanzania Migration Journey", correlationId: "corr-00000012" }),
    d6
  );
  const clash = updatePackage(
    { packageId: packageId, changes: { name: "tanzania migration journey" }, actor: "a", correlationId: "corr-00000013" },
    d6
  );
  assert.strictEqual(clash.reason, REASONS.DUPLICATE_PACKAGE);
  console.log("packageStore: renaming onto another package's name is refused");

  // AN EDIT THAT CANNOT BE AUDITED PUTS THE OLD VERSION BACK - not the new one,
  // and not nothing. The rollback has a `previous` to restore, unlike a create.
  const beforeFailedEdit = getPackage(packageId, d6);
  const failedEdit = updatePackage(
    { packageId: packageId, changes: { summary: "A new summary." }, actor: "a", correlationId: "corr-00000014" },
    Object.assign({}, d6, { audit: refusingAudit() })
  );
  assert.strictEqual(failedEdit.reason, REASONS.AUDIT_UNAVAILABLE);
  assert.deepStrictEqual(getPackage(packageId, d6), beforeFailedEdit);
  console.log("packageStore: an edit that cannot be audited restores the previous version");

  // --------------------------------------------------------------- reading

  // Sorted by name - a package book is read by name.
  const listed = listPackages(d6);
  assert.deepStrictEqual(
    listed.map(function (entry) {
      return entry.name;
    }),
    ["Kenya Classic Circuit", "Tanzania Migration Journey"]
  );
  console.log("packageStore: the book lists alphabetically by name");

  assert.strictEqual(getPackage("", d6), null);
  assert.strictEqual(getPackage(null, d6), null);
  assert.strictEqual(getPackage("package_nope", d6), null);
  console.log("packageStore: an unusable or unknown id reads as null");

  // The editable list is published rather than reimplemented by clients, and
  // `pricing` is deliberately NOT in it.
  assert.ok(!MUTABLE_FIELDS.includes("pricing"));
  assert.ok(!MUTABLE_FIELDS.includes("packageId"));
  assert.ok(!MUTABLE_FIELDS.includes("createdBy"));
  console.log("packageStore: derived and identity fields are not editable");

  console.log("packageStore: all tests passed");
}

main();
