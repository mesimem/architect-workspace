// The starting inventory: twelve Kenya and Tanzania safari packages.
//
// WHY THIS EXISTS. The agency's real inventory is concentrated in Kenya and
// Tanzania, and until now the system knew about ONE sellable trip - the single
// complete record in africa/catalogSource.js. Every downstream feature was
// therefore technically correct and practically useless: trip suggestions
// (STORY-009) could only ever return the same safari, and a quote or a proposal
// had nothing to be built from. This file is the shelf being stocked.
//
// WHY IT GOES THROUGH createSafariProduct RATHER THAN INTO A STORE DIRECTLY.
// Seed data is the most dangerous data in a system, because it arrives before
// anybody is watching and is trusted forever afterwards. Routing it through
// STORY-015's store means every package here is subject to exactly the rules a
// product manager's submission is: the itinerary must cover each day of the
// duration once, the price must clear the cost, and the write is AUDITED. A
// seeded product is indistinguishable from an authored one, which is the point
// - nothing downstream needs a special case for "came from the seed".
//
// AND WHY RE-RUNNING IT IS SAFE. createSafariProduct dedups on (name, country)
// and reports which happened, so a second run creates nothing and the summary
// says so. That is not a nicety: a seed script that doubles the catalog on its
// second run is a seed script somebody runs once, nervously, and then never
// again - which means it stops being the description of the inventory.
//
// WHAT THE DATA IS, HONESTLY. Representative packages written to be realistic -
// plausible routings, durations and margins for the two markets - not the
// agency's actual price list. They exist so the system can be demonstrated and
// tested against an inventory with real SHAPE: twelve packages across two
// countries covering all seven interest tags the suggestion engine knows about,
// from a 3-day culture weekend to a 9-day beach-and-safari combination. Replace
// them with the real catalogue when it arrives; nothing but this file changes.
//
// THE SPREAD IS DELIBERATE, NOT DECORATIVE. An inventory where every package is
// a 7-day wildlife safari would let the suggestion engine pass its tests while
// being unable to discriminate between two customers - everybody matches
// everything. Each of wildlife, trekking, beach, culture, luxury, family and
// adventure is carried by at least one package here, and the seed's test
// asserts that, so the day someone prunes this list the cover is not lost
// silently.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? seedSafariProducts never throws. A package
//     the store refuses is collected into `refused` with its problem list and
//     the rest still land - a single bad row must not leave the shelf empty.
//     The caller decides what a partial seed means; the script in
//     scripts/seedSafariProducts.js treats it as a failure and exits non-zero.
//  2. Will it retry? No. Every refusal here is a validation failure, which is
//     a fault in this file and is fixed by editing it, not by trying again.
//     The whole operation is safe for a human to re-run, which is the better
//     answer than an automatic retry.
//  3. Recovery path? Fix the data and re-run. Because creates dedup on name
//     and country, the already-landed packages replay untouched and only the
//     corrected one is created.
//  4. Handled: a replayed run, a refused package, and a caller with no
//     correlationId (refused - the store will not audit without one). NOT
//     handled: UPDATING a package that has already been seeded and since
//     edited. Re-running never overwrites, deliberately - a product manager's
//     correction must not be silently reverted by a deploy script. Changing a
//     seeded package after the fact is a PATCH, by a person, through the API.

const { createSafariProduct } = require("../services/products/safariProductStore");

// Money in cents, matching the product book. Cost is what we pay the ground
// operator; the difference is the margin the store derives and audits.
const SEED_PRODUCTS = Object.freeze([
  // ----------------------------------------------------------------- KENYA
  {
    name: "Masai Mara Great Migration",
    country: "Kenya",
    summary:
      "Six days of game drives in the Masai Mara timed for the migration river crossings, with the big five in reach from every camp.",
    durationDays: 6,
    itinerary: [
      { day: 1, title: "Arrive Nairobi", location: "Nairobi", detail: "Airport transfer and overnight." },
      { day: 2, title: "Road transfer to the Mara", location: "Masai Mara" },
      { day: 3, title: "Full day game drive", location: "Masai Mara" },
      { day: 4, title: "Mara River crossing points", location: "Mara River" },
      { day: 5, title: "Dawn drive and bush breakfast", location: "Masai Mara" },
      { day: 6, title: "Fly to Nairobi and depart", location: "Nairobi" },
    ],
    pricing: { currency: "USD", perPersonCents: 445000, costPerPersonCents: 330000, singleSupplementCents: 78000 },
  },
  {
    name: "Amboseli and Tsavo Family Safari",
    country: "Kenya",
    summary:
      "A family safari built around shorter drives and early nights, with elephant herds beneath Kilimanjaro and plenty for children to see between them.",
    durationDays: 5,
    itinerary: [
      { day: 1, title: "Nairobi to Amboseli", location: "Amboseli" },
      { day: 2, title: "Elephant herds and Kilimanjaro views", location: "Amboseli" },
      { day: 3, title: "Transfer to Tsavo West", location: "Tsavo West" },
      { day: 4, title: "Mzima Springs and game drive", location: "Tsavo West" },
      { day: 5, title: "Return to Nairobi", location: "Nairobi" },
    ],
    pricing: { currency: "USD", perPersonCents: 295000, costPerPersonCents: 220000, singleSupplementCents: 46000 },
  },
  {
    name: "Samburu and Laikipia Conservancies",
    country: "Kenya",
    summary:
      "A luxury week in the northern conservancies: a private lodge on the Ewaso Nyiro, Samburu's dry-country wildlife, and rhino tracking on foot in Laikipia.",
    durationDays: 7,
    itinerary: [
      { day: 1, title: "Fly Nairobi to Samburu", location: "Samburu" },
      { day: 2, title: "Ewaso Nyiro river drives", location: "Samburu" },
      { day: 3, title: "Special five game drive", location: "Samburu" },
      { day: 4, title: "Transfer to Laikipia", location: "Laikipia" },
      { day: 5, title: "Rhino tracking on foot", location: "Laikipia" },
      { day: 6, title: "Conservancy horseback morning", location: "Laikipia" },
      { day: 7, title: "Fly to Nairobi and depart", location: "Nairobi" },
    ],
    pricing: { currency: "USD", perPersonCents: 620000, costPerPersonCents: 460000, singleSupplementCents: 125000 },
  },
  {
    name: "Diani Beach and Mara Combination",
    country: "Kenya",
    summary:
      "Nine days pairing Masai Mara game drives with the Indian Ocean coast at Diani: reef snorkelling, a dhow afternoon, and nothing to do in particular.",
    durationDays: 9,
    itinerary: [
      { day: 1, title: "Arrive Nairobi", location: "Nairobi" },
      { day: 2, title: "Fly to the Mara", location: "Masai Mara" },
      { day: 3, title: "Full day game drive", location: "Masai Mara" },
      { day: 4, title: "Dawn drive and Mara plains", location: "Masai Mara" },
      { day: 5, title: "Fly to Diani", location: "Diani" },
      { day: 6, title: "Reef snorkelling at Kisite", location: "Kisite" },
      { day: 7, title: "Dhow sail and beach day", location: "Diani" },
      { day: 8, title: "Free day on the coast", location: "Diani" },
      { day: 9, title: "Fly Mombasa to Nairobi and depart", location: "Mombasa" },
    ],
    pricing: { currency: "USD", perPersonCents: 540000, costPerPersonCents: 400000, singleSupplementCents: 96000 },
  },
  {
    name: "Mount Kenya Sirimon Trek",
    country: "Kenya",
    summary:
      "A five-day trek up the Sirimon route to Point Lenana, climbing through moorland and giant lobelia to a summit morning above the cloud.",
    durationDays: 5,
    itinerary: [
      { day: 1, title: "Nanyuki to Old Moses camp", location: "Sirimon" },
      { day: 2, title: "Hike to Shipton's camp", location: "Shipton's" },
      { day: 3, title: "Acclimatisation walk", location: "Shipton's" },
      { day: 4, title: "Summit Point Lenana and descend", location: "Point Lenana" },
      { day: 5, title: "Trail out to Nanyuki", location: "Nanyuki" },
    ],
    pricing: { currency: "USD", perPersonCents: 210000, costPerPersonCents: 150000 },
  },
  {
    name: "Nairobi and Maasai Culture Weekend",
    country: "Kenya",
    summary:
      "A short cultural weekend: the Nairobi national museum, the Maasai market, and two days in a Maasai village in the Rift Valley as a guest rather than a spectator.",
    durationDays: 3,
    itinerary: [
      { day: 1, title: "Nairobi museum and Maasai market", location: "Nairobi" },
      { day: 2, title: "Rift Valley village stay", location: "Narok" },
      { day: 3, title: "Return to Nairobi", location: "Nairobi" },
    ],
    pricing: { currency: "USD", perPersonCents: 115000, costPerPersonCents: 82000 },
  },

  // -------------------------------------------------------------- TANZANIA
  {
    name: "Serengeti Great Migration",
    country: "Tanzania",
    summary:
      "A week following the wildebeest migration across the Serengeti, from the southern calving plains to the Grumeti, with big five game drives throughout.",
    durationDays: 7,
    itinerary: [
      { day: 1, title: "Arrive Kilimanjaro, overnight Arusha", location: "Arusha" },
      { day: 2, title: "Fly to the central Serengeti", location: "Seronera" },
      { day: 3, title: "Seronera valley game drive", location: "Seronera" },
      { day: 4, title: "Follow the herds north", location: "Serengeti" },
      { day: 5, title: "Grumeti river crossings", location: "Grumeti" },
      { day: 6, title: "Full day on the plains", location: "Serengeti" },
      { day: 7, title: "Fly to Arusha and depart", location: "Arusha" },
    ],
    pricing: { currency: "USD", perPersonCents: 510000, costPerPersonCents: 380000, singleSupplementCents: 92000 },
  },
  {
    name: "Ngorongoro Crater and Tarangire",
    country: "Tanzania",
    summary:
      "Five days across the northern circuit: Tarangire's baobabs and elephant, and a full day on the Ngorongoro crater floor where the wildlife does not leave.",
    durationDays: 5,
    itinerary: [
      { day: 1, title: "Arusha to Tarangire", location: "Tarangire" },
      { day: 2, title: "Tarangire game drive", location: "Tarangire" },
      { day: 3, title: "Transfer to the crater rim", location: "Ngorongoro" },
      { day: 4, title: "Full day on the crater floor", location: "Ngorongoro" },
      { day: 5, title: "Return to Arusha", location: "Arusha" },
    ],
    pricing: { currency: "USD", perPersonCents: 360000, costPerPersonCents: 270000, singleSupplementCents: 58000 },
  },
  {
    name: "Kilimanjaro Machame Route",
    country: "Tanzania",
    summary:
      "The eight-day Machame route up Kilimanjaro, with the extra acclimatisation day that makes the difference, and a midnight climb to Uhuru Peak.",
    durationDays: 8,
    itinerary: [
      { day: 1, title: "Machame gate to Machame camp", location: "Machame" },
      { day: 2, title: "Hike to Shira camp", location: "Shira" },
      { day: 3, title: "Lava Tower and Barranco", location: "Barranco" },
      { day: 4, title: "Barranco wall to Karanga", location: "Karanga" },
      { day: 5, title: "Karanga to Barafu", location: "Barafu" },
      { day: 6, title: "Summit Uhuru Peak, descend to Mweka", location: "Uhuru Peak" },
      { day: 7, title: "Trail out to Mweka gate", location: "Mweka" },
      { day: 8, title: "Transfer to Arusha and depart", location: "Arusha" },
    ],
    pricing: { currency: "USD", perPersonCents: 340000, costPerPersonCents: 250000 },
  },
  {
    name: "Zanzibar Beach Escape",
    country: "Tanzania",
    summary:
      "Six days on the Zanzibar coast: a beach hotel on the north shore, reef diving and snorkelling off Mnemba, and a sandbank picnic with nothing scheduled after it.",
    durationDays: 6,
    itinerary: [
      { day: 1, title: "Fly to Zanzibar, transfer north", location: "Nungwi" },
      { day: 2, title: "Beach day", location: "Nungwi" },
      { day: 3, title: "Mnemba atoll diving", location: "Mnemba" },
      { day: 4, title: "Sandbank picnic and snorkelling", location: "Nungwi" },
      { day: 5, title: "Free day on the coast", location: "Nungwi" },
      { day: 6, title: "Transfer to Zanzibar airport", location: "Zanzibar" },
    ],
    pricing: { currency: "USD", perPersonCents: 240000, costPerPersonCents: 170000, singleSupplementCents: 52000 },
  },
  {
    name: "Serengeti Balloon and Luxury Lodge",
    country: "Tanzania",
    summary:
      "An exclusive six days from a private lodge above the Seronera valley, including a dawn balloon flight over the plains and a champagne breakfast on landing.",
    durationDays: 6,
    itinerary: [
      { day: 1, title: "Fly Arusha to the Serengeti", location: "Seronera" },
      { day: 2, title: "Private guided game drive", location: "Seronera" },
      { day: 3, title: "Dawn balloon flight and bush breakfast", location: "Serengeti" },
      { day: 4, title: "Walking safari with a Maasai guide", location: "Serengeti" },
      { day: 5, title: "Full day on the plains", location: "Serengeti" },
      { day: 6, title: "Fly to Arusha and depart", location: "Arusha" },
    ],
    pricing: { currency: "USD", perPersonCents: 890000, costPerPersonCents: 680000, singleSupplementCents: 180000 },
  },
  {
    name: "Stone Town and Spice Culture Tour",
    country: "Tanzania",
    summary:
      "Four days in Stone Town: the heritage quarter on foot, the night market at Forodhani, a spice farm in the interior, and the Prison Island crossing.",
    durationDays: 4,
    itinerary: [
      { day: 1, title: "Arrive Zanzibar, Stone Town walking tour", location: "Stone Town" },
      { day: 2, title: "Spice farm and Forodhani night market", location: "Zanzibar" },
      { day: 3, title: "Prison Island and the old dispensary", location: "Stone Town" },
      { day: 4, title: "Depart Zanzibar", location: "Zanzibar" },
    ],
    pricing: { currency: "USD", perPersonCents: 150000, costPerPersonCents: 105000 },
  },
]);

// Authors every package that is not already there.
//
// `create` is injected so a test can watch the calls without standing up the
// store, and `actor` defaults to a name that reads honestly in the audit trail:
// an auditor seeing this should be able to tell at a glance that a package was
// seeded rather than authored by a person.
//
// Each package gets its OWN correlationId, derived from the run's. The store
// keys an update on the correlation id, and giving twelve creates one shared id
// would make the trail unable to tell them apart.
function seedSafariProducts({
  actor = "system:seed",
  correlationId,
  create = createSafariProduct,
  products = SEED_PRODUCTS,
} = {}) {
  if (typeof correlationId !== "string" || correlationId.trim() === "") {
    // Refused rather than invented. The store will not audit a write without
    // one, and an unaudited seed is a shelf nobody can account for.
    return { ok: false, reason: "missing_correlation_id", created: [], replayed: [], refused: [] };
  }

  const created = [];
  const replayed = [];
  const refused = [];

  products.forEach(function (product, index) {
    const result = create({
      name: product.name,
      country: product.country,
      summary: product.summary,
      durationDays: product.durationDays,
      itinerary: product.itinerary,
      pricing: product.pricing,
      actor: actor,
      correlationId: correlationId + ":" + index,
    });

    if (!result.ok) {
      // Collected, not thrown. One bad package must not leave the shelf empty.
      refused.push({ name: product.name, reason: result.reason, problems: result.problems || [] });
      return;
    }
    (result.replayed ? replayed : created).push(result.product.productId);
  });

  return {
    ok: refused.length === 0,
    reason: refused.length === 0 ? null : "some_products_refused",
    created: created,
    replayed: replayed,
    refused: refused,
  };
}

module.exports = {
  SEED_PRODUCTS,
  seedSafariProducts,
};
