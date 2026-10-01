// STORY-010: who a supplier IS, and whether the record as a whole holds up.
// Pure, deterministic, no I/O, no clock, no store.
//
// WHAT THIS MODULE OWNS, AND WHAT IT DELEGATES. It owns supplier identity -
// name, country, type, how to reach them - and the ORCHESTRATION of a whole
// record: run the identity checks, run the commercial checks, run the
// cross-record checks, return one list. It does NOT own contracts or rates;
// supplierContracts.js owns those, including every date rule, every money rule,
// and all four forms of the story's "data mismatch" failure path. See that
// file's header for what a mismatch is and why each one is refused.
//
// The split is by question, not by size: "is this the right supplier?" and "do
// these terms hold up?" are asked by different people at different times. The
// dependency runs one way - this file imports supplierContracts.js and not the
// reverse - so the commercial half can be tested without ever constructing a
// supplier.
//
// WHY THIS IS SEPARATE FROM THE STORE. REQ-012 asks the system to track
// suppliers "including contracts and rates", and the hard part of that is not
// storage - it is whether the parts AGREE with each other. That is a question
// about a RECORD, answerable without a filesystem, so it lives here and can be
// tested exhaustively. The store then has exactly one job: write the thing down
// and audit that it happened. Same split as
// products/safariProductValidation.js against products/safariProductStore.js,
// and quotes/quotePricing.js against quotes/quoteStore.js, for the same reason.
//
// THE SMALL PREDICATES BELOW ARE RESTATED, NOT SHARED, for the reason given in
// supplierContracts.js's header: they are three-line predicates, every other
// validation module in this repo carries its own copy, and a shared
// "validation utils" module becomes a magnet for things that are not utilities.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns a LIST OF PROBLEMS and never a
//     partial supplier. There is no throw path: every input here arrives from
//     an HTTP body and must become a 400, not a 500.
//  2. Will it retry? Nothing to retry. Pure function of its arguments.
//  3. Recovery path? The problem list names every fault at once - identity,
//     contracts and rates together - so an advisor fixes the whole form in one
//     submission instead of discovering faults one at a time.
//  4. Handled here: missing/blank/over-long text, unknown supplier types, a
//     supplier with no way to be contacted, a non-address in the email field,
//     non-object and non-array shapes, and prototype-chain keys. Delegated to
//     supplierContracts.js: everything about contracts and rates. NOT handled
//     anywhere: whether the supplier's country is one the agency actually sells
//     (a cross-record question, and this module only sees one record), and
//     whether the business exists at all - no registry is integrated.

const {
  validateContracts,
  validateRates,
  crossReferenceProblems,
  MAX_NOTES_LENGTH,
} = require("./supplierContracts");

// What kind of business this is. An allow-list rather than free text, because
// "lodge" / "Lodge" / "lodging" typed into a free field gives you three
// supplier types and no way to filter by any of them.
const SUPPLIER_TYPES = Object.freeze([
  "lodge",
  "transport",
  "guide",
  "tour_operator",
  "other",
]);

const SUPPLIER_FIELDS = Object.freeze([
  "name",
  "country",
  "supplierType",
  "contactEmail",
  "contactPhone",
  "notes",
  "contracts",
  "rates",
]);

const MAX_NAME_LENGTH = 160;
const MAX_COUNTRY_LENGTH = 80;
const MAX_CONTACT_LENGTH = 200;

// Describes the SHAPE of a bad value, never the value itself. A supplier record
// carries contact details and prose written by a person, and these strings end
// up in an HTTP response and in log lines. Same rule as quotePricing.js's and
// safariProductValidation.js's describeValue.
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

// Deliberately permissive: something@something.something, no spaces. A stricter
// pattern rejects real addresses (plus-addressing, new TLDs, long subdomains)
// and the cost of that is an advisor who cannot save a supplier that exists.
// This catches the fault that actually occurs - a phone number or a name typed
// into the email box - and leaves deliverability to the thing that sends mail.
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// The supplier's identity half: who they are and how to reach them.
function validateIdentity(candidate) {
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

  if (!SUPPLIER_TYPES.includes(candidate.supplierType)) {
    problems.push("supplierType must be one of " + SUPPLIER_TYPES.join(", "));
  }

  // Both contact fields are optional INDIVIDUALLY but at least one is required.
  // A supplier nobody can reach cannot be chased when a booking goes wrong,
  // which is the entire reason an advisor opens this record at 6am.
  const hasEmail = candidate.contactEmail !== undefined && candidate.contactEmail !== null;
  const hasPhone = candidate.contactPhone !== undefined && candidate.contactPhone !== null;

  if (hasEmail) {
    if (!isNonBlankString(candidate.contactEmail)) {
      problems.push("contactEmail must be a non-empty string when present");
    } else if (candidate.contactEmail.trim().length > MAX_CONTACT_LENGTH) {
      problems.push("contactEmail must be at most " + MAX_CONTACT_LENGTH + " characters");
    } else if (!looksLikeEmail(candidate.contactEmail.trim())) {
      problems.push("contactEmail must look like an email address");
    }
  }

  if (hasPhone) {
    if (!isNonBlankString(candidate.contactPhone)) {
      problems.push("contactPhone must be a non-empty string when present");
    } else if (candidate.contactPhone.trim().length > MAX_CONTACT_LENGTH) {
      problems.push("contactPhone must be at most " + MAX_CONTACT_LENGTH + " characters");
    }
  }

  if (!hasEmail && !hasPhone) {
    problems.push("at least one of contactEmail or contactPhone is required");
  }

  if (candidate.notes !== undefined && candidate.notes !== null) {
    if (typeof candidate.notes !== "string") {
      problems.push("notes must be a string when present");
    } else if (candidate.notes.length > MAX_NOTES_LENGTH) {
      problems.push("notes must be at most " + MAX_NOTES_LENGTH + " characters");
    }
  }

  return problems;
}

// The whole supplier. Returns [] when it is well-formed.
//
// A LIST, NOT THE FIRST FAULT. A supplier with four contracts, two bad dates
// and an orphan rate should take one round trip to fix, not four.
function validateSupplier(candidate) {
  if (!isPlainObject(candidate)) {
    return ["supplier must be an object; received " + describeValue(candidate)];
  }

  const problems = unknownFieldProblems(candidate, SUPPLIER_FIELDS, "supplier: ");

  problems.push.apply(problems, validateIdentity(candidate));
  problems.push.apply(problems, validateContracts(candidate.contracts));
  problems.push.apply(problems, validateRates(candidate.rates));

  // The cross-record checks need both arrays to BE arrays; when either is not,
  // its own validator has already said so and there is nothing to cross-check.
  if (Array.isArray(candidate.contracts) && Array.isArray(candidate.rates)) {
    problems.push.apply(problems, crossReferenceProblems(candidate.contracts, candidate.rates));
  }

  return problems;
}

module.exports = {
  validateSupplier,
  validateIdentity,
  looksLikeEmail,
  SUPPLIER_TYPES,
  SUPPLIER_FIELDS,
  MAX_NAME_LENGTH,
  MAX_COUNTRY_LENGTH,
  MAX_CONTACT_LENGTH,
};
