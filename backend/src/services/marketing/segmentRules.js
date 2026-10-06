// STORY-019: what a customer segment IS, and who matches one. Pure - no
// store, no clock, no I/O - so the matching rule is tested without a server.
//
// A SEGMENT IS A RULE OVER THE CRM, NOT A LIST. The customers it matches are
// computed from crm/customerRecord.listCustomers() every time it is read, so a
// customer who books tomorrow joins the segment tomorrow with nothing to keep
// in step. Storing the member list would be a second answer to "who has
// booked", which is exactly what customerRecord.js refuses to keep.
//
// WHO CAN BE IN ONE. Only customers - someone with at least one booking (the
// definition in customerRecord.js). Leads are not marketed to here: they have
// not bought, and the acceptance criterion is about customers with history.
//
// THE CRITERIA, ALL OPTIONAL, ALL ANDED:
//   minBookings             at least this many bookings
//   minLifetimeValueCents   at least this much booked, in cents
//   lastBookedAfter         last booking on or after this ISO date
//   lastBookedBefore        last booking before this ISO date
// An empty rule matches every customer, deliberately: "everyone who has
// booked" is a real segment. It is still a rule the sales manager wrote down.

const MAX_NAME_LENGTH = 120;
const MAX_COUNT = 100000;
const MAX_CENTS = 1000000000000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/;

const CRITERIA_FIELDS = Object.freeze([
  "minBookings",
  "minLifetimeValueCents",
  "lastBookedAfter",
  "lastBookedBefore",
]);

function isDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function isCount(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

// Returns a list of { field, problem }; empty means valid. Unknown fields are
// refused by name rather than ignored, so a typo ("minBooking") is an error
// instead of a rule that silently matches everyone.
function validateSegment(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [{ field: "segment", problem: "must be an object" }];
  }
  const problems = [];
  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > MAX_NAME_LENGTH) {
    problems.push({ field: "name", problem: "must be a non-empty string of at most " + MAX_NAME_LENGTH + " characters" });
  }
  const criteria = input.criteria === undefined ? {} : input.criteria;
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    problems.push({ field: "criteria", problem: "must be an object" });
    return problems;
  }
  Object.keys(criteria).forEach(function (key) {
    if (!CRITERIA_FIELDS.includes(key)) {
      problems.push({ field: "criteria." + key, problem: "is not a known criterion (" + CRITERIA_FIELDS.join(", ") + ")" });
    }
  });
  if (criteria.minBookings !== undefined && !isCount(criteria.minBookings, MAX_COUNT)) {
    problems.push({ field: "criteria.minBookings", problem: "must be a whole number from 0 to " + MAX_COUNT });
  }
  if (criteria.minLifetimeValueCents !== undefined && !isCount(criteria.minLifetimeValueCents, MAX_CENTS)) {
    problems.push({ field: "criteria.minLifetimeValueCents", problem: "must be a whole number of cents from 0" });
  }
  ["lastBookedAfter", "lastBookedBefore"].forEach(function (field) {
    if (criteria[field] !== undefined && !isDate(criteria[field])) {
      problems.push({ field: "criteria." + field, problem: "must be an ISO 8601 date" });
    }
  });
  if (isDate(criteria.lastBookedAfter) && isDate(criteria.lastBookedBefore) &&
      Date.parse(criteria.lastBookedAfter) >= Date.parse(criteria.lastBookedBefore)) {
    problems.push({ field: "criteria", problem: "lastBookedAfter must be earlier than lastBookedBefore" });
  }
  return problems;
}

// The stored shape: only known fields, so nothing unvalidated is persisted.
function normaliseCriteria(criteria) {
  const out = {};
  CRITERIA_FIELDS.forEach(function (field) {
    if (criteria && criteria[field] !== undefined) out[field] = criteria[field];
  });
  return Object.freeze(out);
}

function matches(customer, criteria) {
  if (criteria.minBookings !== undefined && customer.bookingCount < criteria.minBookings) return false;
  if (criteria.minLifetimeValueCents !== undefined && customer.lifetimeValueCents < criteria.minLifetimeValueCents) return false;
  const last = customer.lastBookedAt ? Date.parse(customer.lastBookedAt) : NaN;
  if (criteria.lastBookedAfter !== undefined && !(last >= Date.parse(criteria.lastBookedAfter))) return false;
  if (criteria.lastBookedBefore !== undefined && !(last < Date.parse(criteria.lastBookedBefore))) return false;
  return true;
}

// Customers matching the rule, in the order listCustomers gives them (most
// recently active first). A customer with no booking date fails any date
// criterion rather than passing it - "unknown" is not "recent".
function matchCustomers(customers, criteria) {
  return customers.filter(function (customer) {
    return customer && typeof customer.customerId === "string" && matches(customer, criteria || {});
  });
}

module.exports = { validateSegment, normaliseCriteria, matchCustomers, CRITERIA_FIELDS };
