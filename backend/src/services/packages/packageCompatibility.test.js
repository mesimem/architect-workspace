// STORY-017, the pure half. The story's first named failure path -
// "incompatible products are combined into a package" - lives here, and it is
// the one that looks completely normal on screen: two real safaris, both
// correctly priced, both sellable on their own, that no customer could
// physically take together.
//
// The other two failure paths are tested where they live: "package creation
// fails due to system error" in packageStore.test.js (the audit-write rollback),
// and "unauthorized access to package creation" in http/packages.test.js, which
// is a property of the HTTP boundary.
//
// EVERY EXPECTED FIGURE IS WRITTEN OUT BY HAND rather than recomputed from the
// implementation's own arithmetic. A test that restates the code cannot catch
// the code being wrong - so the day spans below say "days 1-6" because a 6-day
// product starting on day 1 ends on day 6, not because endDay is computed the
// same way twice.

const assert = require("assert");

const {
  validatePackage,
  normaliseComponents,
  COMPONENT_KINDS,
  MIN_COMPONENTS,
  MAX_COMPONENTS,
  MAX_PACKAGE_DAYS,
} = require("./packageCompatibility");

// A FAKE product book, not the real store. The whole reason resolveProduct is
// injected: these rules are tested without seeding a catalog, and - crucially -
// with products the real catalog cannot currently hold. BOOK.lisbon is priced
// in EUR, which safariProductValidation.js would refuse at authoring time, and
// that is exactly why the currency rule needs a fake book to be provable at
// all. See the note on currencyProblems.
const BOOK = Object.freeze({
  safari_mara: {
    productId: "safari_mara",
    name: "Masai Mara Classic",
    country: "Kenya",
    durationDays: 6,
    pricing: { currency: "USD", perPersonCents: 445000 },
  },
  safari_amboseli: {
    productId: "safari_amboseli",
    name: "Amboseli Under Kilimanjaro",
    country: "Kenya",
    durationDays: 5,
    pricing: { currency: "USD", perPersonCents: 295000 },
  },
  safari_serengeti: {
    productId: "safari_serengeti",
    name: "Serengeti Migration",
    country: "Tanzania",
    durationDays: 5,
    pricing: { currency: "USD", perPersonCents: 520000 },
  },
  safari_lisbon: {
    productId: "safari_lisbon",
    name: "A product priced off-currency",
    country: "Portugal",
    durationDays: 3,
    pricing: { currency: "EUR", perPersonCents: 100000 },
  },
  safari_broken: {
    productId: "safari_broken",
    name: "A product with no usable duration",
    country: "Kenya",
    durationDays: null,
    pricing: { currency: "USD", perPersonCents: 100000 },
  },
  safari_priceless: {
    productId: "safari_priceless",
    name: "A product with no currency",
    country: "Kenya",
    durationDays: 2,
    pricing: {},
  },
  safari_long: {
    productId: "safari_long",
    name: "A 60-day expedition",
    country: "Kenya",
    durationDays: 60,
    pricing: { currency: "USD", perPersonCents: 100000 },
  },
});

function resolve(productId) {
  return Object.prototype.hasOwnProperty.call(BOOK, productId) ? BOOK[productId] : null;
}

function component(productId, startDay) {
  return { kind: "safari", productId: productId, startDay: startDay };
}

function packageOf(components) {
  return {
    name: "Kenya and Tanzania Grand Circuit",
    summary: "Two classic safaris combined into one journey.",
    components: components,
  };
}

// True when SOME problem contains the fragment. Substring rather than exact
// match: the messages carry indexes and day numbers, and a test that pinned the
// whole string would fail on a comma.
function mentions(problems, fragment) {
  return problems.some(function (problem) {
    return problem.includes(fragment);
  });
}

function main() {
  // ---------------------------------------------------------------- happy path

  // THE ACCEPTANCE CRITERION, in its pure form. Two Kenyan safaris, the first
  // on days 1-6, the second starting on day 8 - a one-day gap, which is legal.
  assert.deepStrictEqual(
    validatePackage(packageOf([component("safari_mara", 1), component("safari_amboseli", 8)]), resolve),
    []
  );
  console.log("packageCompatibility: two compatible products combine cleanly");

  // A GAP IS NOT A FAULT, however large. Days 1-6, then nothing until day 30.
  // Three weeks at leisure between two safaris is a real itinerary, and the
  // header says so explicitly - this test is what stops someone "tightening"
  // the rule later.
  assert.deepStrictEqual(
    validatePackage(packageOf([component("safari_mara", 1), component("safari_amboseli", 30)]), resolve),
    []
  );
  console.log("packageCompatibility: a gap between components is allowed");

  // SUBMISSION ORDER DOES NOT MATTER. The same two products, listed later-first.
  assert.deepStrictEqual(
    validatePackage(packageOf([component("safari_amboseli", 8), component("safari_mara", 1)]), resolve),
    []
  );
  console.log("packageCompatibility: components may be submitted in any order");

  // CROSS-COUNTRY WITH A TRAVEL DAY. Kenya days 1-6, Tanzania from day 8: day 7
  // is the flight. This is the fix for the refusal two tests below, so it has
  // to pass or the error message would be telling advisors to do something that
  // does not work.
  assert.deepStrictEqual(
    validatePackage(packageOf([component("safari_mara", 1), component("safari_serengeti", 8)]), resolve),
    []
  );
  console.log("packageCompatibility: cross-country components with a travel day are fine");

  // ----------------------------------------------- the four incompatibilities

  // RULE 3 - OVERLAP. Mara runs days 1-6; Amboseli starting on day 5 collides
  // on days 5 and 6. A customer cannot be in two places at once.
  const overlapping = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_amboseli", 5)]),
    resolve
  );
  assert.strictEqual(overlapping.length, 1);
  assert.ok(mentions(overlapping, "overlap"));
  assert.ok(mentions(overlapping, "days 1-6"));
  assert.ok(mentions(overlapping, "days 5-9"));
  console.log("packageCompatibility: overlapping day spans are refused");

  // The boundary either side of it. Starting on day 6 is the LAST day that
  // collides; starting on day 7 is the first that does not. Off-by-one here
  // would either refuse legal back-to-back packages or allow a double-booked
  // day, and both are silent in production.
  assert.strictEqual(
    validatePackage(packageOf([component("safari_mara", 1), component("safari_amboseli", 6)]), resolve).length,
    1
  );
  assert.deepStrictEqual(
    validatePackage(packageOf([component("safari_mara", 1), component("safari_amboseli", 7)]), resolve),
    []
  );
  console.log("packageCompatibility: the overlap boundary is day end, inclusive");

  // Three products stacked on the same day produce THREE pair problems, not
  // one. An advisor reading the list has three rows to fix, and reporting only
  // the first would have them resubmit twice more.
  const stacked = validatePackage(
    packageOf([
      component("safari_mara", 1),
      component("safari_amboseli", 1),
      component("safari_serengeti", 1),
    ]),
    resolve
  );
  assert.strictEqual(
    stacked.filter(function (problem) {
      return problem.includes("overlap");
    }).length,
    3
  );
  console.log("packageCompatibility: every overlapping pair is reported");

  // RULE 4 - CROSS-COUNTRY WITH NO GAP. Kenya ends day 6, Tanzania starts day
  // 7. Both products are perfectly good; the combination is not flyable.
  const noTravelDay = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_serengeti", 7)]),
    resolve
  );
  assert.strictEqual(noTravelDay.length, 1);
  assert.ok(mentions(noTravelDay, "cross-country components need a travel day between them"));
  assert.ok(mentions(noTravelDay, "ends in Kenya on day 6"));
  assert.ok(mentions(noTravelDay, "starts in Tanzania on day 7"));
  console.log("packageCompatibility: adjacent cross-country components are refused");

  // Same country, no gap: legal. Two Kenyan safaris back to back is a normal
  // sale, and refusing it would make the rule about adjacency rather than
  // about borders.
  assert.deepStrictEqual(
    validatePackage(packageOf([component("safari_mara", 1), component("safari_amboseli", 7)]), resolve),
    []
  );
  console.log("packageCompatibility: same-country components may be back to back");

  // An OVERLAP across a border reports the overlap only. Reporting it as a
  // country fault as well would send the advisor to add a travel day, which
  // would not fix an overlap.
  const overlapAcrossBorder = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_serengeti", 4)]),
    resolve
  );
  assert.strictEqual(overlapAcrossBorder.length, 1);
  assert.ok(mentions(overlapAcrossBorder, "overlap"));
  assert.ok(!mentions(overlapAcrossBorder, "travel day"));
  console.log("packageCompatibility: an overlap is not also reported as a country fault");

  // RULE 2 - THE SAME PRODUCT TWICE. Placed far enough apart that nothing
  // overlaps, so the duplicate is the only thing wrong.
  const duplicated = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_mara", 20)]),
    resolve
  );
  assert.strictEqual(duplicated.length, 1);
  assert.ok(mentions(duplicated, "the same product is listed more than once"));
  assert.ok(mentions(duplicated, "components 0, 1"));
  console.log("packageCompatibility: the same product twice is refused");

  // RULE 1 - CURRENCY MISMATCH. USD and EUR. This is the rule that cannot fire
  // against the real catalog today and is tested anyway - see the note on
  // currencyProblems for why it is written against the components rather than
  // against CURRENCIES.
  const mixedCurrency = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_lisbon", 20)]),
    resolve
  );
  assert.ok(mentions(mixedCurrency, "priced in more than one currency (EUR, USD)"));
  console.log("packageCompatibility: components in different currencies are refused");

  // A product with no currency at all is named by index, rather than being
  // silently treated as matching whatever the others use.
  const noCurrency = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_priceless", 20)]),
    resolve
  );
  assert.ok(mentions(noCurrency, "components[1]: the referenced product has no usable currency"));
  console.log("packageCompatibility: a product with no currency is refused by index");

  // ------------------------------------------------------------- the envelope

  // AN UNKNOWN PRODUCT ID IS NOT ECHOED BACK. It came from the request, the
  // message goes into an HTTP response, and the index already says which row to
  // fix.
  const unknown = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_nope", 20)]),
    resolve
  );
  assert.strictEqual(unknown.length, 1);
  assert.ok(mentions(unknown, "components[1]: no safari product exists with that productId"));
  assert.ok(!mentions(unknown, "safari_nope"));
  console.log("packageCompatibility: an unknown productId is reported by index, not echoed");

  // A product whose own stored duration is broken cannot be placed on a
  // calendar. OUR data being wrong, reported as such, and dropped from the span
  // checks rather than compared as a NaN.
  const brokenDuration = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_broken", 20)]),
    resolve
  );
  assert.strictEqual(brokenDuration.length, 1);
  assert.ok(mentions(brokenDuration, "no usable duration and cannot be scheduled"));
  console.log("packageCompatibility: a product with an unusable duration is refused");

  // A PACKAGE OF ONE is not a package - it is a product, and the product book
  // already holds it.
  const single = validatePackage(packageOf([component("safari_mara", 1)]), resolve);
  assert.ok(mentions(single, "a package must combine at least " + MIN_COMPONENTS + " products"));
  console.log("packageCompatibility: a package of one component is refused");

  // Too many. Note this returns EARLY, so the pairwise rules never run on a
  // list that is refused on size.
  const tooMany = validatePackage(
    packageOf(
      Array.from({ length: MAX_COMPONENTS + 1 }, function (ignored, index) {
        return component("safari_mara", index + 1);
      })
    ),
    resolve
  );
  assert.strictEqual(tooMany.length, 1);
  assert.ok(mentions(tooMany, "a package may combine at most " + MAX_COMPONENTS + " products"));
  console.log("packageCompatibility: an oversized package is refused on size alone");

  // The package cannot run off the end of the calendar its startDays are bound
  // by. A 60-day product starting on day 100 ends on day 159.
  const tooLong = validatePackage(
    packageOf([component("safari_mara", 1), component("safari_long", 100)]),
    resolve
  );
  assert.ok(mentions(tooLong, "the package runs past day " + MAX_PACKAGE_DAYS));
  console.log("packageCompatibility: a package running off the calendar is refused");

  // An unknown kind is refused BY NAME rather than ignored. "safaris" is the
  // typo this catches, and the alternative - dropping the component - would
  // save a package the advisor believes has three products and that has two.
  const badKind = validatePackage(
    packageOf([component("safari_mara", 1), { kind: "safaris", productId: "safari_amboseli", startDay: 20 }]),
    resolve
  );
  assert.ok(mentions(badKind, "kind must be one of " + COMPONENT_KINDS.join(", ")));
  console.log("packageCompatibility: an unknown component kind is refused");

  // An unknown FIELD is reported by name too, for the same reason: a "start_day"
  // typo would otherwise be a silently missing startDay.
  const unknownField = validatePackage(
    packageOf([
      component("safari_mara", 1),
      { kind: "safari", productId: "safari_amboseli", startDay: 20, start_day: 20 },
    ]),
    resolve
  );
  assert.ok(mentions(unknownField, "components[1]: unknown fields: start_day"));
  console.log("packageCompatibility: an unknown component field is refused by name");

  // startDay faults: missing, zero, fractional, and past the ceiling.
  [undefined, 0, -1, 2.5, MAX_PACKAGE_DAYS + 1, "1"].forEach(function (startDay) {
    const problems = validatePackage(
      packageOf([component("safari_mara", 1), { kind: "safari", productId: "safari_amboseli", startDay: startDay }]),
      resolve
    );
    assert.ok(mentions(problems, "startDay must be a whole number from 1 to " + MAX_PACKAGE_DAYS));
  });
  console.log("packageCompatibility: every unusable startDay is refused");

  // A component that is not an object at all, and a prototype-chain key as a
  // productId. Neither should reach the product lookup.
  assert.ok(
    mentions(validatePackage(packageOf([component("safari_mara", 1), null]), resolve), "components[1]: must be an object")
  );
  assert.ok(
    mentions(
      validatePackage(packageOf([component("safari_mara", 1), component("constructor", 20)]), resolve),
      "no safari product exists with that productId"
    )
  );
  console.log("packageCompatibility: non-object components and prototype keys are refused");

  // The package envelope itself.
  assert.ok(mentions(validatePackage(null, resolve), "package must be an object"));
  assert.ok(mentions(validatePackage([], resolve), "package must be an object"));
  assert.ok(
    mentions(
      validatePackage({ name: "", summary: "", components: "two" }, resolve),
      "components must be an array"
    )
  );
  assert.ok(mentions(validatePackage({ summary: "s", components: [] }, resolve), "name must be a non-empty string"));
  assert.ok(mentions(validatePackage({ name: "n", components: [] }, resolve), "summary must be a non-empty string"));
  console.log("packageCompatibility: the package envelope is validated");

  // A missing resolver is a programming error at the call site, and it is
  // reported rather than thrown - this function's one contract is that it
  // returns a list.
  assert.ok(mentions(validatePackage(packageOf([]), undefined), "no product resolver was supplied"));
  console.log("packageCompatibility: a missing resolver is reported, not thrown");

  // EVERY PROBLEM AT ONCE, not the first. A package with a bad name AND a
  // duplicate AND an overlap reports all three, so a form is corrected in one
  // pass.
  const multiple = validatePackage(
    {
      name: "   ",
      summary: "Two classic safaris combined into one journey.",
      components: [component("safari_mara", 1), component("safari_mara", 3)],
    },
    resolve
  );
  assert.ok(mentions(multiple, "name must be a non-empty string"));
  assert.ok(mentions(multiple, "the same product is listed more than once"));
  assert.ok(mentions(multiple, "overlap"));
  console.log("packageCompatibility: every problem is reported, not just the first");

  // ----------------------------------------------------------- normalisation

  // SORTED BY START DAY, so the same package submitted in a different order is
  // the same stored package - which is what makes the store's "did anything
  // actually change?" comparison honest.
  const normalised = normaliseComponents([
    { kind: "safari", productId: "  safari_amboseli  ", startDay: 8 },
    { kind: "safari", productId: "safari_mara", startDay: 1 },
  ]);
  assert.deepStrictEqual(
    normalised.map(function (entry) {
      return entry.productId;
    }),
    ["safari_mara", "safari_amboseli"]
  );
  assert.strictEqual(normalised[1].productId, "safari_amboseli");
  console.log("packageCompatibility: components normalise sorted by start day, trimmed");

  // FROZEN, top level and per component. A caller handed a package cannot edit
  // the book through it.
  assert.ok(Object.isFrozen(normalised));
  assert.ok(Object.isFrozen(normalised[0]));
  console.log("packageCompatibility: normalised components are frozen");

  console.log("packageCompatibility: all tests passed");
}

main();
