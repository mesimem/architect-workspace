// STORY-015: what makes a safari product well-formed. Pure, deterministic, no
// I/O, no clock, no store.
//
// WHY THIS IS SEPARATE FROM THE STORE. The story names three failure paths and
// two of them - "incorrect pricing data" and "itinerary conflicts" - are
// questions about a RECORD, not about storage. Answering them here means they
// can be tested exhaustively without a filesystem, and it means the store has
// exactly one job: write the thing down and audit that it happened. Same split
// as quotes/quotePricing.js (arithmetic) against quotes/quoteStore.js
// (persistence), for the same reason.
//
// WHY THE MONEY CONSTANTS ARE IMPORTED RATHER THAN RESTATED. quotePricing.js's
// header is explicit that a second source of truth for money is the worst kind
// of pricing bug, because both copies look authoritative. A product's price is
// the same currency in the same units as a quote line's, so the currency list
// and the ceiling come from there. This is a one-way dependency: the quote
// module knows nothing about products.
//
// EVERY FIGURE IS AN INTEGER NUMBER OF CENTS, for the reason quotePricing.js
// gives at length: 0.1 + 0.2 !== 0.3, and a product price is what a customer
// is eventually billed against. A float here is refused, not rounded - a
// rounded float is a wrong number that looks right.
//
// WHAT "ITINERARY CONFLICT" MEANS HERE, PRECISELY. Three distinct faults, all
// of which a human eye slides over on a 14-day itinerary:
//   1. Two entries claiming the same day  ("day 3" twice - which one runs?)
//   2. A day outside the product's duration ("day 9" on a 7-day safari)
//   3. A gap - days 1,2,4 on a 4-day product, so day 3 is unsold time
// The rule that catches all three at once is: the set of days must be exactly
// 1..durationDays, each appearing once. An itinerary that fails that is not
// "incomplete", it is internally contradictory, and it is refused rather than
// stored for someone to notice later.
//
// ORDER IS NOT A FAULT. An itinerary posted out of order (day 3 before day 2)
// is valid - normaliseItinerary sorts it. Refusing it would fail forms that
// submit a reordered list, which is a usability bug dressed up as rigour.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns a LIST OF PROBLEMS and never a
//     partial product. There is no throw path: every input here arrives from an
//     HTTP body and must become a 400, not a 500.
//  2. Will it retry? Nothing to retry. Pure function of its arguments.
//  3. Recovery path? The problem list names every fault at once - all bad days
//     and all bad prices in one pass - so a product manager fixes the whole
//     form in one submission instead of discovering faults one at a time.
//  4. Handled here: missing/blank/over-long text, non-integer and fractional
//     cents, negative money, a price below cost, absurd durations, duplicate
//     days, out-of-range days, gaps, day counts that disagree with
//     durationDays, non-array and non-object shapes, and prototype-chain keys.
//     NOT handled: seasonal or per-date pricing (no date model exists in this
//     build - a product carries one price and a quote carries the season), per-
//     traveler tiers, currency conversion (one currency, see CURRENCIES), and
//     whether the described destination actually exists in the catalog - that
//     is a cross-record question and this module only sees one record.

const { CURRENCIES, MAX_TOTAL_CENTS } = require("../quotes/quotePricing");

// A safari longer than this is a cents/dollars-style slip in the other units:
// someone typed months, or pasted a year. Refused rather than accepted as a
// 4000-day itinerary nobody will ever finish filling in.
const MAX_DURATION_DAYS = 60;

const MAX_NAME_LENGTH = 120;
const MAX_COUNTRY_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_DAY_TITLE_LENGTH = 120;
const MAX_DAY_DETAIL_LENGTH = 2000;
const MAX_LOCATION_LENGTH = 120;

// What a day entry may carry. An allow-list, not a suggestion: unknown keys are
// reported by name so a typo ("titel") is a refusal rather than a silently
// dropped field that a product manager believes they saved.
const DAY_FIELDS = Object.freeze(["day", "title", "detail", "location"]);

// What a pricing block may carry. costPerPersonCents is REQUIRED, not optional:
// without it there is no margin to check and the below-cost refusal below can
// never fire, which is the single most valuable check in this module.
const PRICING_FIELDS = Object.freeze([
  "currency",
  "perPersonCents",
  "singleSupplementCents",
  "costPerPersonCents",
]);

// Describes the SHAPE of a bad value, never the value itself. A product carries
// prose written by a person and these strings end up in an HTTP response and in
// log lines. Same rule as quotePricing.js's describeValue.
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

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Money: whole, finite, non-negative cents, inside the ceiling that keeps every
// later sum exact in a JS number. Number.isInteger alone would accept 1e21.
function isMoneyCents(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TOTAL_CENTS;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// hasOwnProperty, not `key in object`: a body of { "constructor": ... } arrives
// from a request more often than anyone expects, and `in` says yes to it.
function ownKeys(object) {
  return Object.keys(object).filter(function (key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  });
}

function unknownFieldProblems(object, allowed, at) {
  const unknown = ownKeys(object).filter(function (key) {
    return !allowed.includes(key);
  });
  return unknown.length === 0 ? [] : [at + "unknown fields: " + unknown.sort().join(", ")];
}

// Validates ONE day entry. Problems are prefixed with the entry's INDEX, not
// its day number - the day number may be the thing that is wrong, and telling a
// product manager "day undefined is invalid" helps nobody find the row.
function validateDay(entry, index) {
  const at = "itinerary[" + index + "]: ";

  if (!isPlainObject(entry)) {
    return [at + "must be an object; received " + describeValue(entry)];
  }

  const problems = unknownFieldProblems(entry, DAY_FIELDS, at);

  if (!Number.isInteger(entry.day) || entry.day < 1 || entry.day > MAX_DURATION_DAYS) {
    problems.push(
      at +
        "day must be a whole number from 1 to " +
        MAX_DURATION_DAYS +
        "; received " +
        describeValue(entry.day)
    );
  }

  if (!isNonBlankString(entry.title)) {
    problems.push(at + "title must be a non-empty string");
  } else if (entry.title.trim().length > MAX_DAY_TITLE_LENGTH) {
    problems.push(at + "title must be at most " + MAX_DAY_TITLE_LENGTH + " characters");
  }

  // Optional, because a day can legitimately be "Arrival, transfer to camp" and
  // nothing more. Absent is fine; present and unusable is not.
  if (entry.detail !== undefined && entry.detail !== null) {
    if (typeof entry.detail !== "string") {
      problems.push(at + "detail must be a string when present");
    } else if (entry.detail.length > MAX_DAY_DETAIL_LENGTH) {
      problems.push(at + "detail must be at most " + MAX_DAY_DETAIL_LENGTH + " characters");
    }
  }

  if (entry.location !== undefined && entry.location !== null) {
    if (!isNonBlankString(entry.location)) {
      problems.push(at + "location must be a non-empty string when present");
    } else if (entry.location.trim().length > MAX_LOCATION_LENGTH) {
      problems.push(at + "location must be at most " + MAX_LOCATION_LENGTH + " characters");
    }
  }

  return problems;
}

// The conflict check - see the header for what the three faults are. Runs on the
// days that PASSED their own validation, because a day of `undefined` cannot be
// a duplicate of anything and reporting it twice is noise.
function itineraryConflictProblems(itinerary, durationDays) {
  if (!Number.isInteger(durationDays)) {
    // durationDays is separately reported as invalid; without it there is no
    // range to check against, so this check stays silent rather than guessing.
    return [];
  }

  const problems = [];
  const days = itinerary
    .filter(isPlainObject)
    .map(function (entry) {
      return entry.day;
    })
    .filter(function (day) {
      return Number.isInteger(day);
    });

  const seen = new Set();
  const duplicates = new Set();
  days.forEach(function (day) {
    if (seen.has(day)) {
      duplicates.add(day);
    }
    seen.add(day);
  });

  if (duplicates.size > 0) {
    problems.push(
      "itinerary has more than one entry for day " +
        Array.from(duplicates)
          .sort(function (a, b) {
            return a - b;
          })
          .join(", ")
    );
  }

  const outOfRange = days.filter(function (day) {
    return day > durationDays;
  });
  if (outOfRange.length > 0) {
    problems.push(
      "itinerary describes day " +
        Array.from(new Set(outOfRange))
          .sort(function (a, b) {
            return a - b;
          })
          .join(", ") +
        " but the product runs " +
        durationDays +
        " days"
    );
  }

  const missing = [];
  for (let day = 1; day <= durationDays; day += 1) {
    if (!seen.has(day)) {
      missing.push(day);
    }
  }
  if (missing.length > 0) {
    problems.push(
      "itinerary is missing day " + missing.join(", ") + " of " + durationDays
    );
  }

  return problems;
}

// The itinerary as a whole: each entry, then the conflicts between them.
function validateItinerary(itinerary, durationDays) {
  if (!Array.isArray(itinerary) || itinerary.length === 0) {
    return ["itinerary must be a non-empty array of day entries"];
  }
  if (itinerary.length > MAX_DURATION_DAYS) {
    return ["itinerary must have at most " + MAX_DURATION_DAYS + " day entries"];
  }

  const problems = [];
  itinerary.forEach(function (entry, index) {
    problems.push.apply(problems, validateDay(entry, index));
  });

  return problems.concat(itineraryConflictProblems(itinerary, durationDays));
}

// The pricing block. Margin is NOT accepted as an input anywhere - it is
// derived by the store from these two figures, because a supplied margin is a
// third number that can disagree with the other two.
function validatePricing(pricing) {
  if (!isPlainObject(pricing)) {
    return ["pricing must be an object; received " + describeValue(pricing)];
  }

  const problems = unknownFieldProblems(pricing, PRICING_FIELDS, "pricing: ");

  if (!CURRENCIES.includes(pricing.currency)) {
    problems.push("pricing: currency must be one of " + CURRENCIES.join(", "));
  }

  if (!isMoneyCents(pricing.perPersonCents) || pricing.perPersonCents === 0) {
    problems.push(
      "pricing: perPersonCents must be a whole number of cents above 0; received " +
        describeValue(pricing.perPersonCents)
    );
  }

  if (!isMoneyCents(pricing.costPerPersonCents)) {
    problems.push(
      "pricing: costPerPersonCents must be a whole number of cents, 0 or more; received " +
        describeValue(pricing.costPerPersonCents)
    );
  }

  // Optional; absent means no single traveler surcharge.
  if (pricing.singleSupplementCents !== undefined && pricing.singleSupplementCents !== null) {
    if (!isMoneyCents(pricing.singleSupplementCents)) {
      problems.push(
        "pricing: singleSupplementCents must be a whole number of cents, 0 or more; received " +
          describeValue(pricing.singleSupplementCents)
      );
    }
  }

  // SELLING BELOW COST IS REFUSED, NOT WARNED ABOUT - the same rule, and the
  // same reasoning, as quotePricing.js's per-line check. The overwhelmingly
  // common cause is a transposed pair of fields or a cents/dollars slip, and
  // the result is a package the agency loses money on every time it sells.
  if (
    isMoneyCents(pricing.perPersonCents) &&
    isMoneyCents(pricing.costPerPersonCents) &&
    pricing.perPersonCents < pricing.costPerPersonCents
  ) {
    problems.push(
      "pricing: perPersonCents must not be below costPerPersonCents (a package priced " +
        "below cost is refused; record an intentional loss-leader as a quote discount instead)"
    );
  }

  return problems;
}

// The whole product. Returns [] when it is well-formed.
//
// A LIST, NOT THE FIRST FAULT. A 14-day itinerary with three bad days and a
// transposed price should take one round trip to fix, not four.
function validateSafariProduct(candidate) {
  if (!isPlainObject(candidate)) {
    return ["product must be an object; received " + describeValue(candidate)];
  }

  const problems = [];

  if (!isNonBlankString(candidate.name)) {
    problems.push("name is required and must not be blank");
  } else if (candidate.name.trim().length > MAX_NAME_LENGTH) {
    problems.push("name must be at most " + MAX_NAME_LENGTH + " characters");
  }

  if (!isNonBlankString(candidate.country)) {
    problems.push("country is required and must not be blank");
  } else if (candidate.country.trim().length > MAX_COUNTRY_LENGTH) {
    problems.push("country must be at most " + MAX_COUNTRY_LENGTH + " characters");
  }

  if (!isNonBlankString(candidate.summary)) {
    problems.push("summary is required and must not be blank");
  } else if (candidate.summary.trim().length > MAX_SUMMARY_LENGTH) {
    problems.push("summary must be at most " + MAX_SUMMARY_LENGTH + " characters");
  }

  if (
    !Number.isInteger(candidate.durationDays) ||
    candidate.durationDays < 1 ||
    candidate.durationDays > MAX_DURATION_DAYS
  ) {
    problems.push(
      "durationDays must be a whole number from 1 to " +
        MAX_DURATION_DAYS +
        "; received " +
        describeValue(candidate.durationDays)
    );
  }

  problems.push.apply(problems, validateItinerary(candidate.itinerary, candidate.durationDays));
  problems.push.apply(problems, validatePricing(candidate.pricing));

  return problems;
}

// Sorted by day, trimmed, frozen. Called by the store AFTER validation, so it
// may assume the itinerary is well-formed - it is a normaliser, not a second
// validator, and giving it validation of its own would create two answers to
// "is this itinerary legal?".
//
// Optional fields are normalised to null rather than left absent, so every
// stored day has the same shape and a reader never has to ask whether a key is
// missing or empty.
function normaliseItinerary(itinerary) {
  return Object.freeze(
    itinerary
      .slice()
      .sort(function (a, b) {
        return a.day - b.day;
      })
      .map(function (entry) {
        return Object.freeze({
          day: entry.day,
          title: entry.title.trim(),
          detail: isNonBlankString(entry.detail) ? entry.detail.trim() : null,
          location: isNonBlankString(entry.location) ? entry.location.trim() : null,
        });
      })
  );
}

// Same contract as normaliseItinerary: post-validation, no decisions. The
// margin is derived HERE and only here, and it is nested under `internal` for
// the reason quotePricing.js nests its own - a shape where cost and price are
// mingled is a shape you leak by accident. Products are staff-only today
// (products.read is not granted to `customer`), so there is no customer
// projection yet; when one is needed it filters this one field.
function normalisePricing(pricing) {
  const perPersonCents = pricing.perPersonCents;
  const costPerPersonCents = pricing.costPerPersonCents;
  const singleSupplementCents = Number.isInteger(pricing.singleSupplementCents)
    ? pricing.singleSupplementCents
    : 0;

  return Object.freeze({
    currency: pricing.currency,
    perPersonCents: perPersonCents,
    singleSupplementCents: singleSupplementCents,
    internal: Object.freeze({
      costPerPersonCents: costPerPersonCents,
      marginPerPersonCents: perPersonCents - costPerPersonCents,
    }),
  });
}

module.exports = {
  validateSafariProduct,
  validateItinerary,
  validatePricing,
  normaliseItinerary,
  normalisePricing,
  DAY_FIELDS,
  PRICING_FIELDS,
  MAX_DURATION_DAYS,
  MAX_NAME_LENGTH,
  MAX_SUMMARY_LENGTH,
};
