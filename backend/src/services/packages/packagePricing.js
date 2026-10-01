// STORY-017: what a combined package costs. Pure - no I/O, no clock, no store.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It derives ONE
// pricing block from the components of a package. It does NOT decide whether
// the components fit together (packageCompatibility.js), does NOT write
// anything down (packageStore.js), and does NOT price a customer's actual trip
// - quotes/quotePricing.js does that, from explicit line items, and a quote
// built from a package still goes through it.
//
// WHY THE PRICE IS DERIVED AND NEVER AUTHORED. An advisor does not type a
// package price. The package holds product ids, the product book holds the
// prices, and this file adds them up. The alternative - letting an advisor type
// a package total - means the day a product manager reprices the Masai Mara
// (STORY-015 exists to let them), every package that sells it keeps quoting
// last quarter's figure, silently and forever. A stored copy of a number that
// lives somewhere else is a bug with a delay on it.
//
// THE ONE AUTHORED FIGURE IS THE DISCOUNT, and it is what makes a package an
// offering rather than an invoice. A customer who can buy the two safaris
// separately for the same money has not been offered a package. It is in basis
// points (500 = 5%) and it is an integer, because no float enters pricing in
// this repo - see the header of quotes/quotePricing.js, which is the authority
// on that rule and whose applyDiscount this file reuses rather than copies.
//
// THE DISCOUNT DOES NOT TOUCH THE SINGLE SUPPLEMENT. A supplement is what the
// lodge charges us for a room one person is in, passed through. Discounting it
// would mean a solo traveller's discount quietly comes out of our margin at a
// different rate than a couple's, which is not a decision anybody made - it is
// an arithmetic accident. Discounting the per-person price only is the rule,
// and it is stated here because it is invisible in the output.
//
// THE BELOW-COST FLOOR IS THE MOST VALUABLE CHECK HERE, for the same reason it
// is in safariProductValidation.js: every input is individually plausible. Two
// profitable safaris and a 40% package discount is three reasonable-looking
// numbers that together sell a trip at a loss, and nothing on the screen says
// so. The refusal names the shortfall.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns { ok: false, problems }. It does
//     not throw, does not mutate its inputs, and returns no partial pricing -
//     a caller cannot accidentally store half a price.
//  2. Will it retry? Nothing to retry. Pure integer arithmetic, no I/O.
//  3. Recovery path? The caller gets every problem at once and corrects the
//     discount, or the product book is corrected if the fault is a stored
//     product's figures.
//  4. Handled: unresolvable products, products whose stored figures are missing
//     or not whole cents, a discount that is absent, fractional, negative or
//     over the ceiling, sums that exceed MAX_TOTAL_CENTS, and a discounted
//     price below the summed cost. NOT handled: per-traveller tiers, child
//     pricing, seasonal rates, and currency conversion - all of which are
//     quotes/ concerns or do not exist in this system yet (see CURRENCIES).

const {
  applyDiscount,
  CURRENCIES,
  MAX_TOTAL_CENTS,
  MAX_DISCOUNT_BASIS_POINTS,
} = require("../quotes/quotePricing");

// Half of everything. A package discount steeper than this is a decimal slip
// (someone typed 5000 meaning 500), and the below-cost floor would often catch
// it anyway - but "50% off" is a decision a person should have to make
// deliberately, not a number a form accepts without comment. Deliberately
// tighter than quotePricing's MAX_DISCOUNT_BASIS_POINTS, which allows 100%
// because a quote can legitimately be fully comped and a catalogue package
// cannot.
const MAX_PACKAGE_DISCOUNT_BASIS_POINTS = 5000;

function describeValue(value) {
  if (typeof value === "string") {
    return "a string of length " + value.length;
  }
  if (Array.isArray(value)) {
    return "an array of length " + value.length;
  }
  if (value === null) {
    return "null";
  }
  return "type " + typeof value;
}

// Whole, finite, non-negative cents inside the ceiling that keeps every sum
// below exact in a JS number. Number.isInteger alone would accept 1e21.
function isMoneyCents(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TOTAL_CENTS;
}

function formatCents(cents) {
  return "$" + (cents / 100).toFixed(2);
}

// Pulls the four figures this module needs out of one stored product. Returns
// null and pushes a problem when the stored record cannot be added up - which
// is OUR data being wrong, not the caller's, and is reported as such.
function figuresFor(component, index, resolveProduct, problems) {
  const at = "components[" + index + "]: ";
  const product = resolveProduct(component.productId);

  if (!product || !product.pricing) {
    problems.push(at + "the referenced product has no pricing and cannot be added up");
    return null;
  }

  const pricing = product.pricing;
  const internal = pricing.internal || {};

  if (!CURRENCIES.includes(pricing.currency)) {
    // Not a compatibility fault - packageCompatibility.js reports a MISMATCH
    // between components. This is one product priced in something this system
    // cannot do arithmetic in at all.
    problems.push(
      at + "the referenced product is priced in a currency this system cannot total"
    );
    return null;
  }

  if (!isMoneyCents(pricing.perPersonCents) || !isMoneyCents(internal.costPerPersonCents)) {
    problems.push(at + "the referenced product has unusable price or cost figures");
    return null;
  }

  return {
    currency: pricing.currency,
    perPersonCents: pricing.perPersonCents,
    // Optional on a product, so absent means nothing extra rather than a fault.
    singleSupplementCents: isMoneyCents(pricing.singleSupplementCents)
      ? pricing.singleSupplementCents
      : 0,
    costPerPersonCents: internal.costPerPersonCents,
  };
}

// THE ENTRY POINT. Returns { ok: true, pricing } or { ok: false, problems }.
//
// Call it only on components that have passed validatePackage - it assumes they
// are well-shaped, the same way normaliseItinerary does in
// safariProductValidation.js. It stays defensive about the PRODUCT BOOK's
// figures regardless, because those are not the caller's to get right.
function derivePackagePricing({ components, discountBasisPoints }, resolveProduct) {
  const problems = [];

  if (typeof resolveProduct !== "function") {
    return { ok: false, problems: ["no product resolver was supplied; the package could not be priced"] };
  }
  if (!Array.isArray(components) || components.length === 0) {
    return { ok: false, problems: ["a package must have components to be priced"] };
  }

  // Absent means no discount. Explicitly allowed, because "these two trips,
  // sold together, at the sum of their prices" is a legitimate package - the
  // convenience is the product.
  const discount = discountBasisPoints === undefined || discountBasisPoints === null ? 0 : discountBasisPoints;
  if (
    !Number.isInteger(discount) ||
    discount < 0 ||
    discount > MAX_PACKAGE_DISCOUNT_BASIS_POINTS
  ) {
    problems.push(
      "discountBasisPoints must be a whole number from 0 to " +
        MAX_PACKAGE_DISCOUNT_BASIS_POINTS +
        " (100 = 1%); received " +
        describeValue(discountBasisPoints)
    );
  }

  const figures = components
    .map(function (component, index) {
      return figuresFor(component, index, resolveProduct, problems);
    })
    .filter(Boolean);

  // Returned before any arithmetic. Totalling a subset of the components would
  // produce a price that is wrong rather than absent, and a wrong price is the
  // one output of this module nobody would question.
  if (problems.length > 0 || figures.length !== components.length) {
    return { ok: false, problems: problems };
  }

  const listPerPersonCents = figures.reduce(function (total, entry) {
    return total + entry.perPersonCents;
  }, 0);
  const singleSupplementCents = figures.reduce(function (total, entry) {
    return total + entry.singleSupplementCents;
  }, 0);
  const costPerPersonCents = figures.reduce(function (total, entry) {
    return total + entry.costPerPersonCents;
  }, 0);

  // Checked AFTER summing, because the ceiling is about the total: twelve
  // products each comfortably under it can add up to something that is not.
  if (listPerPersonCents > MAX_TOTAL_CENTS || singleSupplementCents > MAX_TOTAL_CENTS) {
    return {
      ok: false,
      problems: ["the combined package price exceeds " + formatCents(MAX_TOTAL_CENTS) + " and is refused as a typo"],
    };
  }

  // The one shared rule. See the note on the export in quotes/quotePricing.js.
  const discountPerPersonCents = applyDiscount(listPerPersonCents, discount);
  const perPersonCents = listPerPersonCents - discountPerPersonCents;

  // THE FLOOR. Named with both figures, because "below cost" without the
  // shortfall tells an advisor they are wrong and not by how much.
  if (perPersonCents < costPerPersonCents) {
    return {
      ok: false,
      problems: [
        "the discounted package price " +
          formatCents(perPersonCents) +
          " is below the combined cost " +
          formatCents(costPerPersonCents) +
          "; reduce the discount by at least " +
          formatCents(costPerPersonCents - perPersonCents),
      ],
    };
  }

  return {
    ok: true,
    // Shaped like a product's pricing block, with cost and margin nested under
    // `internal` - the same field a customer-facing projection would strip.
    // Deliberately the SAME shape, so a client that can render a product price
    // can render a package price without a second code path.
    pricing: Object.freeze({
      currency: figures[0].currency,
      perPersonCents: perPersonCents,
      singleSupplementCents: singleSupplementCents,
      internal: Object.freeze({
        listPerPersonCents: listPerPersonCents,
        discountBasisPoints: discount,
        discountPerPersonCents: discountPerPersonCents,
        costPerPersonCents: costPerPersonCents,
        marginPerPersonCents: perPersonCents - costPerPersonCents,
      }),
    }),
  };
}

module.exports = {
  derivePackagePricing,
  MAX_PACKAGE_DISCOUNT_BASIS_POINTS,
};
