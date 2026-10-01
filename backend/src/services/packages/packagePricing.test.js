// STORY-017, the arithmetic. Every expected figure below is WRITTEN OUT BY
// HAND, not recomputed from the implementation's own formula. A test that says
// `assert.strictEqual(total, a + b)` passes whether or not the code is right;
// a test that says `assert.strictEqual(total, 740000)` does not.
//
// The money faults here are the ones that look completely normal on screen: two
// profitable safaris and a 40% discount is three plausible numbers that
// together sell a trip at a loss, and nothing in the UI says so.

const assert = require("assert");

const { derivePackagePricing, MAX_PACKAGE_DISCOUNT_BASIS_POINTS } = require("./packagePricing");

// A fake product book in the shape normalisePricing produces: cost and margin
// nested under `internal`, never alongside the sell price.
//
// mara:     sells $4,450, costs $3,300, $780 single supplement
// amboseli: sells $2,950, costs $2,200, $460 single supplement
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
  // No supplement at all: a product may legitimately not charge one, and
  // absent must mean nothing extra rather than a refusal.
  safari_nosupplement: {
    productId: "safari_nosupplement",
    country: "Kenya",
    durationDays: 3,
    pricing: {
      currency: "USD",
      perPersonCents: 210000,
      internal: { costPerPersonCents: 150000, marginPerPersonCents: 60000 },
    },
  },
  safari_offcurrency: {
    productId: "safari_offcurrency",
    country: "Portugal",
    durationDays: 3,
    pricing: {
      currency: "EUR",
      perPersonCents: 100000,
      internal: { costPerPersonCents: 50000 },
    },
  },
  safari_nocost: {
    productId: "safari_nocost",
    country: "Kenya",
    durationDays: 3,
    pricing: { currency: "USD", perPersonCents: 100000, internal: {} },
  },
  safari_nopricing: {
    productId: "safari_nopricing",
    country: "Kenya",
    durationDays: 3,
  },
});

function resolve(productId) {
  return Object.prototype.hasOwnProperty.call(BOOK, productId) ? BOOK[productId] : null;
}

function component(productId) {
  return { kind: "safari", productId: productId, startDay: 1 };
}

function mentions(problems, fragment) {
  return problems.some(function (problem) {
    return problem.includes(fragment);
  });
}

function main() {
  // -------------------------------------------------------- the plain sum

  // NO DISCOUNT. 445000 + 295000 = 740000. Cost 330000 + 220000 = 550000.
  // Margin 740000 - 550000 = 190000. Supplement 78000 + 46000 = 124000.
  const plain = derivePackagePricing(
    { components: [component("safari_mara"), component("safari_amboseli")] },
    resolve
  );
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.pricing.currency, "USD");
  assert.strictEqual(plain.pricing.perPersonCents, 740000);
  assert.strictEqual(plain.pricing.singleSupplementCents, 124000);
  assert.strictEqual(plain.pricing.internal.costPerPersonCents, 550000);
  assert.strictEqual(plain.pricing.internal.marginPerPersonCents, 190000);
  assert.strictEqual(plain.pricing.internal.discountBasisPoints, 0);
  assert.strictEqual(plain.pricing.internal.discountPerPersonCents, 0);
  assert.strictEqual(plain.pricing.internal.listPerPersonCents, 740000);
  console.log("packagePricing: an undiscounted package is the sum of its parts");

  // THE COST SITS UNDER `internal`, never alongside the sell price - the same
  // shape a product uses, so one customer-facing projection strips one field.
  assert.strictEqual(plain.pricing.costPerPersonCents, undefined);
  assert.strictEqual(plain.pricing.marginPerPersonCents, undefined);
  assert.ok(Object.isFrozen(plain.pricing));
  assert.ok(Object.isFrozen(plain.pricing.internal));
  console.log("packagePricing: cost and margin are nested under internal, and frozen");

  // --------------------------------------------------------- the discount

  // 10% OFF. 740000 * 1000 / 10000 = 74000 exactly. 740000 - 74000 = 666000.
  // Margin 666000 - 550000 = 116000.
  const discounted = derivePackagePricing(
    {
      components: [component("safari_mara"), component("safari_amboseli")],
      discountBasisPoints: 1000,
    },
    resolve
  );
  assert.strictEqual(discounted.ok, true);
  assert.strictEqual(discounted.pricing.internal.listPerPersonCents, 740000);
  assert.strictEqual(discounted.pricing.internal.discountPerPersonCents, 74000);
  assert.strictEqual(discounted.pricing.perPersonCents, 666000);
  assert.strictEqual(discounted.pricing.internal.marginPerPersonCents, 116000);
  console.log("packagePricing: a discount comes off the per-person price");

  // THE SUPPLEMENT IS NOT DISCOUNTED. Still 124000, the undiscounted sum. This
  // is invisible in the output and would be invisible if it were wrong, which
  // is exactly why it is asserted.
  assert.strictEqual(discounted.pricing.singleSupplementCents, 124000);
  console.log("packagePricing: the single supplement is not discounted");

  // ROUNDING, half-up on the discount AMOUNT - the rule quotePricing.js owns
  // and this module reuses rather than copies. 740000 * 333 / 10000 = 24642.0,
  // so take a figure that genuinely lands on a half cent: 210000 + 295000 =
  // 505000 at 333bp = 16816.5, which rounds to 16817, leaving 488183.
  const rounded = derivePackagePricing(
    {
      components: [component("safari_nosupplement"), component("safari_amboseli")],
      discountBasisPoints: 333,
    },
    resolve
  );
  assert.strictEqual(rounded.pricing.internal.listPerPersonCents, 505000);
  assert.strictEqual(rounded.pricing.internal.discountPerPersonCents, 16817);
  assert.strictEqual(rounded.pricing.perPersonCents, 488183);
  console.log("packagePricing: a half-cent discount rounds half-up, per quotePricing");

  // A product with NO supplement contributes nothing, rather than refusing.
  // 210000 + 295000 = 505000; supplement 0 + 46000 = 46000.
  assert.strictEqual(rounded.pricing.singleSupplementCents, 46000);
  console.log("packagePricing: a product with no supplement contributes nothing");

  // ------------------------------------------------------ the below-cost floor

  // THE MOST VALUABLE CHECK HERE. Combined cost is 550000; a 30% discount
  // leaves 740000 - 222000 = 518000, which is 32000 short. Both figures and the
  // shortfall are named, because "below cost" alone does not tell an advisor
  // how much to back off.
  const belowCost = derivePackagePricing(
    {
      components: [component("safari_mara"), component("safari_amboseli")],
      discountBasisPoints: 3000,
    },
    resolve
  );
  assert.strictEqual(belowCost.ok, false);
  assert.ok(mentions(belowCost.problems, "$5180.00 is below the combined cost $5500.00"));
  assert.ok(mentions(belowCost.problems, "reduce the discount by at least $320.00"));
  console.log("packagePricing: a discount that sells below cost is refused with the shortfall");

  // The boundary: exactly at cost is allowed. 740000 - 190000 = 550000, and
  // 190000 / 740000 is not a round basis point, so this is checked by picking
  // the discount that lands on it: 2567bp gives 189958, leaving 550042 - just
  // above. 2568bp gives 190032, leaving 549968 - just below. The pair pins the
  // boundary without depending on the formula.
  assert.strictEqual(
    derivePackagePricing(
      { components: [component("safari_mara"), component("safari_amboseli")], discountBasisPoints: 2567 },
      resolve
    ).ok,
    true
  );
  assert.strictEqual(
    derivePackagePricing(
      { components: [component("safari_mara"), component("safari_amboseli")], discountBasisPoints: 2568 },
      resolve
    ).ok,
    false
  );
  console.log("packagePricing: zero margin is allowed, one cent below it is not");

  // ------------------------------------------------------------ the envelope

  // A discount over the package ceiling is refused on its own terms, BEFORE the
  // below-cost floor would also have caught it - so the advisor is told the
  // real problem (the number is implausible) rather than a consequence of it.
  const tooSteep = derivePackagePricing(
    {
      components: [component("safari_mara"), component("safari_amboseli")],
      discountBasisPoints: MAX_PACKAGE_DISCOUNT_BASIS_POINTS + 1,
    },
    resolve
  );
  assert.strictEqual(tooSteep.ok, false);
  assert.ok(
    mentions(
      tooSteep.problems,
      "discountBasisPoints must be a whole number from 0 to " + MAX_PACKAGE_DISCOUNT_BASIS_POINTS
    )
  );
  console.log("packagePricing: a discount over the package ceiling is refused");

  // Fractional, negative, and a string that looks like a number.
  [-1, 2.5, "1000", {}].forEach(function (discountBasisPoints) {
    const result = derivePackagePricing(
      {
        components: [component("safari_mara"), component("safari_amboseli")],
        discountBasisPoints: discountBasisPoints,
      },
      resolve
    );
    assert.strictEqual(result.ok, false);
    assert.ok(mentions(result.problems, "discountBasisPoints must be a whole number"));
  });
  console.log("packagePricing: every unusable discount is refused");

  // ----------------------------------------------- broken product-book data

  // A product with no cost figure cannot have a margin checked, so it is
  // refused rather than priced at an unknown margin. This is OUR data being
  // wrong, and the message says so without blaming the caller's input.
  const noCost = derivePackagePricing(
    { components: [component("safari_mara"), component("safari_nocost")] },
    resolve
  );
  assert.strictEqual(noCost.ok, false);
  assert.ok(mentions(noCost.problems, "components[1]: the referenced product has unusable price or cost figures"));
  console.log("packagePricing: a product with no cost figure is refused");

  const noPricing = derivePackagePricing(
    { components: [component("safari_mara"), component("safari_nopricing")] },
    resolve
  );
  assert.ok(mentions(noPricing.problems, "components[1]: the referenced product has no pricing"));
  console.log("packagePricing: a product with no pricing block is refused");

  const offCurrency = derivePackagePricing(
    { components: [component("safari_mara"), component("safari_offcurrency")] },
    resolve
  );
  assert.ok(
    mentions(offCurrency.problems, "components[1]: the referenced product is priced in a currency this system cannot total")
  );
  console.log("packagePricing: a product in an untotallable currency is refused");

  // NO PARTIAL PRICE. One unresolvable component means no pricing at all, not a
  // total of the components that did resolve - a wrong price is the one output
  // of this module nobody would question.
  const missing = derivePackagePricing(
    { components: [component("safari_mara"), component("safari_nope")] },
    resolve
  );
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.pricing, undefined);
  console.log("packagePricing: one unresolvable component means no price at all");

  // A missing resolver and an empty component list are reported, not thrown.
  assert.strictEqual(derivePackagePricing({ components: [component("safari_mara")] }, null).ok, false);
  assert.ok(mentions(derivePackagePricing({ components: [] }, resolve).problems, "must have components"));
  console.log("packagePricing: a missing resolver or empty package is reported, not thrown");

  console.log("packagePricing: all tests passed");
}

main();
