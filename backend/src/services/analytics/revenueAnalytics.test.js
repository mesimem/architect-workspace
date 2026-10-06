// STORY-012, the arithmetic. Every expected figure is WRITTEN OUT BY HAND, not
// recomputed from the implementation's formula, so a wrong formula fails here.

const assert = require("assert");

const { generateRevenueAnalytics } = require("./revenueAnalytics");

function booking(tripId, bookedAt, amountCents, currency) {
  return { tripId, customerId: "CUST-1", bookedAt, amountCents, currency: currency || "USD" };
}

function main() {
  // Happy path (AC1): trends by month, with the quiet month in between kept.
  const full = generateRevenueAnalytics([
    booking("TRIP-1", "2026-07-03T10:00:00.000Z", 500000),
    booking("TRIP-2", "2026-07-20T10:00:00.000Z", 250000),
    booking("TRIP-3", "2026-09-01T00:00:00.000Z", 120000),
  ]);
  assert.strictEqual(full.status, "complete");
  assert.strictEqual(full.currency, "USD");
  assert.deepStrictEqual(full.totals, { bookings: 3, revenueCents: 870000 });
  assert.deepStrictEqual(full.trend, [
    { month: "2026-07", bookings: 2, revenueCents: 750000 },
    { month: "2026-08", bookings: 0, revenueCents: 0 },
    { month: "2026-09", bookings: 1, revenueCents: 120000 },
  ]);
  assert.deepStrictEqual(full.coverage, { totalRecords: 3, includedRecords: 3 });
  assert.deepStrictEqual(full.missingData, []);
  console.log("revenueAnalytics: revenue and booking trends by month");

  // Year boundary: December rolls into January, not month 13.
  const yearEnd = generateRevenueAnalytics([
    booking("TRIP-1", "2026-12-31T23:00:00.000Z", 100),
    booking("TRIP-2", "2027-02-01T00:00:00.000Z", 200),
  ]);
  assert.deepStrictEqual(
    yearEnd.trend.map((point) => point.month),
    ["2026-12", "2027-01", "2027-02"]
  );
  console.log("revenueAnalytics: the trend crosses a year boundary");

  // AC2: incomplete rows are left out AND named, and the result says partial.
  const partial = generateRevenueAnalytics([
    booking("TRIP-1", "2026-07-03T10:00:00.000Z", 500000),
    { tripId: "TRIP-2", amountCents: 250000, currency: "USD" }, // no date
    booking("TRIP-3", "2026-07-04T10:00:00.000Z", undefined), // no amount
    booking("TRIP-4", "not a date", -5), // invalid date and negative amount
    { bookedAt: "2026-07-05T10:00:00.000Z", amountCents: 100, currency: "USD" }, // no id
  ]);
  assert.strictEqual(partial.status, "partial");
  assert.deepStrictEqual(partial.totals, { bookings: 1, revenueCents: 500000 });
  assert.deepStrictEqual(partial.coverage, { totalRecords: 5, includedRecords: 1 });
  assert.deepStrictEqual(partial.missingData, [
    { recordId: "TRIP-2", fields: ["bookedAt"] },
    { recordId: "TRIP-3", fields: ["amountCents"] },
    { recordId: "TRIP-4", fields: ["bookedAt", "amountCents"] },
    { recordId: "row 4", fields: ["tripId"] },
  ]);
  console.log("revenueAnalytics: incomplete records are highlighted, not guessed");

  // A $0 booking is real data (a comped trip), not missing data.
  assert.strictEqual(
    generateRevenueAnalytics([booking("TRIP-1", "2026-07-03T10:00:00.000Z", 0)]).status,
    "complete"
  );

  // Data mismatch: a duplicate tripId is counted once and reported.
  const duplicate = generateRevenueAnalytics([
    booking("TRIP-1", "2026-07-03T10:00:00.000Z", 500000),
    booking("TRIP-1", "2026-07-03T10:00:00.000Z", 500000),
  ]);
  assert.strictEqual(duplicate.status, "mismatch");
  assert.deepStrictEqual(duplicate.totals, { bookings: 1, revenueCents: 500000 });
  assert.deepStrictEqual(duplicate.mismatches, [{ type: "duplicate_trip", recordId: "TRIP-1" }]);
  console.log("revenueAnalytics: a duplicated trip is counted once and flagged");

  // Data mismatch: mixed currencies withhold revenue but keep booking counts.
  const mixed = generateRevenueAnalytics([
    booking("TRIP-1", "2026-07-03T10:00:00.000Z", 500000, "USD"),
    booking("TRIP-2", "2026-07-04T10:00:00.000Z", 900000, "KES"),
  ]);
  assert.strictEqual(mixed.status, "mismatch");
  assert.strictEqual(mixed.currency, null);
  assert.deepStrictEqual(mixed.totals, { bookings: 2, revenueCents: null });
  assert.deepStrictEqual(mixed.trend, [{ month: "2026-07", bookings: 2, revenueCents: null }]);
  assert.deepStrictEqual(mixed.mismatches, [{ type: "mixed_currency", currencies: ["KES", "USD"] }]);
  console.log("revenueAnalytics: mixed currencies are never added together");

  // No data: an empty log, a broken input, and a log with nothing countable.
  const empty = generateRevenueAnalytics([]);
  assert.strictEqual(empty.status, "no_data");
  assert.deepStrictEqual(empty.trend, []);
  assert.strictEqual(empty.totals.revenueCents, null); // not a fake $0
  assert.strictEqual(generateRevenueAnalytics(undefined).status, "no_data");
  assert.strictEqual(generateRevenueAnalytics("rows").status, "no_data");
  const nothingCountable = generateRevenueAnalytics([null, { tripId: "TRIP-9" }]);
  assert.strictEqual(nothingCountable.status, "no_data");
  assert.strictEqual(nothingCountable.missingData.length, 2);
  console.log("revenueAnalytics: no data is reported as no data, not as zero");

  // Deterministic: the same rows give the same answer, and the input is untouched.
  const rows = [booking("TRIP-1", "2026-07-03T10:00:00.000Z", 500000)];
  const snapshot = JSON.stringify(rows);
  assert.deepStrictEqual(generateRevenueAnalytics(rows), generateRevenueAnalytics(rows));
  assert.strictEqual(JSON.stringify(rows), snapshot);
  console.log("revenueAnalytics: repeatable and read-only");

  console.log("revenueAnalytics: all tests passed");
}

main();
