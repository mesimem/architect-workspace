// STORY-009, the sourcing half. Nothing here scores anything - these tests only
// hold the corpus to four promises:
//
//   1. The authored product book wins whenever it has anything in it.
//   2. An empty book falls back to the seeded catalog, so a cold start still has
//      trips to suggest. This is the one that stops the story's "no preferences
//      -> popular trips" criterion from passing against an empty list.
//   3. A record that cannot be made whole is SKIPPED, never emitted with holes.
//   4. The order is total and stable, so a caller can assert an exact list.
//
// A skipped record logs a warn line to stderr by design - seeing
// "corpus_record_skipped" for SF-301 while these run is the test working.

const assert = require("assert");

const {
  listTripCorpus,
  listByPopularity,
  deriveInterests,
  CURRENCY,
} = require("./tripCorpus");
const {
  createSafariProduct,
  __resetProductsForTests,
} = require("../products/safariProductStore");

let correlation = 0;

// A minimal valid package. The store validates these, so anything this helper
// produces is a product a product manager could really have authored.
function authorProduct(overrides) {
  correlation += 1;
  const base = {
    name: "Masai Mara Big Five",
    country: "Kenya",
    summary: "Game drives across the Mara in search of the big five.",
    durationDays: 2,
    itinerary: [
      { day: 1, title: "Arrive Nairobi", location: "Nairobi" },
      { day: 2, title: "Mara game drive", location: "Masai Mara" },
    ],
    pricing: { currency: "USD", perPersonCents: 310000, costPerPersonCents: 240000 },
    actor: "PM-1",
    correlationId: "corr-corpus-" + correlation,
  };
  const result = createSafariProduct(Object.assign(base, overrides || {}));
  assert.ok(result.ok, "fixture product should be valid: " + JSON.stringify(result.problems || []));
  return result.product;
}

function main() {
  __resetProductsForTests();

  // --- 2. COLD START: the seeded catalog is the floor ---------------------
  //
  // SF-300 is complete and comes through. SF-301 (name and country only) is
  // not, and is skipped rather than suggested as a trip with no price or
  // duration - criterion 3, on the only half-filled record the repo has.
  const cold = listTripCorpus();
  assert.deepStrictEqual(
    cold.map(function (trip) {
      return trip.tripId;
    }),
    ["SF-300"]
  );
  assert.strictEqual(cold[0].source, "catalog");
  console.log("tripCorpus: an empty product book falls back to the seeded catalog");

  // Dollars converted UP to cents, exactly. $4200 is 420000c and not 419999c:
  // a suggestion that quotes a price the quote engine then disagrees with is a
  // pricing bug, however small.
  assert.strictEqual(cold[0].pricePerPersonCents, 420000);
  assert.strictEqual(cold[0].currency, CURRENCY);
  assert.strictEqual(cold[0].durationDays, 7);
  assert.ok(cold[0].interests.includes("wildlife"));
  console.log("tripCorpus: a seeded record arrives priced in cents and tagged from its own words");

  // Frozen all the way down, so a caller cannot edit the corpus through an
  // entry it was handed - and the next read proves it.
  assert.ok(Object.isFrozen(cold[0]));
  assert.ok(Object.isFrozen(cold[0].interests));
  cold[0].name = "Rewritten";
  assert.strictEqual(listTripCorpus()[0].name, "Serengeti Migration Safari");
  console.log("tripCorpus: a handed-out entry is not a way into the corpus");

  // --- 1. THE AUTHORED BOOK WINS -----------------------------------------
  const mara = authorProduct({});
  const warm = listTripCorpus();
  assert.deepStrictEqual(
    warm.map(function (trip) {
      return trip.tripId;
    }),
    [mara.productId]
  );
  assert.strictEqual(warm[0].source, "product_book");
  // A floor, not a merge: the seeded SF-300 is gone, not sitting alongside it.
  assert.ok(
    !warm.some(function (trip) {
      return trip.tripId === "SF-300";
    })
  );
  console.log("tripCorpus: one authored package replaces the fallback entirely");

  // --- 4. A TOTAL, STABLE ORDER ------------------------------------------
  //
  // Kenya outranks Tanzania editorially, and the two Kenyan packages tie on
  // that rank - so the tie-break on tripId is what makes this list assertable
  // at all. Authored in the opposite order to the one expected back, so a
  // sort that quietly did nothing would fail here.
  const serengeti = authorProduct({
    name: "Serengeti Migration",
    country: "Tanzania",
    summary: "Follow the wildebeest migration.",
  });
  const amboseli = authorProduct({
    name: "Amboseli Elephant Safari",
    country: "Kenya",
    summary: "Elephant herds beneath Kilimanjaro.",
  });

  const kenyan = [mara.productId, amboseli.productId].sort();
  const ordered = listTripCorpus().map(function (trip) {
    return trip.tripId;
  });
  assert.deepStrictEqual(ordered, [kenyan[0], kenyan[1], serengeti.productId]);
  assert.deepStrictEqual(listTripCorpus().map(function (t) { return t.tripId; }), ordered);
  console.log("tripCorpus: popularity orders by country, then by tripId, and repeats itself");

  // "Popular trips" is a view of that same order, never a second one.
  assert.deepStrictEqual(
    listByPopularity(2).map(function (trip) {
      return trip.tripId;
    }),
    [kenyan[0], kenyan[1]]
  );
  // A nonsense limit returns everything rather than nothing: a caller that
  // fumbles the argument should get too many suggestions, not silently none.
  assert.strictEqual(listByPopularity(0).length, 3);
  assert.strictEqual(listByPopularity(-1).length, 3);
  assert.strictEqual(listByPopularity(undefined).length, 3);
  assert.strictEqual(listByPopularity(99).length, 3);
  console.log("tripCorpus: listByPopularity is a window on the same order, and fails open");

  // --- TAGGING IS LITERAL, AND SAYS NO ------------------------------------
  //
  // The important assertion is the empty one. A tagger that matched loosely
  // would put a tag on this and every trip, and a trip tagged with everything
  // matches every preference - the story's "irrelevant suggestions" failure
  // path arriving through the back door.
  assert.deepStrictEqual(deriveInterests("A quiet week with nothing in particular"), []);
  assert.deepStrictEqual(deriveInterests(""), []);
  assert.deepStrictEqual(deriveInterests(null), []);
  assert.deepStrictEqual(deriveInterests("Trekking to the SUMMIT"), ["trekking"]);
  assert.deepStrictEqual(
    deriveInterests("Luxury beach lodge with cultural village visits").sort(),
    ["beach", "culture", "luxury"]
  );
  console.log("tripCorpus: interests are tagged from literal words, and nothing else");

  __resetProductsForTests();
  console.log("tripCorpus: all tests passed");
}

main();
