// STORY-009, the scoring half. The corpus is a literal array here - that is the
// point of the engine being pure, and it is what lets these tests state an
// awkward case ("nothing matches") without arranging for one in a store.
//
// The rule these tests hold the engine to: EVERY suggestion can justify itself.
// A trip in the list carries the facts that put it there, a trip missing from
// the list was dropped for a reason a reader can name, and running the same
// request twice produces the identical list in the identical order.

const assert = require("assert");

const {
  suggestTrips,
  validatePreferences,
  hasAnyPreference,
  InvalidPreferencesError,
  RELEVANCE_FLOOR,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require("./suggestionEngine");

// Four trips chosen so that each preference dimension can be tested in
// isolation: same country/different interest, same interest/different country,
// one priced high, one long.
const MARA = Object.freeze({
  tripId: "T-MARA",
  name: "Masai Mara Big Five",
  country: "Kenya",
  durationDays: 6,
  currency: "USD",
  pricePerPersonCents: 310000,
  interests: Object.freeze(["wildlife"]),
  popularityRank: 0,
  source: "product_book",
});
const DIANI = Object.freeze({
  tripId: "T-DIANI",
  name: "Diani Beach Week",
  country: "Kenya",
  durationDays: 7,
  currency: "USD",
  pricePerPersonCents: 190000,
  interests: Object.freeze(["beach"]),
  popularityRank: 0,
  source: "product_book",
});
const SERENGETI = Object.freeze({
  tripId: "T-SERENGETI",
  name: "Serengeti Migration",
  country: "Tanzania",
  durationDays: 8,
  currency: "USD",
  pricePerPersonCents: 980000,
  interests: Object.freeze(["wildlife"]),
  popularityRank: 1,
  source: "product_book",
});
const OKAVANGO = Object.freeze({
  tripId: "T-OKAVANGO",
  name: "Okavango Luxury Delta",
  country: "Botswana",
  durationDays: 14,
  currency: "USD",
  pricePerPersonCents: 1450000,
  interests: Object.freeze(["wildlife", "luxury"]),
  popularityRank: 3,
  source: "product_book",
});
const TRIPS = Object.freeze([MARA, DIANI, SERENGETI, OKAVANGO]);

function ids(result) {
  return result.suggestions.map(function (suggestion) {
    return suggestion.tripId;
  });
}

function main() {
  // --- CRITERION 1: preferences in, relevant trips out -------------------
  const wildlifeInKenya = suggestTrips({
    preferences: { countries: ["Kenya"], interests: ["wildlife"] },
    trips: TRIPS,
  });
  assert.strictEqual(wildlifeInKenya.strategy, "matched");
  // Mara is the only trip that is both, and the only one suggested. Each of
  // the other three is absent for a nameable reason, which is the whole claim
  // this test makes: Diani is in Kenya but is a beach trip and matches none of
  // the stated interests, so it is filtered; Serengeti is wildlife but
  // Tanzanian (0.46, under the floor); Okavango is both wrong country and
  // filtered.
  assert.deepStrictEqual(ids(wildlifeInKenya), ["T-MARA"]);
  assert.strictEqual(wildlifeInKenya.suggestions[0].score, 1);
  assert.deepStrictEqual(wildlifeInKenya.suggestions[0].reasons, [
    "in Kenya, which you asked for",
    "matches your interest in wildlife",
  ]);
  assert.strictEqual(wildlifeInKenya.confidence, 1);
  assert.strictEqual(wildlifeInKenya.confidenceBasis, "preference_match");
  console.log("suggestionEngine: CRITERION 1 - stated preferences rank the matching trip first");

  // Every suggestion justifies itself. An unexplained suggestion is not
  // reviewable, and the advisor reading the audit log is the reviewer.
  wildlifeInKenya.suggestions.forEach(function (suggestion) {
    assert.ok(suggestion.reasons.length > 0, suggestion.tripId + " must say why it is here");
  });

  // Deterministic: same question, same answer, down to the order.
  assert.deepStrictEqual(
    suggestTrips({ preferences: { countries: ["Kenya"], interests: ["wildlife"] }, trips: TRIPS }),
    wildlifeInKenya
  );
  console.log("suggestionEngine: the same request twice produces the identical list");

  // Country matching is case- and whitespace-insensitive: a customer typing
  // "kenya" is the same customer.
  assert.deepStrictEqual(
    ids(suggestTrips({ preferences: { countries: ["  kenya "] }, trips: TRIPS })),
    ["T-DIANI", "T-MARA"]
  );
  console.log("suggestionEngine: a country matches regardless of case or padding");

  // --- CEILINGS EXCLUDE, THEY DO NOT DEDUCT ------------------------------
  //
  // Okavango is wildlife and would score well on interest alone, but at
  // $14,500 against a $4,000 budget it is not a trip this customer can take.
  // It must be absent, not last.
  const onABudget = suggestTrips({
    preferences: { interests: ["wildlife"], maxBudgetPerPersonCents: 400000 },
    trips: TRIPS,
  });
  assert.deepStrictEqual(ids(onABudget), ["T-MARA"]);
  console.log("suggestionEngine: a trip far over budget is excluded, not ranked low");

  // The stretch band: $4,400 is within 15% of a $4,000 budget, so it shows -
  // and says it is over. Half credit, so it can never outrank an in-budget
  // trip that matches equally well.
  const stretched = suggestTrips({
    preferences: { maxBudgetPerPersonCents: 400000 },
    trips: [Object.assign({}, MARA, { tripId: "T-STRETCH", pricePerPersonCents: 440000 })],
  });
  assert.deepStrictEqual(ids(stretched), ["T-STRETCH"]);
  assert.strictEqual(stretched.suggestions[0].score, 0.5);
  assert.deepStrictEqual(stretched.suggestions[0].reasons, [
    "$4,400 per person, a little over your budget",
  ]);
  console.log("suggestionEngine: a near-miss on budget shows at half credit, and says so");

  // Duration behaves the same way. 14 days is far past a 7-day trip, 8 is
  // within the two-day stretch.
  const sevenDays = suggestTrips({ preferences: { maxDurationDays: 7 }, trips: TRIPS });
  assert.deepStrictEqual(ids(sevenDays), ["T-DIANI", "T-MARA", "T-SERENGETI"]);
  assert.strictEqual(sevenDays.suggestions[2].score, 0.5);
  console.log("suggestionEngine: a trip that does not fit the time available is excluded");

  // Partial interest still counts. Two of three asked for, one matched, so
  // Okavango is shown rather than filtered - the zero-overlap rule is a floor
  // on relevance, not a demand that a holiday be exactly one thing.
  const partial = suggestTrips({
    preferences: { countries: ["Botswana"], interests: ["luxury", "beach"] },
    trips: TRIPS,
  });
  assert.deepStrictEqual(ids(partial), ["T-OKAVANGO"]);
  assert.deepStrictEqual(partial.suggestions[0].reasons, [
    "in Botswana, which you asked for",
    "matches your interest in luxury",
  ]);
  console.log("suggestionEngine: matching some of the stated interests is enough");

  // --- THE FAILURE PATH: NOTHING MATCHES ---------------------------------
  //
  // The single most important assertion in this file, and the one that caught
  // a real hole: before stated interests filtered on zero overlap, this
  // request was answered with the Okavango SAFARI, because it took the
  // Botswana credit and cleared the floor on country alone. A customer who
  // wants a beach gets NOTHING, not the nearest safari. Padding here is how
  // "irrelevant suggestions" ships.
  const noMatch = suggestTrips({
    preferences: { countries: ["Botswana"], interests: ["beach"] },
    trips: TRIPS,
  });
  assert.deepStrictEqual(ids(noMatch), []);
  assert.strictEqual(noMatch.strategy, "matched");
  assert.strictEqual(noMatch.confidence, 0);
  console.log("suggestionEngine: FAILURE PATH - nothing relevant returns nothing, not filler");

  // An empty corpus is the other way to get here, and must not throw.
  assert.deepStrictEqual(ids(suggestTrips({ preferences: { countries: ["Kenya"] }, trips: [] })), []);
  console.log("suggestionEngine: FAILURE PATH - an empty corpus returns no suggestions");

  // The floor is a real threshold, asserted against a trip built to sit just
  // under it, so changing RELEVANCE_FLOOR breaks this test rather than
  // silently changing what customers see.
  const justUnder = suggestTrips({
    preferences: { countries: ["Kenya"], interests: ["wildlife", "beach", "luxury"] },
    trips: [Object.assign({}, SERENGETI, { interests: ["wildlife", "beach", "luxury"] })],
  });
  // Tanzania: 0 of 0.35, all three interests: 0.30 of 0.30 -> 0.4615, under 0.5.
  assert.deepStrictEqual(ids(justUnder), []);
  assert.ok(RELEVANCE_FLOOR > 0.4615 && RELEVANCE_FLOOR <= 0.5);
  console.log("suggestionEngine: a trip under the relevance floor is dropped");

  // --- CRITERION 2: no preferences -> popular trips ----------------------
  //
  // All four spellings of "the customer told us nothing" take the same path.
  // `{}` and `{ countries: null }` are the ones a real client sends.
  [undefined, null, {}, { countries: null, interests: null }].forEach(function (preferences) {
    const popular = suggestTrips({ preferences: preferences, trips: TRIPS });
    assert.strictEqual(popular.strategy, "popular");
    assert.strictEqual(popular.confidenceBasis, "none_stated");
    assert.deepStrictEqual(ids(popular), ["T-MARA", "T-DIANI", "T-SERENGETI", "T-OKAVANGO"]);
    assert.deepStrictEqual(popular.suggestions[0].reasons, ["one of our most-booked trips"]);
    assert.strictEqual(hasAnyPreference(preferences), false);
  });
  console.log("suggestionEngine: CRITERION 2 - no preferences suggests the popular trips in order");

  // --- LIMITS -------------------------------------------------------------
  assert.strictEqual(suggestTrips({ preferences: {}, trips: TRIPS, limit: 2 }).suggestions.length, 2);
  // A nonsense limit falls back to the default rather than returning nothing.
  assert.strictEqual(
    suggestTrips({ preferences: {}, trips: TRIPS, limit: 0 }).suggestions.length,
    Math.min(TRIPS.length, DEFAULT_LIMIT)
  );
  assert.ok(MAX_LIMIT >= DEFAULT_LIMIT);
  console.log("suggestionEngine: the limit is honoured, and a nonsense limit fails open");

  // --- MALFORMED INPUT IS A BUG, NOT A BROWSING CUSTOMER ------------------
  //
  // The distinction this asserts: `undefined` preferences is a legitimate
  // request (above), a STRING in that position is a caller bug. If the second
  // quietly took the first's path, a broken client would get confident popular
  // suggestions forever and nobody would find out.
  [
    "kenya",
    42,
    ["Kenya"],
    { countries: [] },
    { countries: ["Kenya"], unknownField: true },
    { interests: ["teleportation"] },
    { maxBudgetPerPersonCents: 0 },
    { maxBudgetPerPersonCents: 1.5 },
    { maxDurationDays: -3 },
    { maxDurationDays: 500 },
  ].forEach(function (bad) {
    assert.ok(validatePreferences(bad).length > 0, JSON.stringify(bad) + " should be refused");
    assert.throws(
      function () {
        suggestTrips({ preferences: bad, trips: TRIPS });
      },
      InvalidPreferencesError,
      JSON.stringify(bad) + " should throw"
    );
  });
  // And the error names a stable error_class, so it logs as something better
  // than "Error" (CLAUDE.md rules that out as a classification).
  try {
    suggestTrips({ preferences: "kenya", trips: TRIPS });
  } catch (error) {
    assert.strictEqual(error.errorClass, "ValidationError");
    // The message describes the shape of the bad value, never echoes it.
    assert.ok(error.message.indexOf("kenya") === -1);
  }
  console.log("suggestionEngine: malformed preferences are refused, not mistaken for 'none'");

  // A missing corpus is the caller's bug too, and must not read as "no trips".
  assert.throws(function () {
    suggestTrips({ preferences: {} });
  }, InvalidPreferencesError);
  console.log("suggestionEngine: a missing corpus throws rather than returning an empty list");

  // Suggestions are frozen, so a caller cannot edit the reasons it was given
  // and then hand them on as ours.
  const held = suggestTrips({ preferences: {}, trips: TRIPS }).suggestions[0];
  assert.ok(Object.isFrozen(held));
  assert.ok(Object.isFrozen(held.reasons));
  console.log("suggestionEngine: a handed-out suggestion cannot be rewritten");

  console.log("suggestionEngine: all tests passed");
}

main();
