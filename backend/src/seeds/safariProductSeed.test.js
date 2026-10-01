// The seed, tested against the real validator rather than eyeballed.
//
// THE TEST THAT MATTERS IS THE FIRST ONE. Seed data the product store would
// REFUSE is a landmine: it passes code review (it looks like a safari), it
// passes a test that only checks the seeding function's plumbing, and it fails
// at the only moment anybody cares - on a fresh deploy, half-stocking the
// shelf, with the error in a log nobody is reading. So this suite runs the real
// createSafariProduct over all twelve packages and asserts that zero are
// refused, naming any that are.
//
// The rest hold the seed to the three promises the rest of the system now
// depends on: running it twice does not double the catalog, the suggestion
// corpus picks the packages up ahead of the seeded fallback, and the inventory
// has real SPREAD - all seven interest tags covered, both countries, a range
// of durations and prices.

const assert = require("assert");

const { SEED_PRODUCTS, seedSafariProducts } = require("./safariProductSeed");
const {
  listSafariProducts,
  __resetProductsForTests,
} = require("../services/products/safariProductStore");
const { listTripCorpus, INTERESTS } = require("../services/suggestions/tripCorpus");
const { suggestTrips } = require("../services/suggestions/suggestionEngine");

function main() {
  __resetProductsForTests();

  // --- THE LANDMINE TEST --------------------------------------------------
  const first = seedSafariProducts({ correlationId: "corr-seed-test-1" });
  assert.deepStrictEqual(
    first.refused,
    [],
    "every seeded package must be one the product store would accept"
  );
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.created.length, SEED_PRODUCTS.length);
  assert.strictEqual(listSafariProducts().length, SEED_PRODUCTS.length);
  console.log("safariProductSeed: all " + SEED_PRODUCTS.length + " packages pass the real validator");

  // --- RE-RUNNING IS SAFE -------------------------------------------------
  //
  // Not a nicety. A seed that doubles the catalog on its second run is a seed
  // somebody runs once, nervously, and then never again - at which point it
  // has stopped describing the inventory.
  const second = seedSafariProducts({ correlationId: "corr-seed-test-2" });
  assert.strictEqual(second.created.length, 0);
  assert.strictEqual(second.replayed.length, SEED_PRODUCTS.length);
  assert.strictEqual(listSafariProducts().length, SEED_PRODUCTS.length);
  console.log("safariProductSeed: a second run creates nothing and says so");

  // No correlationId means no audit, and the store will not write unaudited.
  // Refused rather than invented.
  const uncorrelated = seedSafariProducts({ correlationId: "  " });
  assert.strictEqual(uncorrelated.ok, false);
  assert.strictEqual(uncorrelated.reason, "missing_correlation_id");
  assert.strictEqual(uncorrelated.created.length, 0);
  console.log("safariProductSeed: seeding without a correlationId is refused, not guessed");

  // A refused package is COLLECTED, and the rest still land. One bad row must
  // not leave the shelf empty.
  __resetProductsForTests();
  const partial = seedSafariProducts({
    correlationId: "corr-seed-test-3",
    products: [
      SEED_PRODUCTS[0],
      // Priced below cost: the store's own refusal, not one invented here.
      Object.assign({}, SEED_PRODUCTS[1], {
        pricing: { currency: "USD", perPersonCents: 1000, costPerPersonCents: 900000 },
      }),
      SEED_PRODUCTS[2],
    ],
  });
  assert.strictEqual(partial.ok, false);
  assert.strictEqual(partial.created.length, 2, "the good packages still land");
  assert.strictEqual(partial.refused.length, 1);
  assert.ok(partial.refused[0].problems.length > 0, "the caller is told what was wrong");
  console.log("safariProductSeed: one bad package is reported, and does not stop the others");

  // --- THE SHELF THE REST OF THE SYSTEM NOW SEES --------------------------
  __resetProductsForTests();
  seedSafariProducts({ correlationId: "corr-seed-test-4" });

  const corpus = listTripCorpus();
  assert.strictEqual(corpus.length, SEED_PRODUCTS.length);
  // The authored book has replaced the seeded catalog fallback entirely - the
  // stub destination SF-300 is no longer what customers are offered.
  assert.ok(corpus.every(function (trip) { return trip.source === "product_book"; }));
  assert.ok(!corpus.some(function (trip) { return trip.tripId === "SF-300"; }));
  console.log("safariProductSeed: the suggestion corpus is now the authored book, not the fallback");

  // Kenya ahead of Tanzania, which is the editorial order in tripCorpus.js and
  // matches where the inventory actually is.
  const countries = corpus.map(function (trip) { return trip.country; });
  const lastKenya = countries.lastIndexOf("Kenya");
  const firstTanzania = countries.indexOf("Tanzania");
  assert.ok(lastKenya < firstTanzania, "every Kenyan package ranks ahead of every Tanzanian one");
  assert.strictEqual(countries.filter(function (c) { return c === "Kenya"; }).length, 6);
  assert.strictEqual(countries.filter(function (c) { return c === "Tanzania"; }).length, 6);
  console.log("safariProductSeed: six packages per country, Kenya ranked first");

  // --- SPREAD, SO THE ENGINE CAN ACTUALLY DISCRIMINATE --------------------
  //
  // An inventory where every package is a 7-day wildlife safari would let the
  // suggestion engine pass every test while being unable to tell two customers
  // apart. This asserts the cover rather than trusting the list to keep it.
  const covered = new Set();
  corpus.forEach(function (trip) {
    trip.interests.forEach(function (interest) { covered.add(interest); });
  });
  INTERESTS.forEach(function (interest) {
    assert.ok(covered.has(interest), "no seeded package carries the " + interest + " tag");
  });
  console.log("safariProductSeed: all " + INTERESTS.length + " interest tags are covered by the inventory");

  // And the engine really does discriminate against it. Three customers, three
  // different answers, each one explicable - which is the whole reason the
  // shelf was stocked.
  const beachInKenya = suggestTrips({
    preferences: { countries: ["Kenya"], interests: ["beach"] },
    trips: corpus,
  });
  assert.deepStrictEqual(
    beachInKenya.suggestions.map(function (s) { return s.name; }),
    ["Diani Beach and Mara Combination"]
  );

  const climbing = suggestTrips({ preferences: { interests: ["trekking"] }, trips: corpus });
  assert.deepStrictEqual(
    climbing.suggestions.map(function (s) { return s.name; }).sort(),
    ["Kilimanjaro Machame Route", "Mount Kenya Sirimon Trek"]
  );

  // A real budget bites: the two luxury packages are excluded, not ranked low.
  const onABudget = suggestTrips({
    preferences: { interests: ["wildlife"], maxBudgetPerPersonCents: 400000 },
    trips: corpus,
  });
  assert.ok(onABudget.suggestions.length > 0);
  assert.ok(
    onABudget.suggestions.every(function (s) { return s.pricePerPersonCents <= 460000; }),
    "nothing far over the stated budget is suggested"
  );
  assert.ok(
    !onABudget.suggestions.some(function (s) { return s.name.indexOf("Balloon") !== -1; }),
    "the $8,900 lodge is not offered to a $4,000 budget"
  );
  console.log("safariProductSeed: three different customers get three different, explicable answers");

  __resetProductsForTests();
  console.log("safariProductSeed: all tests passed");
}

main();
