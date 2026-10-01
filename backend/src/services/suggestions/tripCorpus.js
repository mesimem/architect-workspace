// STORY-009: the pool of trips a suggestion may be drawn from, and the order
// they fall in when nobody has told us what they want.
//
// WHY THIS IS A SEPARATE MODULE FROM THE SCORER. The scorer (suggestionEngine.js)
// is a pure function over a list. If it also knew where the list came from it
// would own two decisions - "what is suggestable" and "what is a good match" -
// and the second could never be tested without standing up the first. Splitting
// them means the engine's tests hand it a literal array, and this module's tests
// check sourcing without scoring anything.
//
// WHY IT READS TWO STORES. The authored product book (STORY-015) is the real
// inventory and wins whenever it has anything in it. But it starts EMPTY in a
// fresh process, and a suggestion service that returns [] on a cold start would
// pass the story's "no preferences -> popular trips" criterion against an empty
// list - proving nothing while looking green. So an empty book falls back to the
// seeded destinations in africa/catalogSource.js, which is the same set a
// customer can already browse. The fallback is a floor, not a merge: mixing the
// two would show the same destination twice under two ids the moment a product
// manager authors a package for a seeded country.
//
// WHERE popularityRank COMES FROM, STATED PLAINLY BECAUSE IT MATTERS. This repo
// has no popularity signal. There is no view counter, no rating, and the booking
// ledger is per-process and empty on a cold start - deriving a rank from it would
// read as data while being zero for every trip. So the rank here is EDITORIAL:
// an explicit, ordered list of countries by demand, written down where anyone can
// argue with it, tie-broken by tripId so the ordering is total and stable and a
// test can assert an exact list. It is a placeholder with an honest name, and the
// one thing it is not is a measurement. When a real signal exists (a booking
// ledger worth reading, post-STORY-011), replace rankFor() and nothing else.
//
// MONEY IS IN CENTS. The product book stores cents, the seeded catalog stores
// whole dollars, and this module converts the catalog UP rather than the book
// DOWN. Rounding a product's price to dollars here would make a suggestion quote
// a price the quote engine then disagrees with by up to 99c - the exact class of
// pricing bug safariProductStore.js's header warns about.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It does not throw. A record it cannot turn
//     into a complete suggestion is SKIPPED, not emitted with holes in it: a
//     suggestion naming a trip with `undefined` nights and no price is worse
//     than one trip fewer. Skips are logged (see logSkipped) so a product that
//     silently never gets suggested is discoverable rather than a mystery.
//  2. Will it retry? Nothing to retry. Both sources are in-process reads with
//     no I/O of their own; the retry envelope in this story wraps the engine
//     call in tripSuggestionService.js, which is where the pluggable part is.
//  3. Recovery if both sources are empty? Returns []. That is a legitimate
//     state (a brand-new deployment), and the service above is responsible for
//     turning "no trips exist" into the story's "no suggestions generated"
//     failure path - an advisor flag, not an empty 200.
//  4. Handled here: an empty product book, products with an unusable price, a
//     seeded record missing its required fields, unranked countries, and ties.
//     NOT handled: paging (the corpus is small by construction), per-date or
//     seasonal availability (no date model exists yet), currency other than
//     USD (see CURRENCY below), and personalised popularity.

const { listSafariProducts } = require("../products/safariProductStore");
const { SAFARI_CATALOG, isCompleteRecord } = require("../africa/catalogSource");

// One currency, matching the product book's own CURRENCIES list. A product in
// anything else is skipped rather than suggested at a number we would have to
// convert, because there is no rate source in this repo to convert it with.
const CURRENCY = "USD";

// The editorial demand order - see the header. Earlier is more popular.
// Anything not named here ranks after everything named here, in tripId order,
// so adding a country to the product book never silently promotes it.
const POPULAR_COUNTRIES = Object.freeze([
  "Kenya",
  "Tanzania",
  "South Africa",
  "Botswana",
  "Rwanda",
  "Namibia",
  "Uganda",
  "Zambia",
  "Zimbabwe",
  "Morocco",
  "Egypt",
]);

const UNRANKED = POPULAR_COUNTRIES.length;

// The interest vocabulary. A trip is tagged by matching these words against its
// own text, which is the only description of it we have.
//
// IT IS DELIBERATELY SMALL AND LITERAL. A broad or fuzzy tagger would attach
// every tag to every trip, and a trip tagged with everything matches every
// preference - which is precisely the story's "irrelevant suggestions" failure
// path, arriving through the back door. Missing a tag costs a trip one point in
// the ranking. Inventing one costs a customer a suggestion that has nothing to
// do with what they asked for, so the bias is towards tagging nothing.
const INTEREST_KEYWORDS = Object.freeze({
  wildlife: ["safari", "wildlife", "game drive", "big five", "migration", "gorilla", "chimp"],
  // A PLACE NAME IS NOT AN ACTIVITY, and "kilimanjaro" used to be in this list
  // until the real inventory was seeded and caught it: a family game-drive
  // package was tagged `trekking` because its summary mentions elephant herds
  // BENEATH Kilimanjaro. Half the lodges in northern Tanzania advertise the
  // view. Every genuine climb here says trek, climb or summit, so the verbs are
  // the signal and the mountain is not - which is the general rule for this
  // list, not a one-off exception.
  trekking: ["trek", "hike", "hiking", "climb", "summit", "trail"],
  beach: ["beach", "coast", "island", "zanzibar", "diving", "snorkel", "reef"],
  culture: ["culture", "cultural", "village", "market", "heritage", "maasai", "museum"],
  luxury: ["luxury", "luxe", "private lodge", "exclusive", "boutique"],
  family: ["family", "families", "children", "kid-friendly", "child-friendly"],
  adventure: ["adventure", "rafting", "kayak", "balloon", "dune", "desert", "quad"],
});

const INTERESTS = Object.freeze(Object.keys(INTEREST_KEYWORDS));

// Structured JSON to stderr, per CLAUDE.md's observability rules. Ids only - a
// skipped record's contents are not ours to log.
function logSkipped(source, tripId, reason) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      service: "trip-corpus",
      event: "corpus_record_skipped",
      outcome: "partial",
      context: { source: source, tripId: tripId, reason: reason },
    })
  );
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// A price we are willing to put in front of a customer: a whole number of
// cents, above zero. Zero is excluded on purpose - a free safari is a data
// error, not a bargain.
function isUsablePriceCents(value) {
  return Number.isInteger(value) && value > 0;
}

function isUsableDuration(value) {
  return Number.isInteger(value) && value > 0;
}

// Which interests a trip's own words support. Lower-cased substring matching:
// crude, and deliberately so - see INTEREST_KEYWORDS.
function deriveInterests(text) {
  const haystack = String(text || "").toLowerCase();
  return INTERESTS.filter(function (interest) {
    return INTEREST_KEYWORDS[interest].some(function (keyword) {
      return haystack.indexOf(keyword) !== -1;
    });
  });
}

function rankFor(country) {
  const index = POPULAR_COUNTRIES.indexOf(country);
  return index === -1 ? UNRANKED : index;
}

function freezeEntry(entry) {
  Object.freeze(entry.interests);
  return Object.freeze(entry);
}

// The one shape everything downstream sees, whichever store it came from.
// `source` rides along because an advisor reviewing a logged suggestion needs to
// know whether they are looking at an authored package or a seeded placeholder.
function buildEntry({ tripId, name, country, summary, durationDays, pricePerPersonCents, source }) {
  return freezeEntry({
    tripId: tripId,
    name: name,
    country: country,
    summary: summary,
    durationDays: durationDays,
    currency: CURRENCY,
    pricePerPersonCents: pricePerPersonCents,
    interests: deriveInterests(name + " " + summary),
    popularityRank: rankFor(country),
    source: source,
  });
}

// Authored packages. The store has already validated these, so most of the
// guarding below is belt-and-braces - except the currency check, which is a real
// filter: the store permits a currency list and this module handles one of them.
function fromProductBook() {
  const entries = [];
  listSafariProducts().forEach(function (product) {
    const pricing = product.pricing || {};
    if (pricing.currency !== CURRENCY) {
      logSkipped("product_book", product.productId, "unsupported_currency");
      return;
    }
    if (!isUsablePriceCents(pricing.perPersonCents)) {
      logSkipped("product_book", product.productId, "unusable_price");
      return;
    }
    if (!isUsableDuration(product.durationDays)) {
      logSkipped("product_book", product.productId, "unusable_duration");
      return;
    }
    if (!isNonBlankString(product.country) || !isNonBlankString(product.name)) {
      logSkipped("product_book", product.productId, "incomplete_record");
      return;
    }
    entries.push(
      buildEntry({
        tripId: product.productId,
        name: product.name,
        country: product.country,
        summary: isNonBlankString(product.summary) ? product.summary : "",
        durationDays: product.durationDays,
        pricePerPersonCents: pricing.perPersonCents,
        source: "product_book",
      })
    );
  });
  return entries;
}

// The seeded destinations, used only when the book is empty. isCompleteRecord is
// the catalog's own notion of "has everything a customer needs", reused rather
// than reimplemented so the two cannot drift - it is what makes the half-filled
// fixture (SF-301, name and country only) fall out here instead of being
// suggested as a trip with no price.
function fromSeededCatalog() {
  const entries = [];
  Object.keys(SAFARI_CATALOG).forEach(function (destinationId) {
    const record = SAFARI_CATALOG[destinationId];
    if (!isCompleteRecord(record)) {
      logSkipped("catalog", destinationId, "incomplete_record");
      return;
    }
    if (!Number.isFinite(record.priceUSD) || record.priceUSD <= 0) {
      logSkipped("catalog", destinationId, "unusable_price");
      return;
    }
    entries.push(
      buildEntry({
        tripId: record.destinationId,
        name: record.name,
        country: record.country,
        summary: record.description,
        durationDays: record.durationDays,
        // Dollars up to cents, never cents down to dollars - see the header.
        pricePerPersonCents: Math.round(record.priceUSD * 100),
        source: "catalog",
      })
    );
  });
  return entries;
}

// Popularity order: country rank first, then tripId. The tie-break is not
// decoration - without it two Kenyan trips come back in whatever order their
// store happened to iterate, and the "no preferences" criterion could only be
// asserted as a set, which would let a genuine ordering regression through.
function byPopularity(left, right) {
  if (left.popularityRank !== right.popularityRank) {
    return left.popularityRank - right.popularityRank;
  }
  return left.tripId < right.tripId ? -1 : left.tripId > right.tripId ? 1 : 0;
}

// Every suggestable trip, in popularity order. Callers get frozen entries, so
// there is nothing to copy and no way to edit the corpus through what they hold.
function listTripCorpus() {
  const authored = fromProductBook();
  const entries = authored.length > 0 ? authored : fromSeededCatalog();
  return entries.sort(byPopularity);
}

// The front of that same order. This is what "popular trips" means in the
// story's second criterion, and it is a view of listTripCorpus() rather than a
// second ordering, so the two can never disagree.
function listByPopularity(limit) {
  const all = listTripCorpus();
  if (!Number.isInteger(limit) || limit <= 0) {
    return all;
  }
  return all.slice(0, limit);
}

module.exports = {
  listTripCorpus,
  listByPopularity,
  deriveInterests,
  INTERESTS,
  INTEREST_KEYWORDS,
  POPULAR_COUNTRIES,
  CURRENCY,
};
