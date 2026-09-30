// STORY-015, the pure half. Two of the story's three named failure paths live
// here - "incorrect pricing data" and "itinerary conflicts" - and both are
// defects that look completely normal on screen: a 14-day package whose
// itinerary quietly skips day 9, a price that is $4,200 where it should have
// been 420000 cents. So they are tested exhaustively, with the expected
// figures written out by hand rather than recomputed from the implementation's
// own formula. A test that restates the code cannot catch the code being wrong.
//
// The third failure path, "unauthorized product modification", is a property of
// the HTTP boundary and is tested in http/products.test.js, where it lives.

const assert = require("assert");

const {
  validateSafariProduct,
  validateItinerary,
  validatePricing,
  normaliseItinerary,
  normalisePricing,
  MAX_DURATION_DAYS,
} = require("./safariProductValidation");

// A realistic three-day product: sold at $5,200 a head against a $4,200 cost,
// with a $900 single supplement.
function sampleProduct() {
  return {
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
  };
}

function main() {
  // HAPPY PATH: a complete product has no problems at all.
  assert.deepStrictEqual(validateSafariProduct(sampleProduct()), []);
  console.log("safariProductValidation: a complete safari product validates clean");

  // DETERMINISM. No clock, no store, no randomness - the same product validates
  // the same way on a retry and in a year, which is what lets a refusal be
  // reproduced from the submitted body alone.
  assert.deepStrictEqual(
    validateSafariProduct(sampleProduct()),
    validateSafariProduct(sampleProduct())
  );
  console.log("safariProductValidation: the same product always validates the same way");

  // ----- ITINERARY CONFLICTS (failure path 2) ------------------------------

  // TWO ENTRIES FOR ONE DAY. The fault the eye slides over on a long itinerary:
  // nothing is missing, nothing is out of range, the count even looks right.
  const duplicated = sampleProduct();
  duplicated.itinerary[2] = { day: 2, title: "Also day two" };
  const duplicateProblems = validateSafariProduct(duplicated);
  assert.ok(
    duplicateProblems.some((p) => p === "itinerary has more than one entry for day 2"),
    "expected a duplicate-day problem, got " + JSON.stringify(duplicateProblems)
  );
  // And the day the duplicate displaced is reported as missing, so the product
  // manager is told both halves of what went wrong in one pass.
  assert.ok(duplicateProblems.some((p) => p === "itinerary is missing day 3 of 3"));
  console.log("safariProductValidation: two entries claiming the same day are a conflict");

  // A DAY BEYOND THE PRODUCT'S DURATION.
  const overrun = sampleProduct();
  overrun.itinerary[2] = { day: 9, title: "Day nine of a three-day safari" };
  const overrunProblems = validateSafariProduct(overrun);
  assert.ok(
    overrunProblems.some((p) => p === "itinerary describes day 9 but the product runs 3 days"),
    "expected an out-of-range problem, got " + JSON.stringify(overrunProblems)
  );
  console.log("safariProductValidation: a day past the duration is a conflict");

  // A GAP: unsold time in the middle of a package.
  const gapped = sampleProduct();
  gapped.durationDays = 4;
  const gapProblems = validateSafariProduct(gapped);
  assert.ok(
    gapProblems.some((p) => p === "itinerary is missing day 4 of 4"),
    "expected a missing-day problem, got " + JSON.stringify(gapProblems)
  );
  console.log("safariProductValidation: an itinerary short of its duration is a conflict");

  // EVERY MISSING DAY IS NAMED, not just the first. Fixing an itinerary one
  // round trip per day is how a product manager gives up and emails a
  // spreadsheet instead.
  const sparse = validateItinerary([{ day: 1, title: "Arrive" }], 4);
  assert.ok(sparse.some((p) => p === "itinerary is missing day 2, 3, 4 of 4"));
  console.log("safariProductValidation: all missing days are reported together");

  // OUT OF ORDER IS NOT A FAULT. A form that submits a reordered list is
  // normal; refusing it would be rigour that only hurts the user.
  const shuffled = sampleProduct();
  shuffled.itinerary = [shuffled.itinerary[2], shuffled.itinerary[0], shuffled.itinerary[1]];
  assert.deepStrictEqual(validateSafariProduct(shuffled), []);
  console.log("safariProductValidation: an out-of-order itinerary is valid");

  // AN EMPTY OR ABSENT ITINERARY. "Itineraries and pricing" is the whole
  // requirement, so a product without days is not a product.
  assert.deepStrictEqual(validateItinerary([], 3), [
    "itinerary must be a non-empty array of day entries",
  ]);
  assert.deepStrictEqual(validateItinerary(undefined, 3), [
    "itinerary must be a non-empty array of day entries",
  ]);
  console.log("safariProductValidation: a product with no itinerary is refused");

  // A DAY ENTRY THAT IS NOT AN OBJECT, and a day with no title. Reported by
  // INDEX, because the day number may be the thing that is missing.
  const junk = validateItinerary(["day one", { day: 2 }], 2);
  assert.ok(junk.some((p) => p === "itinerary[0]: must be an object; received a string of length 7"));
  assert.ok(junk.some((p) => p === "itinerary[1]: title must be a non-empty string"));
  console.log("safariProductValidation: malformed day entries are reported by index");

  // AN UNKNOWN FIELD ON A DAY. A typo is a refusal, not a field that vanishes
  // while the product manager believes they saved it.
  const typo = validateItinerary([{ day: 1, titel: "Arrive" }], 1);
  assert.ok(typo.some((p) => p === "itinerary[0]: unknown fields: titel"));
  console.log("safariProductValidation: an unknown field on a day is refused by name");

  // ----- INCORRECT PRICING DATA (failure path 1) ---------------------------

  // A FRACTIONAL CENT. The float that would make every later total wrong by an
  // amount nobody can explain.
  const fractional = validatePricing({
    currency: "USD",
    perPersonCents: 520000.5,
    costPerPersonCents: 420000,
  });
  assert.ok(
    fractional.some((p) => p.startsWith("pricing: perPersonCents must be a whole number")),
    "expected a fractional-cents refusal, got " + JSON.stringify(fractional)
  );
  console.log("safariProductValidation: a fractional cent is refused, not rounded");

  // A PRICE IN DOLLARS WHERE CENTS WERE MEANT - the transposition that makes a
  // $5,200 safari cost $52. It is caught as being below cost, which is the
  // check that makes the slip visible instead of merely cheap.
  const dollars = validatePricing({
    currency: "USD",
    perPersonCents: 5200,
    costPerPersonCents: 420000,
  });
  assert.ok(
    dollars.some((p) => p.startsWith("pricing: perPersonCents must not be below costPerPersonCents")),
    "expected a below-cost refusal, got " + JSON.stringify(dollars)
  );
  console.log("safariProductValidation: a package priced below cost is refused");

  // A FREE SAFARI. Zero is a whole number of cents and passes every bound, so
  // it needs its own rule: a product with no price is a pricing data error.
  const free = validatePricing({ currency: "USD", perPersonCents: 0, costPerPersonCents: 0 });
  assert.ok(free.some((p) => p.startsWith("pricing: perPersonCents must be a whole number")));
  console.log("safariProductValidation: a zero price is refused");

  // NEGATIVE MONEY, AND MONEY PAST THE CEILING.
  const negative = validatePricing({
    currency: "USD",
    perPersonCents: 520000,
    costPerPersonCents: -1,
    singleSupplementCents: -5,
  });
  assert.ok(negative.some((p) => p.startsWith("pricing: costPerPersonCents")));
  assert.ok(negative.some((p) => p.startsWith("pricing: singleSupplementCents")));
  const huge = validatePricing({
    currency: "USD",
    perPersonCents: 1000000001,
    costPerPersonCents: 1,
  });
  assert.ok(huge.some((p) => p.startsWith("pricing: perPersonCents")));
  console.log("safariProductValidation: negative and absurd figures are refused");

  // ONE CURRENCY. A product priced in a currency the system cannot convert is
  // refused rather than stored as a number with a misleading label.
  const foreign = validatePricing({
    currency: "TZS",
    perPersonCents: 520000,
    costPerPersonCents: 420000,
  });
  assert.ok(foreign.some((p) => p === "pricing: currency must be one of USD"));
  console.log("safariProductValidation: an unsupported currency is refused");

  // MISSING COST. Required, because without it the below-cost check - the most
  // valuable one in this module - can never fire.
  const noCost = validatePricing({ currency: "USD", perPersonCents: 520000 });
  assert.ok(noCost.some((p) => p.startsWith("pricing: costPerPersonCents")));
  console.log("safariProductValidation: a product with no cost figure is refused");

  // A NON-OBJECT PRICING BLOCK, and an unknown pricing field.
  assert.deepStrictEqual(validatePricing(null), ["pricing must be an object; received null"]);
  const pricingTypo = validatePricing({
    currency: "USD",
    perPersonCents: 520000,
    costPerPersonCents: 420000,
    marginPerPersonCents: 100000,
  });
  // Margin is DERIVED, never supplied: a supplied margin is a third number that
  // can disagree with the other two.
  assert.ok(pricingTypo.some((p) => p === "pricing: unknown fields: marginPerPersonCents"));
  console.log("safariProductValidation: a supplied margin is refused - margin is derived");

  // ----- THE PRODUCT ENVELOPE ---------------------------------------------

  assert.deepStrictEqual(validateSafariProduct(null), [
    "product must be an object; received null",
  ]);
  assert.deepStrictEqual(validateSafariProduct([]), [
    "product must be an object; received an array of length 0",
  ]);
  console.log("safariProductValidation: a non-object product is refused");

  const blank = validateSafariProduct({
    name: "   ",
    country: "",
    durationDays: 0,
    itinerary: [{ day: 1, title: "Arrive" }],
    pricing: { currency: "USD", perPersonCents: 1, costPerPersonCents: 0 },
  });
  assert.ok(blank.some((p) => p === "name is required and must not be blank"));
  assert.ok(blank.some((p) => p === "country is required and must not be blank"));
  assert.ok(blank.some((p) => p === "summary is required and must not be blank"));
  assert.ok(blank.some((p) => p.startsWith("durationDays must be a whole number from 1 to")));
  console.log("safariProductValidation: blank required text and a zero duration are refused");

  // A DURATION NOBODY TYPED ON PURPOSE. 4000 days is a pasted year or a units
  // slip, and MAX_DURATION_DAYS is where it stops.
  const eternal = sampleProduct();
  eternal.durationDays = MAX_DURATION_DAYS + 1;
  assert.ok(
    validateSafariProduct(eternal).some((p) => p.startsWith("durationDays must be a whole number"))
  );
  console.log("safariProductValidation: an absurd duration is refused");

  // EVERY FAULT AT ONCE. A bad name, a bad duration, a conflicting itinerary
  // and a transposed price take ONE round trip to discover, not four.
  const everythingWrong = validateSafariProduct({
    name: "",
    country: "Kenya",
    summary: "Masai Mara.",
    durationDays: 3,
    itinerary: [
      { day: 1, title: "Arrive" },
      { day: 1, title: "Arrive again" },
    ],
    pricing: { currency: "EUR", perPersonCents: 100, costPerPersonCents: 420000 },
  });
  assert.ok(
    everythingWrong.length >= 5,
    "expected every fault at once, got " + JSON.stringify(everythingWrong)
  );
  console.log("safariProductValidation: all faults are reported in one pass");

  // PROBLEMS DO NOT ECHO THE SUBMITTED VALUE BACK. A product carries prose a
  // person wrote, and these strings end up in HTTP responses and log lines.
  const longText = validateSafariProduct({
    name: "x".repeat(500),
    country: "y".repeat(500),
    summary: "z".repeat(5000),
    durationDays: 1,
    itinerary: [{ day: 1, title: "q".repeat(500) }],
    pricing: { currency: "USD", perPersonCents: 520000, costPerPersonCents: 420000 },
  });
  assert.ok(longText.length >= 4);
  assert.ok(
    longText.every((p) => !p.includes("xxxxx") && !p.includes("zzzzz") && !p.includes("qqqqq")),
    "a problem echoed the submitted text back: " + JSON.stringify(longText)
  );
  console.log("safariProductValidation: a refusal describes the fault without repeating the input");

  // ----- NORMALISATION -----------------------------------------------------

  // SORTED, TRIMMED, AND OPTIONAL FIELDS FILLED IN AS null, so every stored day
  // has one shape and a reader never asks whether a key is absent or empty.
  const normalised = normaliseItinerary([
    { day: 2, title: "  Central Serengeti  ", detail: "  Game drive.  ", location: "  Seronera  " },
    { day: 1, title: "Arrive Arusha" },
  ]);
  assert.deepStrictEqual(normalised[0], {
    day: 1,
    title: "Arrive Arusha",
    detail: null,
    location: null,
  });
  assert.deepStrictEqual(normalised[1], {
    day: 2,
    title: "Central Serengeti",
    detail: "Game drive.",
    location: "Seronera",
  });
  console.log("safariProductValidation: normalisation sorts by day and trims every field");

  // NORMALISATION DOES NOT MUTATE WHAT IT WAS GIVEN. The caller's array is
  // still in the order they submitted it - .sort() in place on a caller's array
  // is a bug that only shows up in whoever reads it next.
  const original = [
    { day: 2, title: "Second" },
    { day: 1, title: "First" },
  ];
  normaliseItinerary(original);
  assert.strictEqual(original[0].day, 2);
  console.log("safariProductValidation: normalisation leaves the caller's array untouched");

  // FROZEN, top level and per day. A caller handed an itinerary cannot edit the
  // stored product through it.
  assert.ok(Object.isFrozen(normalised));
  assert.ok(Object.isFrozen(normalised[0]));
  console.log("safariProductValidation: a normalised itinerary is frozen");

  // MARGIN IS DERIVED HERE, and the supplement defaults to nothing. 520000 -
  // 420000 = 100000, written out rather than recomputed.
  const pricing = normalisePricing({
    currency: "USD",
    perPersonCents: 520000,
    costPerPersonCents: 420000,
  });
  assert.strictEqual(pricing.singleSupplementCents, 0);
  assert.strictEqual(pricing.internal.costPerPersonCents, 420000);
  assert.strictEqual(pricing.internal.marginPerPersonCents, 100000);
  assert.ok(Object.isFrozen(pricing));
  assert.ok(Object.isFrozen(pricing.internal));
  console.log("safariProductValidation: pricing derives its own margin and freezes");

  // THE COST SITS UNDER `internal`, never alongside the sell price. One field
  // to filter when a customer-facing view eventually exists.
  assert.strictEqual(pricing.costPerPersonCents, undefined);
  assert.strictEqual(pricing.marginPerPersonCents, undefined);
  console.log("safariProductValidation: cost and margin are nested under internal");

  console.log("safariProductValidation: all tests passed");
}

main();
