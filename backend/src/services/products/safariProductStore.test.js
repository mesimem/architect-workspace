// STORY-015, the storage-and-audit half. All three acceptance criteria are
// marked below; the third failure path ("unauthorized product modification")
// is a property of the HTTP boundary and is tested in http/products.test.js.
//
// The rule these tests hold the module to: a refused change leaves the stored
// product EXACTLY as it was, and an accepted change is visible on the very next
// read. Both halves are asserted every time, because a store that refuses an
// edit and half-applies it is worse than one that accepts a bad edit - the
// product manager is told no and the catalog says otherwise.

const assert = require("assert");

const {
  createSafariProduct,
  updateSafariProduct,
  getSafariProduct,
  listSafariProducts,
  __resetProductsForTests,
} = require("./safariProductStore");
const { findAuditEntry, deriveAuditKey, getAuditEntries } = require("../audit/auditLog");

function sampleProduct(overrides) {
  return Object.assign(
    {
      name: "Serengeti Migration Safari",
      country: "Tanzania",
      summary: "Follow the wildebeest migration across the Serengeti plains.",
      durationDays: 3,
      itinerary: [
        { day: 1, title: "Arrive Arusha", location: "Arusha" },
        { day: 2, title: "Central Serengeti", detail: "Full day game drive.", location: "Seronera" },
        { day: 3, title: "Depart Kilimanjaro", location: "Kilimanjaro" },
      ],
      pricing: {
        currency: "USD",
        perPersonCents: 520000,
        costPerPersonCents: 420000,
        singleSupplementCents: 90000,
      },
      actor: "PM-1",
      correlationId: "corr-create-0001",
    },
    overrides || {}
  );
}

// The audit entry a create writes, looked up by the key the module derives.
function createdEntry(productId) {
  return findAuditEntry(deriveAuditKey(productId, "products.safari.created"));
}

// The audit entry a given REQUEST wrote. Updates key on the correlationId, not
// the product id - see the store's header on why.
function entryFor(correlationId, event) {
  return findAuditEntry(deriveAuditKey(correlationId, event));
}

function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetProductsForTests();

  // ----- CRITERION 1: a created product includes itineraries and pricing ---

  const created = createSafariProduct(sampleProduct());
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.replayed, false);

  const product = created.product;
  assert.ok(product.productId.startsWith("safari_"));
  assert.strictEqual(product.name, "Serengeti Migration Safari");
  assert.strictEqual(product.durationDays, 3);
  assert.strictEqual(product.version, 1);
  assert.strictEqual(product.createdBy, "PM-1");

  // The itinerary is there, in full, one entry per day of the duration.
  assert.strictEqual(product.itinerary.length, 3);
  assert.deepStrictEqual(
    product.itinerary.map((day) => day.day),
    [1, 2, 3]
  );
  assert.strictEqual(product.itinerary[1].title, "Central Serengeti");
  assert.strictEqual(product.itinerary[1].location, "Seronera");

  // The pricing is there, with the margin derived - 520000 - 420000 = 100000,
  // written out rather than recomputed from the implementation's own formula.
  assert.strictEqual(product.pricing.currency, "USD");
  assert.strictEqual(product.pricing.perPersonCents, 520000);
  assert.strictEqual(product.pricing.singleSupplementCents, 90000);
  assert.strictEqual(product.pricing.internal.costPerPersonCents, 420000);
  assert.strictEqual(product.pricing.internal.marginPerPersonCents, 100000);
  console.log("safariProductStore: a created product carries its itinerary and its pricing");

  // And it is readable back immediately, which is what makes the create real
  // rather than a return value.
  assert.deepStrictEqual(getSafariProduct(product.productId), product);
  console.log("safariProductStore: a created product is readable straight away");

  // ----- CRITERION 3, CREATE SIDE: an audit entry exists ------------------

  const createAudit = createdEntry(product.productId);
  assert.ok(createAudit, "no audit entry was written for the create");
  assert.strictEqual(createAudit.event, "products.safari.created");
  assert.strictEqual(createAudit.outcome, "success");
  assert.strictEqual(createAudit.actor, "PM-1");
  assert.strictEqual(createAudit.resource, product.productId);
  assert.strictEqual(createAudit.correlationId, "corr-create-0001");
  // The itinerary is recorded as a digest, deliberately - see the store header
  // on auditLog's depth cap. A digest is smaller and true; the full days would
  // have been stored as "<truncated>".
  assert.deepStrictEqual(createAudit.context.itinerary, { days: 3 });
  assert.strictEqual(createAudit.context.pricing.perPersonCents, 520000);
  console.log("safariProductStore: creating a product writes an audit entry");

  // ----- IDEMPOTENCY: the same package twice is one product ---------------

  const replay = createSafariProduct(sampleProduct({ correlationId: "corr-create-0002" }));
  assert.strictEqual(replay.ok, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.product.productId, product.productId);
  assert.strictEqual(listSafariProducts().length, 1);
  // One create, one audit entry. The second call wrote nothing.
  assert.strictEqual(
    getAuditEntries().filter((e) => e.event === "products.safari.created").length,
    1
  );
  console.log("safariProductStore: the same package submitted twice creates one product");

  // A REPLAY DOES NOT SILENTLY APPLY THE SECOND CALL'S CONTENT. Re-submitting
  // with a different price returns the original, unchanged - repricing is an
  // EDIT and must be audited as one, not smuggled in under "created".
  const replayWithNewPrice = createSafariProduct(
    sampleProduct({
      correlationId: "corr-create-0003",
      pricing: {
        currency: "USD",
        perPersonCents: 999000,
        costPerPersonCents: 420000,
      },
    })
  );
  assert.strictEqual(replayWithNewPrice.replayed, true);
  assert.strictEqual(getSafariProduct(product.productId).pricing.perPersonCents, 520000);
  console.log("safariProductStore: a replayed create does not quietly reprice the product");

  // ----- CRITERION 2: an itinerary update is reflected immediately --------

  const updated = updateSafariProduct({
    productId: product.productId,
    changes: {
      itinerary: [
        { day: 1, title: "Arrive Arusha", location: "Arusha" },
        { day: 2, title: "Ngorongoro Crater rim", detail: "Crater descent.", location: "Ngorongoro" },
        { day: 3, title: "Depart Kilimanjaro", location: "Kilimanjaro" },
      ],
    },
    actor: "PM-2",
    correlationId: "corr-update-0001",
  });

  assert.strictEqual(updated.ok, true);
  assert.deepStrictEqual(updated.changed, ["itinerary"]);
  assert.strictEqual(updated.unchanged, false);
  assert.strictEqual(updated.product.version, 2);
  assert.strictEqual(updated.product.updatedBy, "PM-2");
  // Authorship of the original is untouched by an edit - that is the point of
  // createdBy not being editable.
  assert.strictEqual(updated.product.createdBy, "PM-1");

  // IMMEDIATELY, on the very next read, through BOTH doors into the book. A
  // stale copy in either one is the defect this criterion is about.
  const readBack = getSafariProduct(product.productId);
  assert.strictEqual(readBack.itinerary[1].title, "Ngorongoro Crater rim");
  assert.strictEqual(readBack.itinerary[1].location, "Ngorongoro");
  assert.strictEqual(readBack.version, 2);
  assert.strictEqual(listSafariProducts()[0].itinerary[1].title, "Ngorongoro Crater rim");
  // The days that did not change are still exactly as they were.
  assert.strictEqual(readBack.itinerary[0].title, "Arrive Arusha");
  assert.strictEqual(readBack.itinerary[2].title, "Depart Kilimanjaro");
  console.log("safariProductStore: an itinerary update is visible on the next read");

  // ----- CRITERION 3, UPDATE SIDE: an audit entry exists, per request -----

  const updateAudit = entryFor("corr-update-0001", "products.safari.updated");
  assert.ok(updateAudit, "no audit entry was written for the update");
  assert.deepStrictEqual(updateAudit.context.fields, ["itinerary"]);
  assert.strictEqual(updateAudit.actor, "PM-2");
  assert.strictEqual(updateAudit.resource, product.productId);
  assert.strictEqual(updateAudit.context.version, 2);
  // WHICH DAY MOVED, not merely "the itinerary changed" - the question asked
  // when a customer says their day 2 differs from the brochure.
  assert.deepStrictEqual(updateAudit.context.daysChanged, [2]);
  assert.deepStrictEqual(updateAudit.context.before.itinerary, { days: 3 });
  console.log("safariProductStore: updating a product writes an audit entry naming what changed");

  // A SECOND EDIT WRITES ITS OWN DISTINCT ENTRY. This is the trap auditLog.js
  // documents: keyed on the product id instead of the request, this second
  // repricing would have been silently discarded and the package would show its
  // original price in the trail forever.
  const reprice = updateSafariProduct({
    productId: product.productId,
    changes: {
      pricing: { currency: "USD", perPersonCents: 560000, costPerPersonCents: 420000 },
    },
    actor: "PM-2",
    correlationId: "corr-update-0002",
  });
  assert.strictEqual(reprice.ok, true);
  assert.deepStrictEqual(reprice.changed, ["pricing"]);
  assert.strictEqual(reprice.product.version, 3);
  assert.strictEqual(reprice.product.pricing.perPersonCents, 560000);
  // The supplement was not in this patch and is therefore gone, because pricing
  // is replaced as a block, not merged field by field. Asserted so the
  // behaviour is deliberate and documented rather than discovered later.
  assert.strictEqual(reprice.product.pricing.singleSupplementCents, 0);
  assert.strictEqual(reprice.product.pricing.internal.marginPerPersonCents, 140000);

  const repriceAudit = entryFor("corr-update-0002", "products.safari.updated");
  assert.ok(repriceAudit, "the second edit wrote no audit entry of its own");
  assert.notStrictEqual(repriceAudit.auditKey, updateAudit.auditKey);
  assert.strictEqual(repriceAudit.context.before.pricing.perPersonCents, 520000);
  assert.strictEqual(repriceAudit.context.after.pricing.perPersonCents, 560000);
  console.log("safariProductStore: a second edit is audited separately, with its own before/after");

  // ----- SAVING WITH NOTHING CHANGED -------------------------------------

  const noop = updateSafariProduct({
    productId: product.productId,
    changes: { name: "  Serengeti Migration Safari  " },
    actor: "PM-2",
    correlationId: "corr-update-0003",
  });
  assert.strictEqual(noop.ok, true);
  assert.strictEqual(noop.unchanged, true);
  assert.deepStrictEqual(noop.changed, []);
  // The version does NOT move: nothing changed, so this is not a new revision.
  assert.strictEqual(getSafariProduct(product.productId).version, 3);
  assert.ok(entryFor("corr-update-0003", "products.safari.unchanged"));
  console.log("safariProductStore: a save that changes nothing is recorded as such");

  // Re-sending the SAME itinerary in a different order is also no change - the
  // comparison is against normalised values, not against what was typed.
  const reordered = updateSafariProduct({
    productId: product.productId,
    changes: {
      itinerary: [
        getSafariProduct(product.productId).itinerary[2],
        getSafariProduct(product.productId).itinerary[0],
        getSafariProduct(product.productId).itinerary[1],
      ],
    },
    actor: "PM-2",
    correlationId: "corr-update-0004",
  });
  assert.strictEqual(reordered.unchanged, true);
  console.log("safariProductStore: the same itinerary reordered is not a change");

  // ----- FAILURE PATH: itinerary conflicts, on the UPDATE side ------------

  const before = getSafariProduct(product.productId);

  // Shortening the duration alone would orphan day 3, which the stored
  // itinerary still describes. The PATCH is legal in isolation; the MERGE is
  // not, and the merge is what gets validated.
  const shortened = updateSafariProduct({
    productId: product.productId,
    changes: { durationDays: 2 },
    actor: "PM-2",
    correlationId: "corr-update-0005",
  });
  assert.strictEqual(shortened.ok, false);
  assert.strictEqual(shortened.reason, "invalid_product");
  assert.ok(
    shortened.problems.some((p) => p === "itinerary describes day 3 but the product runs 2 days"),
    "expected a conflict problem, got " + JSON.stringify(shortened.problems)
  );
  // REFUSED MEANS UNCHANGED. Not shortened, not half-applied.
  assert.deepStrictEqual(getSafariProduct(product.productId), before);
  // And the refusal itself is audited - a refusal that leaves no trace is
  // indistinguishable from a request that was never made.
  const refusalAudit = entryFor("corr-update-0005", "products.safari.refused");
  assert.ok(refusalAudit, "the refusal was not audited");
  assert.strictEqual(refusalAudit.outcome, "failure");
  assert.strictEqual(refusalAudit.context.reason, "invalid_product");
  console.log("safariProductStore: a duration that orphans a day is refused and audited");

  // Lengthening the duration alone leaves a gap - the same rule from the other
  // direction.
  const lengthened = updateSafariProduct({
    productId: product.productId,
    changes: { durationDays: 5 },
    actor: "PM-2",
    correlationId: "corr-update-0006",
  });
  assert.strictEqual(lengthened.ok, false);
  assert.ok(lengthened.problems.some((p) => p === "itinerary is missing day 4, 5 of 5"));
  assert.deepStrictEqual(getSafariProduct(product.productId), before);
  console.log("safariProductStore: a duration that leaves unsold days is refused");

  // A duration change WITH a matching itinerary is accepted - the rule is about
  // consistency, not about forbidding longer packages.
  const extended = updateSafariProduct({
    productId: product.productId,
    changes: {
      durationDays: 4,
      itinerary: before.itinerary.concat([{ day: 4, title: "Lake Manyara" }]),
    },
    actor: "PM-2",
    correlationId: "corr-update-0007",
  });
  assert.strictEqual(extended.ok, true);
  assert.deepStrictEqual(extended.changed, ["durationDays", "itinerary"]);
  assert.strictEqual(getSafariProduct(product.productId).itinerary.length, 4);
  assert.deepStrictEqual(
    entryFor("corr-update-0007", "products.safari.updated").context.daysChanged,
    [4]
  );
  console.log("safariProductStore: a duration change with a matching itinerary is accepted");

  // ----- FAILURE PATH: incorrect pricing data, on the UPDATE side ---------

  const priced = getSafariProduct(product.productId);
  const belowCost = updateSafariProduct({
    productId: product.productId,
    changes: { pricing: { currency: "USD", perPersonCents: 5600, costPerPersonCents: 420000 } },
    actor: "PM-2",
    correlationId: "corr-update-0008",
  });
  assert.strictEqual(belowCost.ok, false);
  assert.strictEqual(belowCost.reason, "invalid_product");
  assert.ok(belowCost.problems.some((p) => p.includes("must not be below costPerPersonCents")));
  assert.deepStrictEqual(getSafariProduct(product.productId), priced);
  console.log("safariProductStore: repricing a package below cost is refused, and changes nothing");

  // ----- FAILURE PATH: the patch itself is unusable ----------------------

  const unknownField = updateSafariProduct({
    productId: product.productId,
    changes: { productId: "safari_someone_elses", version: 99 },
    actor: "PM-2",
    correlationId: "corr-update-0009",
  });
  assert.strictEqual(unknownField.ok, false);
  assert.strictEqual(unknownField.reason, "unknown_fields");
  assert.ok(unknownField.problems[0].includes("productId, version"));
  console.log("safariProductStore: an attempt to rewrite the id or the version is refused");

  const empty = updateSafariProduct({
    productId: product.productId,
    changes: {},
    actor: "PM-2",
    correlationId: "corr-update-0010",
  });
  assert.strictEqual(empty.reason, "empty_update");

  const unknownProduct = updateSafariProduct({
    productId: "safari_does_not_exist",
    changes: { name: "Anything" },
    actor: "PM-2",
    correlationId: "corr-update-0011",
  });
  assert.strictEqual(unknownProduct.reason, "unknown_product");
  assert.ok(entryFor("corr-update-0011", "products.safari.refused"));
  console.log("safariProductStore: an empty patch and an unknown product are refused and audited");

  // ----- NO correlationId MEANS NO CHANGE -------------------------------

  // The guardrail is that every change is audited, so "I cannot audit this" has
  // to mean "I will not do this".
  const unaudited = updateSafariProduct({
    productId: product.productId,
    changes: { name: "Renamed without a trace" },
    actor: "PM-2",
  });
  assert.strictEqual(unaudited.ok, false);
  assert.strictEqual(unaudited.reason, "missing_correlation_id");
  assert.strictEqual(getSafariProduct(product.productId).name, "Serengeti Migration Safari");

  const unauditedCreate = createSafariProduct(
    sampleProduct({ name: "Okavango Delta Safari", country: "Botswana", correlationId: "" })
  );
  assert.strictEqual(unauditedCreate.reason, "missing_correlation_id");
  assert.strictEqual(listSafariProducts().length, 1);
  console.log("safariProductStore: a change that cannot be audited is refused, not performed");

  // ----- DUPLICATES THROUGH THE OTHER DOOR ------------------------------

  const second = createSafariProduct(
    sampleProduct({
      name: "Okavango Delta Safari",
      country: "Botswana",
      correlationId: "corr-create-0004",
    })
  );
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.replayed, false);

  // The same name in a DIFFERENT country is not a duplicate: "Big Five Safari"
  // in Kenya and in Botswana are different products.
  const sameNameElsewhere = createSafariProduct(
    sampleProduct({
      name: "Okavango Delta Safari",
      country: "Namibia",
      correlationId: "corr-create-0005",
    })
  );
  assert.strictEqual(sameNameElsewhere.replayed, false);
  assert.strictEqual(listSafariProducts().length, 3);

  // Renaming one product onto another's (name + country) is the duplicate that
  // create prevents, arriving through the update door.
  const collide = updateSafariProduct({
    productId: sameNameElsewhere.product.productId,
    changes: { country: "Botswana" },
    actor: "PM-2",
    correlationId: "corr-update-0012",
  });
  assert.strictEqual(collide.ok, false);
  assert.strictEqual(collide.reason, "duplicate_product");
  assert.strictEqual(getSafariProduct(sameNameElsewhere.product.productId).country, "Namibia");
  console.log("safariProductStore: an edit that would duplicate another product is refused");

  // ----- THE BOOK ITSELF ------------------------------------------------

  // Sorted by name, then country - a product book is read by name.
  assert.deepStrictEqual(
    listSafariProducts().map((p) => p.name + " / " + p.country),
    [
      "Okavango Delta Safari / Botswana",
      "Okavango Delta Safari / Namibia",
      "Serengeti Migration Safari / Tanzania",
    ]
  );
  console.log("safariProductStore: the book lists by name, then by country");

  // A HANDED-OUT RECORD IS NOT A WAY INTO THE STORE. Frozen top level, and
  // frozen inside the itinerary and the pricing block, so the only path to a
  // change is updateSafariProduct - the only thing that audits.
  const held = getSafariProduct(product.productId);
  assert.ok(Object.isFrozen(held));
  assert.ok(Object.isFrozen(held.itinerary));
  assert.ok(Object.isFrozen(held.itinerary[0]));
  assert.ok(Object.isFrozen(held.pricing));
  assert.ok(Object.isFrozen(held.pricing.internal));
  held.name = "Rewritten";
  held.pricing.perPersonCents = 1;
  assert.strictEqual(getSafariProduct(product.productId).name, "Serengeti Migration Safari");
  assert.strictEqual(getSafariProduct(product.productId).pricing.perPersonCents, 560000);
  console.log("safariProductStore: a caller cannot edit the book through a record it was handed");

  assert.strictEqual(getSafariProduct("   "), null);
  assert.strictEqual(getSafariProduct(undefined), null);
  console.log("safariProductStore: a blank or missing id reads as nothing, not as a crash");

  console.log("safariProductStore: all tests passed");
}

main();
