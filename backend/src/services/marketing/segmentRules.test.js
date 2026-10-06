// STORY-019: the segment rule, with no store and no server.
const assert = require("assert");
const { validateSegment, normaliseCriteria, matchCustomers } = require("./segmentRules");

const customers = [
  { customerId: "C-RECENT-BIG", bookingCount: 3, lifetimeValueCents: 1500000, lastBookedAt: "2026-09-20T10:00:00.000Z" },
  { customerId: "C-OLD-ONE", bookingCount: 1, lifetimeValueCents: 449000, lastBookedAt: "2026-06-01T10:00:00.000Z" },
  { customerId: "C-NO-DATE", bookingCount: 2, lifetimeValueCents: 900000, lastBookedAt: null },
];
const ids = (list) => list.map((c) => c.customerId);

// Happy path: each criterion narrows, and they AND together.
assert.deepStrictEqual(ids(matchCustomers(customers, { minBookings: 2 })), ["C-RECENT-BIG", "C-NO-DATE"]);
assert.deepStrictEqual(ids(matchCustomers(customers, { minLifetimeValueCents: 1000000 })), ["C-RECENT-BIG"]);
assert.deepStrictEqual(ids(matchCustomers(customers, { lastBookedAfter: "2026-09-01" })), ["C-RECENT-BIG"]);
assert.deepStrictEqual(ids(matchCustomers(customers, { lastBookedBefore: "2026-07-01" })), ["C-OLD-ONE"]);
assert.deepStrictEqual(ids(matchCustomers(customers, { minBookings: 2, lastBookedAfter: "2026-09-01" })), ["C-RECENT-BIG"]);
console.log("segmentRules: each criterion narrows the segment, and they combine");

// Boundaries: an empty rule is everyone; limits are inclusive; no date fails a date rule.
assert.strictEqual(matchCustomers(customers, {}).length, 3, "an empty rule matches every customer");
assert.deepStrictEqual(ids(matchCustomers(customers, { minBookings: 3 })), ["C-RECENT-BIG"], "minBookings is inclusive");
assert.deepStrictEqual(ids(matchCustomers(customers, { lastBookedAfter: "2026-09-20T10:00:00.000Z" })), ["C-RECENT-BIG"], "after is inclusive");
assert.ok(!ids(matchCustomers(customers, { lastBookedBefore: "2030-01-01" })).includes("C-NO-DATE"), "unknown date is not recent or old");
assert.deepStrictEqual(matchCustomers([], { minBookings: 1 }), [], "no customers, empty segment");
assert.deepStrictEqual(matchCustomers([null, { bookingCount: 5 }], {}), [], "rows without a customerId are skipped");
console.log("segmentRules: empty rules, inclusive limits and missing dates behave");

// Failure paths: malformed input is refused by field, unknown criteria by name.
assert.deepStrictEqual(validateSegment({ name: "Repeat travellers", criteria: { minBookings: 2 } }), []);
assert.deepStrictEqual(validateSegment({ name: "Everyone" }), [], "criteria may be omitted");
assert.strictEqual(validateSegment(null)[0].field, "segment");
assert.strictEqual(validateSegment([])[0].field, "segment");
assert.ok(validateSegment({ name: "" }).some((p) => p.field === "name"));
assert.ok(validateSegment({ name: "x".repeat(121) }).some((p) => p.field === "name"), "name has a maximum length");
assert.ok(validateSegment({ name: "Typo", criteria: { minBooking: 2 } }).some((p) => p.field === "criteria.minBooking"), "a typo is an error, not a match-all");
assert.ok(validateSegment({ name: "Neg", criteria: { minBookings: -1 } }).some((p) => p.field === "criteria.minBookings"));
assert.ok(validateSegment({ name: "Frac", criteria: { minLifetimeValueCents: 1.5 } }).some((p) => p.field === "criteria.minLifetimeValueCents"));
assert.ok(validateSegment({ name: "Date", criteria: { lastBookedAfter: "last week" } }).some((p) => p.field === "criteria.lastBookedAfter"));
assert.ok(validateSegment({ name: "Order", criteria: { lastBookedAfter: "2026-09-01", lastBookedBefore: "2026-08-01" } })
  .some((p) => p.field === "criteria"), "an impossible date window is refused");
assert.ok(validateSegment({ name: "Arr", criteria: [] }).some((p) => p.field === "criteria"));
console.log("segmentRules: malformed segments are refused field by field");

// Only known criteria are stored.
assert.deepStrictEqual(normaliseCriteria({ minBookings: 2, extra: "x" }), { minBookings: 2 });
console.log("segmentRules: all tests passed");
