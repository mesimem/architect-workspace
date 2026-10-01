// STORY-010: what we have SIGNED with a supplier and what they CHARGE under
// it. Pure, deterministic, no I/O, no clock, no store.
//
// WHY THIS IS SEPARATE FROM supplierValidation.js. A supplier record is two
// different kinds of thing wearing one name. Half of it is identity - who they
// are, where they are, how to reach them - and half is commercial terms: the
// agreements and the rate card hanging off them. The second half is where all
// the arithmetic, all the date handling, and every cross-record consistency
// rule lives, and it is roughly as large as the first half on its own. Keeping
// both in one file put it over CLAUDE.md's 500-line ceiling and, more to the
// point, meant one module answered two unrelated questions.
//
// The dependency is ONE-WAY: supplierValidation.js imports this module, this
// module knows nothing about suppliers. It never sees a supplier record - only
// the two arrays - which is what keeps it testable in isolation and is why
// `crossReferenceProblems` takes contracts and rates as arguments rather than
// taking a supplier and reaching into it.
//
// WHAT "DATA MISMATCH" MEANS HERE, PRECISELY. The story names it as a failure
// path without saying what it is, so this module fixes a definition. A supplier
// is three things - who they are, what we have signed, and what they charge -
// and a mismatch is any way those parts can contradict each other. Four
// distinct faults, none of which a human eye catches on a supplier with six
// contracts:
//   1. A contract whose endDate is not after its startDate. A contract that
//      expires before it begins is not a date typo you can round off; nobody
//      can say whether it was ever in force.
//   2. Two contracts sharing a contractRef. A rate pointing at that ref then
//      resolves to two different agreements - which one are we billed under?
//   3. A rate whose contractRef names no contract this supplier holds. An
//      ORPHAN RATE: a price with no agreement behind it. This is the one that
//      actually costs money, because an orphan rate still looks quotable.
//   4. A rate in a currency the contract it hangs off is not denominated in.
//      The contract says USD, the rate says something else, and the difference
//      is only discovered when an invoice disagrees with a quote.
// Faults 1 and 2 are checked here against one entry at a time; 2, 3 and 4 need
// to see both arrays at once and live in crossReferenceProblems. All four are
// refused, not warned about. A supplier record that contradicts itself is worse
// than a missing one: the missing one stops you, and this one lets you carry on
// and quote from it.
//
// WHY THE MONEY RULES ARE IMPORTED RATHER THAN RESTATED. quotePricing.js's
// header is explicit that a second source of truth for money is the worst kind
// of pricing bug, because both copies look authoritative. A supplier rate is
// the same currency in the same units as a quote line's - it is, eventually,
// the cost side of one - so CURRENCIES and the ceiling come from there. One-way
// dependency: the quote module knows nothing about suppliers.
//
// EVERY FIGURE IS AN INTEGER NUMBER OF CENTS, for the reason quotePricing.js
// gives at length: 0.1 + 0.2 !== 0.3, and a supplier rate is what the agency is
// eventually billed. A float is refused, not rounded - a rounded float is a
// wrong number that looks right.
//
// DATES ARE PLAIN CALENDAR DAYS (YYYY-MM-DD), NOT TIMESTAMPS. A contract runs
// for days, not instants, and storing an instant forces a timezone decision
// that nobody involved in signing the contract made. Compared as strings, which
// is exact for this format and needs no Date parsing - `new Date("2026-02-30")`
// silently becomes March 2nd, which is how an impossible date gets stored as a
// real one, so the day is range-checked against the month instead.
//
// THE SMALL PREDICATES BELOW ARE RESTATED, NOT SHARED. describeValue,
// isPlainObject and friends also exist in quotePricing.js and in
// safariProductValidation.js, each with its own copy. That is the house style
// here and it is deliberate: they are three-line predicates with no behaviour
// worth centralising, and a shared "validation utils" module becomes a magnet
// for things that are not utilities. The rule in CLAUDE.md is that logic is
// lifted when the same NON-TRIVIAL five-plus lines appear in three places.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns a LIST OF PROBLEMS and never a
//     partial contract or rate. There is no throw path: every input here
//     arrives from an HTTP body and must become a 400, not a 500.
//  2. Will it retry? Nothing to retry. Pure functions of their arguments.
//  3. Recovery path? The problem list names every fault at once - every bad
//     contract and every orphan rate in one pass - so an advisor fixes the
//     whole form in one submission instead of discovering faults one at a time.
//  4. Handled here: malformed and impossible dates, inverted and zero-length
//     contracts, duplicated references, non-integer and negative money, orphan
//     rates, currency disagreement between a rate and its contract, unknown
//     statuses and units, non-array and non-object shapes, over-long text, and
//     prototype-chain keys. NOT handled: whether a contract has actually been
//     countersigned (no document model exists in this build), overlapping date
//     ranges for the same service (two concurrent contracts with one supplier
//     is normal, not a fault), seasonal rate variation (a rate carries one
//     figure and a quote carries the season), and currency conversion (one
//     currency, see CURRENCIES).

const { CURRENCIES, MAX_TOTAL_CENTS } = require("../quotes/quotePricing");

// Where a contract stands TODAY, as recorded by a person. Deliberately not
// derived from the dates: a contract can be signed but not yet active, or
// terminated early while its endDate is still in the future. Derived status
// would quietly overwrite both of those facts.
const CONTRACT_STATUSES = Object.freeze(["draft", "active", "expired", "terminated"]);

// What a rate is quoted per. An allow-list rather than free text, because
// "per night" and "per_night" and "nightly" are one concept, and a free field
// makes them three with no way to filter by any of them.
const RATE_UNITS = Object.freeze([
  "per_person",
  "per_person_per_night",
  "per_night",
  "per_group",
  "per_trip",
  "per_transfer",
]);

const CONTRACT_FIELDS = Object.freeze([
  "contractRef",
  "startDate",
  "endDate",
  "currency",
  "status",
  "notes",
]);

const RATE_FIELDS = Object.freeze([
  "contractRef",
  "description",
  "currency",
  "amountCents",
  "unit",
]);

const MAX_CONTRACT_REF_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;

// Caps, not limits anyone will reach in normal work. A body claiming 5000
// contracts is a paste accident or an attempt to make validation expensive, and
// either way refusing it is cheaper than storing it.
const MAX_CONTRACTS = 50;
const MAX_RATES = 200;

// Describes the SHAPE of a bad value, never the value itself. These strings end
// up in an HTTP response and in log lines, and a rate description is prose
// written by a person. Same rule as quotePricing.js's describeValue.
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

const DAYS_IN_MONTH = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

// A real calendar day in YYYY-MM-DD. The month/day range check is what stops
// "2026-02-30" and "2026-13-01" - both of which `new Date()` accepts and
// silently rolls forward into a different, real date. February is allowed 29
// every year rather than checking the leap rule: a contract dated 2026-02-29 is
// a typo worth catching, but catching it needs a leap-year calculation whose
// own off-by-one would reject a legitimate 2028-02-29. The looser rule is wrong
// in the direction that cannot refuse a valid contract.
function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) {
    return false;
  }
  return day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

// Trimmed and upper-cased. "ken-2026-01" and "KEN-2026-01 " are the same
// agreement, and every contractRef comparison in this module - the duplicate
// check and the orphan-rate check both - is only as good as this function.
function normaliseRef(value) {
  return isNonBlankString(value) ? value.trim().toUpperCase() : "";
}

// Validates ONE contract. Problems are prefixed with the entry's INDEX, not its
// contractRef - the ref may be the thing that is wrong, and telling an advisor
// "contract undefined is invalid" helps nobody find the row.
function validateContract(entry, index) {
  const at = "contracts[" + index + "]: ";

  if (!isPlainObject(entry)) {
    return [at + "must be an object; received " + describeValue(entry)];
  }

  const problems = unknownFieldProblems(entry, CONTRACT_FIELDS, at);

  if (!isNonBlankString(entry.contractRef)) {
    problems.push(at + "contractRef must be a non-empty string");
  } else if (entry.contractRef.trim().length > MAX_CONTRACT_REF_LENGTH) {
    problems.push(at + "contractRef must be at most " + MAX_CONTRACT_REF_LENGTH + " characters");
  }

  const startOk = isCalendarDate(entry.startDate);
  const endOk = isCalendarDate(entry.endDate);
  if (!startOk) {
    problems.push(
      at + "startDate must be a calendar date as YYYY-MM-DD; received " + describeValue(entry.startDate)
    );
  }
  if (!endOk) {
    problems.push(
      at + "endDate must be a calendar date as YYYY-MM-DD; received " + describeValue(entry.endDate)
    );
  }
  // MISMATCH 1 - see the header. Only checked when both dates parsed, because
  // comparing against a malformed date produces a second, confusing problem
  // about an input already reported as unusable.
  //
  // Strictly after, not on-or-after: a contract that starts and ends the same
  // day covers zero days, and the overwhelmingly common cause is a form that
  // defaulted both fields to today and only one got edited.
  if (startOk && endOk && entry.endDate <= entry.startDate) {
    problems.push(at + "endDate must be after startDate");
  }

  if (!CURRENCIES.includes(entry.currency)) {
    problems.push(at + "currency must be one of " + CURRENCIES.join(", "));
  }

  if (!CONTRACT_STATUSES.includes(entry.status)) {
    problems.push(at + "status must be one of " + CONTRACT_STATUSES.join(", "));
  }

  if (entry.notes !== undefined && entry.notes !== null) {
    if (typeof entry.notes !== "string") {
      problems.push(at + "notes must be a string when present");
    } else if (entry.notes.length > MAX_NOTES_LENGTH) {
      problems.push(at + "notes must be at most " + MAX_NOTES_LENGTH + " characters");
    }
  }

  return problems;
}

// Validates ONE rate, in isolation. Whether its contractRef resolves to
// anything is a question about the OTHER array, so it is answered in
// crossReferenceProblems below, not here.
function validateRate(entry, index) {
  const at = "rates[" + index + "]: ";

  if (!isPlainObject(entry)) {
    return [at + "must be an object; received " + describeValue(entry)];
  }

  const problems = unknownFieldProblems(entry, RATE_FIELDS, at);

  if (!isNonBlankString(entry.contractRef)) {
    problems.push(at + "contractRef must be a non-empty string");
  }

  if (!isNonBlankString(entry.description)) {
    problems.push(at + "description must be a non-empty string");
  } else if (entry.description.trim().length > MAX_DESCRIPTION_LENGTH) {
    problems.push(at + "description must be at most " + MAX_DESCRIPTION_LENGTH + " characters");
  }

  if (!CURRENCIES.includes(entry.currency)) {
    problems.push(at + "currency must be one of " + CURRENCIES.join(", "));
  }

  // Above zero, not 0-or-more. A supplier rate of zero is either a freebie that
  // belongs in the contract notes or a field someone left blank, and storing it
  // as a price means it can be quoted from. Contrast a product's
  // singleSupplementCents, where zero is the meaningful "no surcharge".
  if (!isMoneyCents(entry.amountCents) || entry.amountCents === 0) {
    problems.push(
      at + "amountCents must be a whole number of cents above 0; received " + describeValue(entry.amountCents)
    );
  }

  if (!RATE_UNITS.includes(entry.unit)) {
    problems.push(at + "unit must be one of " + RATE_UNITS.join(", "));
  }

  return problems;
}

// THE THREE CROSS-RECORD CHECKS - mismatches 2, 3 and 4 from the header. These
// are the ones that need to see both arrays at once, which is why they cannot
// live in either per-entry validator above.
//
// Runs on the entries that PASSED their own validation, because an entry whose
// contractRef is `undefined` cannot be a duplicate of anything and reporting it
// twice is noise.
function crossReferenceProblems(contracts, rates) {
  const problems = [];

  // Ref -> the contract's currency, for check 4 below. Built from contracts
  // whose ref is usable; a contract with a bad ref is already reported.
  const currencyByRef = new Map();
  const seen = new Set();
  const duplicates = new Set();

  contracts.forEach(function (entry) {
    if (!isPlainObject(entry) || !isNonBlankString(entry.contractRef)) {
      return;
    }
    const ref = normaliseRef(entry.contractRef);
    if (seen.has(ref)) {
      duplicates.add(ref);
    }
    seen.add(ref);
    // First one wins the currency lookup. With a duplicate ref present the
    // record is refused anyway, so which one it picked never reaches storage.
    if (!currencyByRef.has(ref)) {
      currencyByRef.set(ref, entry.currency);
    }
  });

  // MISMATCH 2: two contracts, one ref.
  if (duplicates.size > 0) {
    problems.push(
      "contracts: more than one contract uses the reference " + Array.from(duplicates).sort().join(", ")
    );
  }

  const orphans = new Set();
  const currencyClashes = new Set();

  rates.forEach(function (entry) {
    if (!isPlainObject(entry) || !isNonBlankString(entry.contractRef)) {
      return;
    }
    const ref = normaliseRef(entry.contractRef);
    if (!seen.has(ref)) {
      orphans.add(ref);
      return;
    }
    // MISMATCH 4: the rate's currency against its contract's. Only asked when
    // the rate's own currency is a known one - an unknown currency is already
    // reported by validateRate, and saying it also disagrees with the contract
    // is a second problem about one fault.
    if (CURRENCIES.includes(entry.currency) && entry.currency !== currencyByRef.get(ref)) {
      currencyClashes.add(ref);
    }
  });

  // MISMATCH 3: a price with no agreement behind it.
  if (orphans.size > 0) {
    problems.push(
      "rates: no contract on this supplier matches the reference " + Array.from(orphans).sort().join(", ")
    );
  }

  if (currencyClashes.size > 0) {
    problems.push(
      "rates: currency does not match the contract it is quoted under for " +
        Array.from(currencyClashes).sort().join(", ")
    );
  }

  return problems;
}

function validateContracts(contracts) {
  // A non-empty array, not an optional one. REQ-012 is "track supplier
  // information INCLUDING contracts and rates" - a supplier with no contract is
  // a lead, not a supplier, and letting one be saved means the contract field
  // is a suggestion. Recording a relationship before anything is signed is what
  // status: "draft" is for.
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return ["contracts must be a non-empty array of contract entries"];
  }
  if (contracts.length > MAX_CONTRACTS) {
    return ["contracts must have at most " + MAX_CONTRACTS + " entries"];
  }

  const problems = [];
  contracts.forEach(function (entry, index) {
    problems.push.apply(problems, validateContract(entry, index));
  });
  return problems;
}

function validateRates(rates) {
  // Rates MAY be empty, and that asymmetry with contracts is deliberate: an
  // agreement can be signed before its rate card is agreed, and refusing to
  // record the contract until then would push an advisor to invent a figure.
  if (!Array.isArray(rates)) {
    return ["rates must be an array of rate entries"];
  }
  if (rates.length > MAX_RATES) {
    return ["rates must have at most " + MAX_RATES + " entries"];
  }

  const problems = [];
  rates.forEach(function (entry, index) {
    problems.push.apply(problems, validateRate(entry, index));
  });
  return problems;
}

// Sorted by contractRef, trimmed, frozen. Called by the store AFTER validation,
// so it may assume the contracts are well-formed - it is a normaliser, not a
// second validator, and giving it validation of its own would create two
// answers to "is this contract legal?".
//
// Optional fields are normalised to null rather than left absent, so every
// stored contract has the same shape and a reader never has to ask whether a
// key is missing or empty.
function normaliseContracts(contracts) {
  return Object.freeze(
    contracts
      .map(function (entry) {
        return Object.freeze({
          contractRef: normaliseRef(entry.contractRef),
          startDate: entry.startDate,
          endDate: entry.endDate,
          currency: entry.currency,
          status: entry.status,
          notes: isNonBlankString(entry.notes) ? entry.notes.trim() : null,
        });
      })
      .sort(function (a, b) {
        return a.contractRef.localeCompare(b.contractRef);
      })
  );
}

// Same contract as normaliseContracts: post-validation, no decisions. Sorted by
// contractRef then description so that re-submitting the same rate card in a
// different order is correctly recognised as no change by the store's
// structural comparison.
function normaliseRates(rates) {
  return Object.freeze(
    rates
      .map(function (entry) {
        return Object.freeze({
          contractRef: normaliseRef(entry.contractRef),
          description: entry.description.trim(),
          currency: entry.currency,
          amountCents: entry.amountCents,
          unit: entry.unit,
        });
      })
      .sort(function (a, b) {
        const byRef = a.contractRef.localeCompare(b.contractRef);
        return byRef !== 0 ? byRef : a.description.localeCompare(b.description);
      })
  );
}

module.exports = {
  validateContracts,
  validateRates,
  crossReferenceProblems,
  normaliseContracts,
  normaliseRates,
  normaliseRef,
  isCalendarDate,
  CONTRACT_STATUSES,
  RATE_UNITS,
  CONTRACT_FIELDS,
  RATE_FIELDS,
  MAX_CONTRACTS,
  MAX_RATES,
  MAX_NOTES_LENGTH,
};
