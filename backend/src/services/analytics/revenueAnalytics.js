// STORY-012: revenue and booking trends, worked out from booking-log rows.
// PURE - no store, no clock, no I/O - so the arithmetic can be tested on its
// own. analyticsService.js reads the rows and writes the audit entry; this file
// only decides what the rows say.
//
// ONE ROW IS ONE PERSON'S TRIP. The rows are the CRM booking log
// (crmTransactionLog.js): bookTripService writes one per trip, and
// groupBookingService writes one per group MEMBER carrying that member's SHARE
// in amountCents, never the group total. So summing amountCents is revenue and
// counting rows is bookings, with no group double-counting to undo here.
//
// AN INCOMPLETE ROW IS LEFT OUT AND NAMED, NEVER GUESSED. A row without a date
// cannot be put in a month; a row without an amount would read as $0 and drag
// the trend down silently. Either way the manager is told which row and which
// field (missingData), and the result says "partial" so the chart is not taken
// as the whole picture (acceptance criterion 2).
//
// A DATA MISMATCH WITHHOLDS REVENUE RATHER THAN MISSTATING IT. Two currencies
// cannot be added, and the same tripId twice means the log disagrees with
// itself. A duplicate is excluded from both figures (counting it would book
// one trip twice). Mixed currencies withhold revenue (null) but keep booking
// counts, which stay true whatever the currency.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Nothing throws. Bad input returns
//     status "no_data" with the reason, so the caller still has a result.
//  2. Will it retry? Nothing to retry - this is arithmetic.
//  3. Recovery? Not applicable; the caller reports the status it is given.
//  4. Handled: no rows, a non-array input, rows missing or with invalid
//     tripId / bookedAt / amountCents / currency, duplicate tripIds, mixed
//     currencies, months with no bookings (shown as zero, so the trend line
//     does not skip them). NOT handled: currency conversion, refunds
//     (a separate entryType), and cancellations - the log row records the
//     booking as sold, which is what revenue-booked means.

const STATUSES = Object.freeze(["complete", "partial", "mismatch", "no_data"]);
const REQUIRED_FIELDS = Object.freeze(["tripId", "bookedAt", "amountCents", "currency"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isValidField(field, value) {
  if (field === "tripId") return typeof value === "string" && value.trim() !== "";
  if (field === "bookedAt") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (field === "amountCents") return Number.isSafeInteger(value) && value >= 0;
  return typeof value === "string" && CURRENCY_PATTERN.test(value);
}

// The fields a row is missing or carries in a shape that cannot be counted.
function problemFields(row) {
  if (row === null || typeof row !== "object") return REQUIRED_FIELDS.slice();
  return REQUIRED_FIELDS.filter(function (field) {
    return !isValidField(field, row[field]);
  });
}

// "2026-09" in UTC, so the same booking lands in the same month on every server.
function monthOf(isoDate) {
  return new Date(isoDate).toISOString().slice(0, 7);
}

function nextMonth(month) {
  const [year, mon] = month.split("-").map(Number);
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
}

// Every month from the first booking to the last, empty ones included, so a
// quiet month shows as a dip rather than vanishing from the chart.
function buildTrend(rows, withRevenue) {
  const byMonth = new Map();
  rows.forEach(function (row) {
    const month = monthOf(row.bookedAt);
    const bucket = byMonth.get(month) || { bookings: 0, revenueCents: 0 };
    bucket.bookings += 1;
    bucket.revenueCents += row.amountCents;
    byMonth.set(month, bucket);
  });
  const months = Array.from(byMonth.keys()).sort();
  const trend = [];
  for (let month = months[0]; month <= months[months.length - 1]; month = nextMonth(month)) {
    const bucket = byMonth.get(month) || { bookings: 0, revenueCents: 0 };
    trend.push({
      month,
      bookings: bucket.bookings,
      revenueCents: withRevenue ? bucket.revenueCents : null,
    });
  }
  return trend;
}

// Splits the rows into the ones that can be counted and the reasons the rest
// cannot. Order is preserved, so the FIRST row with a tripId is the one kept.
function classifyRows(rows) {
  const usable = [];
  const missingData = [];
  const mismatches = [];
  const seenTripIds = new Set();
  rows.forEach(function (row, index) {
    const fields = problemFields(row);
    const recordId = fields.includes("tripId") ? `row ${index}` : row.tripId;
    if (fields.length > 0) {
      missingData.push({ recordId, fields });
      return;
    }
    if (seenTripIds.has(row.tripId)) {
      mismatches.push({ type: "duplicate_trip", recordId: row.tripId });
      return;
    }
    seenTripIds.add(row.tripId);
    usable.push(row);
  });
  return { usable, missingData, mismatches };
}

function emptyResult(totalRecords, reason, missingData) {
  return {
    status: "no_data",
    reason,
    currency: null,
    totals: { bookings: 0, revenueCents: null },
    trend: [],
    coverage: { totalRecords, includedRecords: 0 },
    missingData,
    mismatches: [],
  };
}

function generateRevenueAnalytics(rows) {
  if (!Array.isArray(rows)) {
    return emptyResult(0, "booking data was not a list of records", []);
  }
  if (rows.length === 0) {
    return emptyResult(0, "no bookings have been recorded yet", []);
  }

  const { usable, missingData, mismatches } = classifyRows(rows);
  if (usable.length === 0) {
    return emptyResult(rows.length, "no booking record was complete enough to count", missingData);
  }

  const currencies = Array.from(new Set(usable.map((row) => row.currency))).sort();
  if (currencies.length > 1) {
    mismatches.push({ type: "mixed_currency", currencies });
  }
  const singleCurrency = currencies.length === 1;

  let status = "complete";
  if (mismatches.length > 0) status = "mismatch";
  else if (missingData.length > 0) status = "partial";

  return {
    status,
    reason: null,
    currency: singleCurrency ? currencies[0] : null,
    totals: {
      bookings: usable.length,
      revenueCents: singleCurrency ? usable.reduce((sum, row) => sum + row.amountCents, 0) : null,
    },
    trend: buildTrend(usable, singleCurrency),
    coverage: { totalRecords: rows.length, includedRecords: usable.length },
    missingData,
    mismatches,
  };
}

module.exports = { generateRevenueAnalytics, STATUSES, REQUIRED_FIELDS };
