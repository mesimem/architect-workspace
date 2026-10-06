// STORY-012, the use case around the arithmetic. Covers the trust criterion
// ("the system logs all analytics generation activities") and the failure
// paths "analytics not generated" and "data mismatch" end to end.
//
// The first section uses a REAL booking made through bookTrip, so the test
// proves analytics read the same log the booking path writes. Everything after
// it injects fake sources, because an unreadable log or a broken audit store
// cannot be produced by booking trips properly.

const assert = require("assert");

const { bookTrip } = require("../booking/bookTripService");
const { findAuditEntry, getAuditEntries } = require("../audit/auditLog");
const { generateAnalytics, FAILURE_REASONS, AUDIT_EVENT } = require("./analyticsService");

function analyticsEntries() {
  return getAuditEntries().filter((entry) => entry.event === AUDIT_EVENT);
}

function row(tripId, amountCents) {
  return { tripId, bookedAt: "2026-09-10T12:00:00.000Z", amountCents, currency: "USD" };
}

async function main() {
  // AC1 against a real booking: what bookTrip writes, analytics can see.
  const booked = await bookTrip({
    customerId: "CUST-ANALYTICS-1",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "analytics-real-booking-0001",
  });
  assert.strictEqual(booked.status, "confirmed", JSON.stringify(booked));
  const real = generateAnalytics({ actor: "manager-1", correlationId: "corr-real-0001" });
  assert.strictEqual(real.ok, true);
  assert.ok(real.analytics.totals.bookings >= 1);
  const month = booked.bookedAt.slice(0, 7);
  assert.ok(real.analytics.trend.some((point) => point.month === month && point.bookings >= 1));
  console.log("analyticsService: a real booking appears in the trend");

  // AC3: the generation is audited with who, what and how complete.
  const entry = findAuditEntry("analytics-revenue:corr-real-0001");
  assert.ok(entry, "generation must leave an audit entry");
  assert.strictEqual(entry.event, AUDIT_EVENT);
  assert.strictEqual(entry.outcome, "success");
  assert.strictEqual(entry.actor, "manager-1");
  assert.strictEqual(entry.context.status, real.analytics.status);
  assert.strictEqual(typeof entry.context.durationMs, "number");
  console.log("analyticsService: every generation is audited");

  // Idempotent: a retried request with the same correlation id is one entry.
  const before = analyticsEntries().length;
  generateAnalytics({ actor: "manager-1", correlationId: "corr-real-0001" });
  assert.strictEqual(analyticsEntries().length, before);
  console.log("analyticsService: a retried request does not double-audit");

  // AC2 through the service: incomplete data is highlighted and audited as such.
  const partial = generateAnalytics(
    { actor: "manager-1", correlationId: "corr-partial-0001" },
    { readBookings: () => [row("TRIP-A", 1000), { tripId: "TRIP-B", currency: "USD" }] }
  );
  assert.strictEqual(partial.analytics.status, "partial");
  assert.deepStrictEqual(partial.analytics.missingData, [
    { recordId: "TRIP-B", fields: ["bookedAt", "amountCents"] },
  ]);
  const partialEntry = findAuditEntry("analytics-revenue:corr-partial-0001");
  assert.strictEqual(partialEntry.context.status, "partial");
  assert.strictEqual(partialEntry.context.missingDataCount, 1);
  console.log("analyticsService: missing data is highlighted and audited");

  // Failure path "data mismatch": surfaced, not hidden.
  const mismatch = generateAnalytics(
    { actor: "manager-1", correlationId: "corr-mismatch-0001" },
    { readBookings: () => [row("TRIP-A", 1000), row("TRIP-A", 1000)] }
  );
  assert.strictEqual(mismatch.analytics.status, "mismatch");
  assert.strictEqual(findAuditEntry("analytics-revenue:corr-mismatch-0001").context.mismatchCount, 1);
  console.log("analyticsService: a data mismatch is reported and audited");

  // Failure path "analytics not generated": the source cannot be read. Still audited.
  const unreadable = generateAnalytics(
    { actor: "manager-1", correlationId: "corr-noread-0001" },
    {
      readBookings: () => {
        throw new Error("disk unavailable");
      },
    }
  );
  assert.deepStrictEqual(unreadable, {
    ok: false,
    reason: FAILURE_REASONS.SOURCE_UNAVAILABLE,
    correlationId: "corr-noread-0001",
  });
  const failedEntry = findAuditEntry("analytics-revenue:corr-noread-0001");
  assert.strictEqual(failedEntry.outcome, "failure");
  assert.strictEqual(failedEntry.context.reason, FAILURE_REASONS.SOURCE_UNAVAILABLE);
  console.log("analyticsService: a failed generation is audited too");

  // No audit entry, no analytics: a broken audit store withholds the figures.
  const unaudited = generateAnalytics(
    { actor: "manager-1", correlationId: "corr-noaudit-0001" },
    {
      readBookings: () => [row("TRIP-A", 1000)],
      recordAudit: () => {
        throw new Error("audit store full");
      },
    }
  );
  assert.strictEqual(unaudited.ok, false);
  assert.strictEqual(unaudited.reason, FAILURE_REASONS.AUDIT_UNAVAILABLE);
  assert.strictEqual(unaudited.analytics, undefined);
  console.log("analyticsService: unaudited analytics are never returned");

  // A malformed request is refused before anything is read or audited.
  let read = false;
  const countBefore = analyticsEntries().length;
  const invalid = generateAnalytics(
    { actor: "", correlationId: "short" },
    {
      readBookings: () => {
        read = true;
        return [];
      },
    }
  );
  assert.strictEqual(invalid.reason, FAILURE_REASONS.INVALID_REQUEST);
  assert.strictEqual(invalid.problems.length, 2);
  assert.strictEqual(read, false);
  assert.strictEqual(analyticsEntries().length, countBefore);
  assert.strictEqual(generateAnalytics().reason, FAILURE_REASONS.INVALID_REQUEST);
  console.log("analyticsService: malformed requests are refused up front");

  console.log("analyticsService: all tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
