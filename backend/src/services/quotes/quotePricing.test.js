// STORY-007, the arithmetic half. These tests exist because "incorrect
// pricing" is one of the story's named failure paths, and a wrong total is
// the one defect in this feature that looks completely normal on screen.

const assert = require("assert");

const {
  priceQuote,
  STATUSES,
  MAX_LINES,
  MAX_QUANTITY,
  MAX_TOTAL_CENTS,
  MAX_DISCOUNT_BASIS_POINTS,
} = require("./quotePricing");

// A realistic two-line quote: a safari at cost $4,200 sold at $5,000 for two
// people, plus a transfer at cost $140 sold at $200 for the party.
function sampleLines() {
  return [
    { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
    { label: "Airport transfer", unitCostCents: 14000, unitSellCents: 20000, quantity: 1 },
  ];
}

function main() {
  // HAPPY PATH. Every figure is checked by hand, not recomputed by repeating
  // the implementation's formula - a test that restates the code cannot catch
  // the code being wrong.
  const priced = priceQuote({ lines: sampleLines(), currency: "USD" });
  assert.strictEqual(priced.status, STATUSES.PRICED);
  assert.strictEqual(priced.pricing.subtotalCents, 1020000); // 1,000,000 + 20,000
  assert.strictEqual(priced.pricing.discountCents, 0);
  assert.strictEqual(priced.pricing.totalCents, 1020000);
  assert.strictEqual(priced.pricing.internal.costTotalCents, 854000); // 840,000 + 14,000
  assert.strictEqual(priced.pricing.internal.marginCents, 166000);
  assert.strictEqual(priced.pricing.lines[0].sellCents, 1000000);
  assert.strictEqual(priced.pricing.lines[0].internal.marginCents, 160000);
  console.log("quotePricing: a two-line quote prices, sums and margins correctly");

  // THE SUM INVARIANT, stated as a test rather than trusted: the published
  // total is exactly the lines less the discount. If a future change adds a
  // fee that forgets to appear as a line, this fails.
  const lineSum = priced.pricing.lines.reduce(function (sum, line) {
    return sum + line.sellCents;
  }, 0);
  assert.strictEqual(lineSum, priced.pricing.subtotalCents);
  assert.strictEqual(
    priced.pricing.subtotalCents - priced.pricing.discountCents,
    priced.pricing.totalCents
  );
  console.log("quotePricing: lines sum exactly to the total");

  // DETERMINISM. Pricing the same input twice gives the same figures - the
  // property that lets a quote be re-derived during a dispute, and the reason
  // there is no clock in the module.
  const again = priceQuote({ lines: sampleLines(), currency: "USD" });
  assert.deepStrictEqual(again.pricing, priced.pricing);
  console.log("quotePricing: the same input always prices the same way");

  // DISCOUNT ROUNDING. 5% of 1,020,000 is exactly 51,000 - pick a figure that
  // does NOT divide evenly to pin the rounding rule down.
  const odd = priceQuote({
    lines: [{ label: "Lodge night", unitCostCents: 10000, unitSellCents: 33333, quantity: 1 }],
    currency: "USD",
    discountBasisPoints: 333, // 3.33% of 33,333 = 1,109.98... -> 1,110
  });
  assert.strictEqual(odd.pricing.discountCents, 1110);
  assert.strictEqual(odd.pricing.totalCents, 33333 - 1110);
  assert.strictEqual(Number.isInteger(odd.pricing.totalCents), true);
  console.log("quotePricing: a fractional discount rounds once, to whole cents");

  // FROZEN. A stored price a later caller can edit in place is not a price.
  assert.throws(function () {
    "use strict";
    priced.pricing.totalCents = 1;
  }, TypeError);
  assert.throws(function () {
    "use strict";
    priced.pricing.lines[0].internal.costCents = 0;
  }, TypeError);
  console.log("quotePricing: a returned price cannot be mutated by its caller");

  // FAILURE PATH - INCORRECT PRICING, the story's named one. Each of these is
  // a real way a wrong number reaches a customer, and each must be refused
  // rather than priced.

  // Fractional cents: the classic float leak.
  const fractional = priceQuote({
    lines: [{ label: "Guide", unitCostCents: 100.5, unitSellCents: 200, quantity: 1 }],
    currency: "USD",
  });
  assert.strictEqual(fractional.status, STATUSES.INVALID_QUOTE);
  assert.ok(fractional.problems.some((p) => p.includes("unitCostCents")));

  // Negative money.
  assert.strictEqual(
    priceQuote({
      lines: [{ label: "Guide", unitCostCents: -100, unitSellCents: 200, quantity: 1 }],
      currency: "USD",
    }).status,
    STATUSES.INVALID_QUOTE
  );

  // Sold below cost - a transposed pair, almost always.
  const belowCost = priceQuote({
    lines: [{ label: "Guide", unitCostCents: 90000, unitSellCents: 900, quantity: 1 }],
    currency: "USD",
  });
  assert.strictEqual(belowCost.status, STATUSES.INVALID_QUOTE);
  assert.ok(belowCost.problems.some((p) => p.includes("below cost")));

  // Dollars entered where cents were expected: individually plausible, absurd
  // in total. Caught by the ceiling.
  const overflow = priceQuote({
    lines: [{ label: "Charter", unitCostCents: MAX_TOTAL_CENTS, unitSellCents: MAX_TOTAL_CENTS, quantity: 50 }],
    currency: "USD",
  });
  assert.strictEqual(overflow.status, STATUSES.INVALID_QUOTE);
  assert.ok(overflow.problems.some((p) => p.includes("dollars rather than cents")));
  console.log("quotePricing: fractional, negative, below-cost and overflowing prices are all refused");

  // FAILURE PATH - malformed envelope. These arrive from an HTTP body, so they
  // must come back as data (a 400), never as a throw (a 500).
  for (const bad of [
    { lines: [], currency: "USD" },
    { lines: null, currency: "USD" },
    { lines: sampleLines(), currency: "EUR" },
    { lines: sampleLines(), currency: "USD", discountBasisPoints: -1 },
    { lines: sampleLines(), currency: "USD", discountBasisPoints: MAX_DISCOUNT_BASIS_POINTS + 1 },
    { lines: sampleLines(), currency: "USD", discountBasisPoints: 2.5 },
    { lines: [{ label: "", unitCostCents: 1, unitSellCents: 2, quantity: 1 }], currency: "USD" },
    { lines: [{ label: "Guide", unitCostCents: 1, unitSellCents: 2, quantity: 0 }], currency: "USD" },
    {
      lines: [{ label: "Guide", unitCostCents: 1, unitSellCents: 2, quantity: MAX_QUANTITY + 1 }],
      currency: "USD",
    },
    { lines: [null], currency: "USD" },
    { lines: ["not a line"], currency: "USD" },
    { lines: new Array(MAX_LINES + 1).fill(sampleLines()[0]), currency: "USD" },
  ]) {
    const result = priceQuote(bad);
    assert.strictEqual(result.status, STATUSES.INVALID_QUOTE, JSON.stringify(Object.keys(bad)));
    assert.ok(Array.isArray(result.problems) && result.problems.length > 0);
    assert.strictEqual(result.pricing, undefined, "a refused quote must carry no price at all");
  }
  console.log("quotePricing: every malformed input is refused as data, with no partial price");

  // EVERY BAD FIELD IS REPORTED AT ONCE, so an advisor fixes the form in one
  // pass instead of one submission per fault.
  const manyFaults = priceQuote({
    lines: [
      { label: "", unitCostCents: -1, unitSellCents: "free", quantity: 0 },
      { label: "Ok", unitCostCents: 100, unitSellCents: 50, quantity: 1 },
    ],
    currency: "GBP",
  });
  assert.ok(manyFaults.problems.length >= 5, "expected every fault, got " + manyFaults.problems.length);
  assert.ok(manyFaults.problems.some((p) => p.startsWith("line 0:")));
  assert.ok(manyFaults.problems.some((p) => p.startsWith("line 1:")));
  console.log("quotePricing: all problems are reported together, indexed by line");

  // PROBLEMS DO NOT ECHO THE SUBMITTED VALUE BACK. A quote line can carry
  // pasted customer detail, and problems end up in responses and logs.
  const secretish = priceQuote({
    lines: [{ label: "x".repeat(500), unitCostCents: 1, unitSellCents: 2, quantity: 1 }],
    currency: "USD",
  });
  assert.ok(secretish.problems.every((p) => !p.includes("xxxxx")));
  console.log("quotePricing: a refusal describes the fault without repeating the input");

  console.log("quotePricing: all tests passed");
}

main();
