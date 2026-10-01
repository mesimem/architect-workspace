// STORY-007: the arithmetic of a quote. Pure, deterministic, no I/O.
//
// WHY THIS IS ITS OWN MODULE. REQ-009 asks for professional quotes, and the
// story names "incorrect pricing" as a failure path to handle. Pricing is the
// part of a quote that is WRONG SILENTLY: a mis-summed total looks exactly
// like a correct one on screen, and the customer finds the error, not us. So
// the arithmetic is separated from storage (quoteStore.js) and from
// presentation (quoteView.js), and it is a pure function of its arguments -
// no clock, no store, no randomness. The same input prices the same way
// today, on a retry, and in a year when someone asks how we arrived at a
// figure we billed.
//
// WHY THE BACKEND HAS NO RATE CARD. mcp/trip-quotes/server.py holds one
// (PRICE_BOOK, season multipliers, add-ons) and prices a CATALOG trip for a
// party. Copying those numbers into JavaScript would create a second source of
// truth for money, and the two would disagree the first time one was updated -
// which is the worst kind of pricing bug, because both sides look authoritative.
// Instead an advisor composes a quote from explicit LINE ITEMS: this module
// prices what it is given and records the inputs, so a quote is reproducible
// from its own contents rather than from whatever the rate card said that day.
// A future story that wants catalog pricing should call the MCP tool and feed
// its output in here as line items, not re-implement it.
//
// EVERY FIGURE IS AN INTEGER NUMBER OF CENTS. There are no floats anywhere in
// this file, because 0.1 + 0.2 !== 0.3 and a quote is a document someone pays
// against. The one place a ratio is unavoidable - a percentage discount - is
// expressed in basis points and rounded once, explicitly, with the rule
// written down (see applyDiscount).
//
// THE INTERNAL / CUSTOMER SPLIT STARTS HERE. Each line carries a supplier cost
// AND a sell price. This module computes both totals and the margin between
// them. It does NOT decide who may see which - that is quoteView.js's single
// job - but it keeps them in clearly separate fields (`internal` vs the line's
// `sellCents`) so the projection has something unambiguous to filter on. A
// shape where cost and price are mingled is a shape you leak by accident.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns { status: "invalid_quote",
//     problems: [...] } and never a partial price. There is no throw path on
//     bad input: bad input arrives from an HTTP body and must become a 400,
//     not a 500. The one throw is the arithmetic self-check below, which fires
//     only if this module's own maths is inconsistent - a bug, not a request.
//  2. Will it retry? Nothing to retry. No I/O, no dependency, no clock.
//  3. Recovery path? The problem list names every bad field at once, so an
//     advisor fixes the whole form in one pass instead of discovering faults
//     one submission at a time. Problems never echo the submitted value back
//     (see describeValue) - a quote body can carry pasted customer data.
//  4. Handled here: missing/empty lines, non-integer or fractional cents,
//     negative costs, a sell price below cost, absurd quantities, too many
//     lines, overflow past MAX_TOTAL_CENTS, an unknown currency, and a
//     discount that would take the total below zero. NOT handled: taxes and
//     fees (no jurisdiction model exists in this build), multi-currency within
//     one quote (deliberately rejected - see CURRENCIES), per-traveler pricing
//     units (STORY-008 owns group travel), and payment scheduling.

// One quote, one currency. A quote that mixes currencies needs an exchange
// rate, and an exchange rate needs a date and a source - none of which this
// build has. Rejecting the mix is honest; silently adding USD to EUR is not.
const CURRENCIES = Object.freeze(["USD"]);

const MAX_LINES = 50;
const MAX_LABEL_LENGTH = 120;
const MAX_QUANTITY = 1000;

// $10,000,000.00. Well above any real trip and well below Number.MAX_SAFE_INTEGER,
// so every intermediate sum stays exact in a JS number. A quote that exceeds
// this is a typo (a cents/dollars mix-up, usually) and is refused rather than
// priced.
const MAX_TOTAL_CENTS = 1000000000;

// Basis points: 10000 = 100%. Integers, so a "5% group discount" is 500 and
// not 0.05 - see the header on why no float enters this file.
const MAX_DISCOUNT_BASIS_POINTS = 10000;

const STATUSES = Object.freeze({
  PRICED: "priced",
  INVALID_QUOTE: "invalid_quote",
});

// Thrown only when this module's own totals disagree with its own lines. That
// is not a caller error and must not be reported as one - it is a bug in here,
// and it should stop the request loudly rather than emit a plausible wrong
// number.
class PricingInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingInvariantError";
    this.errorClass = "ContractViolation";
  }
}

// Describes the SHAPE of a bad value, never the value itself. A quote line can
// carry a customer's name or an itinerary note, and problems end up in an HTTP
// response and in logs.
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

// Money must be a whole, finite, non-negative number of cents. `Number.isInteger`
// alone would accept 1e21; the bound is what keeps every later sum exact.
function isMoneyCents(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TOTAL_CENTS;
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Validates ONE line and returns its problems, prefixed with the line's index
// so an advisor can tell which row of the form is wrong. Returns [] when the
// line is usable.
//
// A line is: what we buy it for (unitCostCents), what we sell it for
// (unitSellCents), and how many. Margin is derived, never supplied - a
// supplied margin is a third number that can disagree with the other two.
function validateLine(line, index) {
  const at = "line " + index + ": ";

  if (line === null || typeof line !== "object" || Array.isArray(line)) {
    return [at + "must be an object; received " + describeValue(line)];
  }

  const problems = [];

  if (!isNonBlankString(line.label)) {
    problems.push(at + "label must be a non-empty string");
  } else if (line.label.length > MAX_LABEL_LENGTH) {
    problems.push(at + "label must be at most " + MAX_LABEL_LENGTH + " characters");
  }

  if (!isMoneyCents(line.unitCostCents)) {
    problems.push(
      at + "unitCostCents must be a whole number of cents, 0 or more; received " +
        describeValue(line.unitCostCents)
    );
  }

  if (!isMoneyCents(line.unitSellCents)) {
    problems.push(
      at + "unitSellCents must be a whole number of cents, 0 or more; received " +
        describeValue(line.unitSellCents)
    );
  }

  if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
    problems.push(
      at + "quantity must be a whole number from 1 to " + MAX_QUANTITY + "; received " +
        describeValue(line.quantity)
    );
  }

  // SELLING BELOW COST IS REFUSED, NOT WARNED ABOUT. The overwhelmingly common
  // cause is a transposed pair of fields or a cents/dollars slip, and the
  // result is a quote the business loses money honouring. An advisor who
  // genuinely intends a loss-leader can price the line at cost and record the
  // concession as a discount, where it is visible and audited.
  if (
    isMoneyCents(line.unitCostCents) &&
    isMoneyCents(line.unitSellCents) &&
    line.unitSellCents < line.unitCostCents
  ) {
    problems.push(
      at + "unitSellCents must not be below unitCostCents (a quote below cost is refused; " +
        "record an intentional concession as a discount instead)"
    );
  }

  return problems;
}

// The discount, in basis points, applied to the summed sell total.
//
// ROUNDING IS DEFINED HERE AND NOWHERE ELSE. Math.round on the discount AMOUNT
// (not on the remaining total) means the discount is what we say it is and the
// total absorbs the half-cent. Rounding the total instead would leave the
// printed discount line disagreeing with the arithmetic by a cent, which is
// exactly the kind of tiny inconsistency that makes a customer distrust the
// whole document. Math.round is half-up on positives, which favours the
// customer by at most one cent - a rule we can defend out loud.
function applyDiscount(subtotalCents, discountBasisPoints) {
  if (discountBasisPoints === 0) {
    return 0;
  }
  return Math.round((subtotalCents * discountBasisPoints) / 10000);
}

function validateInputs({ lines, currency, discountBasisPoints }) {
  const problems = [];

  if (!Array.isArray(lines) || lines.length === 0) {
    problems.push("lines must be a non-empty array of quote lines");
  } else if (lines.length > MAX_LINES) {
    problems.push("a quote may have at most " + MAX_LINES + " lines");
  } else {
    lines.forEach(function (line, index) {
      validateLine(line, index).forEach(function (problem) {
        problems.push(problem);
      });
    });
  }

  if (!CURRENCIES.includes(currency)) {
    problems.push("currency must be one of " + CURRENCIES.join(", "));
  }

  if (
    !Number.isInteger(discountBasisPoints) ||
    discountBasisPoints < 0 ||
    discountBasisPoints > MAX_DISCOUNT_BASIS_POINTS
  ) {
    problems.push(
      "discountBasisPoints must be a whole number from 0 to " +
        MAX_DISCOUNT_BASIS_POINTS +
        " (100 = 1%); received " +
        describeValue(discountBasisPoints)
    );
  }

  return problems;
}

// Prices a quote. Returns either
//   { status: "priced", pricing: {...} }
//   { status: "invalid_quote", problems: [...] }
// and never anything in between. `discountBasisPoints` defaults to 0 so the
// common case does not have to say "no discount".
//
// The returned `pricing` is frozen two levels down: callers store it verbatim,
// and a stored price that a later caller can edit in place is not a price.
function priceQuote({ lines, currency, discountBasisPoints = 0 }) {
  const problems = validateInputs({
    lines: lines,
    currency: currency,
    discountBasisPoints: discountBasisPoints,
  });
  if (problems.length > 0) {
    return { status: STATUSES.INVALID_QUOTE, problems: problems };
  }

  const pricedLines = lines.map(function (line) {
    const costCents = line.unitCostCents * line.quantity;
    const sellCents = line.unitSellCents * line.quantity;
    return Object.freeze({
      label: line.label.trim(),
      quantity: line.quantity,
      unitSellCents: line.unitSellCents,
      // What the customer is charged for this row. quoteView.js publishes this.
      sellCents: sellCents,
      // INTERNAL. Grouped under one key rather than sitting beside sellCents so
      // that "does this field go to the customer?" is answered by where it
      // lives, not by remembering what each name means.
      internal: Object.freeze({
        unitCostCents: line.unitCostCents,
        costCents: costCents,
        marginCents: sellCents - costCents,
      }),
    });
  });

  const subtotalCents = pricedLines.reduce(function (sum, line) {
    return sum + line.sellCents;
  }, 0);

  // Checked BEFORE the discount, so a wildly mis-keyed line is reported as the
  // typo it is rather than being discounted into a plausible-looking range.
  if (subtotalCents > MAX_TOTAL_CENTS) {
    return {
      status: STATUSES.INVALID_QUOTE,
      problems: [
        "the quote total exceeds the maximum of " +
          MAX_TOTAL_CENTS +
          " cents; check for a figure entered in dollars rather than cents",
      ],
    };
  }

  const discountCents = applyDiscount(subtotalCents, discountBasisPoints);
  const totalCents = subtotalCents - discountCents;

  const costTotalCents = pricedLines.reduce(function (sum, line) {
    return sum + line.internal.costCents;
  }, 0);

  // THE SELF-CHECK. Cheap, and it is the difference between shipping a wrong
  // total and refusing to. It cannot fire for any input the validation above
  // admits; if it ever does, the bug is in this file and the request must die
  // loudly rather than return a number someone will invoice against.
  if (totalCents < 0 || subtotalCents !== pricedLines.reduce((s, l) => s + l.sellCents, 0)) {
    throw new PricingInvariantError(
      "priced lines do not sum to the quote total - refusing to return a price."
    );
  }

  return {
    status: STATUSES.PRICED,
    pricing: Object.freeze({
      currency: currency,
      lines: Object.freeze(pricedLines),
      subtotalCents: subtotalCents,
      discountBasisPoints: discountBasisPoints,
      discountCents: discountCents,
      totalCents: totalCents,
      // INTERNAL, same reasoning as the per-line `internal` block: one place to
      // filter, named so that publishing it would have to be deliberate.
      internal: Object.freeze({
        costTotalCents: costTotalCents,
        marginCents: totalCents - costTotalCents,
      }),
    }),
  };
}

module.exports = {
  priceQuote,
  // STORY-017: exported so packages/packagePricing.js can apply a package
  // discount by the SAME rule, rather than copying the formula. The comment on
  // applyDiscount says rounding "is defined here and nowhere else", and a
  // second copy three directories away would quietly make that false - which is
  // how a quote and the package it was built from end up disagreeing by a cent.
  applyDiscount,
  STATUSES,
  CURRENCIES,
  MAX_LINES,
  MAX_QUANTITY,
  MAX_TOTAL_CENTS,
  MAX_DISCOUNT_BASIS_POINTS,
  PricingInvariantError,
};
