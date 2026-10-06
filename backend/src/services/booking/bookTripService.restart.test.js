// Regression test for the restart bug found in the 000-019 audit (2026-10-05).
//
// Trip ids came from a per-process counter, so with COLABERRY_DATA_DIR set the
// first booking after a restart was issued TRIP-1 again: charged, then dropped
// by the CRM log (idempotent by tripId), invisible everywhere downstream. Each
// "restart" here is a separate Node process sharing one data directory, which
// is the only way to reproduce it - in one process the counter never resets.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// Books in a fresh process and prints the result plus the CRM log it sees.
function bookInNewProcess(dir, customerId, idempotencyKey) {
  const snippet =
    'const { bookTrip } = require("./backend/src/services/booking/bookTripService");' +
    'const { getLoggedTransactions } = require("./backend/src/services/booking/crmTransactionLog");' +
    "(async () => {" +
    "  const r = await bookTrip({ customerId: " + JSON.stringify(customerId) +
    ', flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300", idempotencyKey: ' + JSON.stringify(idempotencyKey) + " });" +
    "  process.stdout.write(JSON.stringify({ status: r.status, tripId: r.tripId, replayed: r.replayed," +
    "    rows: getLoggedTransactions().map((t) => t.tripId + '=' + t.customerId) }));" +
    "})();";
  const out = execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir, COLABERRY_ACCOUNTING_API_TOKEN: "test-token-not-a-secret" }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-restart-"));
try {
  // The bug: two bookings in two processes must get two trip ids and two rows.
  const first = bookInNewProcess(dir, "CUST-RESTART-A", "restart-test-key-A");
  const second = bookInNewProcess(dir, "CUST-RESTART-B", "restart-test-key-B");
  assert.strictEqual(first.status, "confirmed");
  assert.strictEqual(second.status, "confirmed");
  assert.notStrictEqual(second.tripId, first.tripId, "a booking after a restart must not reuse a trip id");
  assert.deepStrictEqual(second.rows.sort(), [first.tripId + "=CUST-RESTART-A", second.tripId + "=CUST-RESTART-B"].sort(),
    "both bookings are in the CRM log");
  console.log("bookTripService restart: a booking after a restart gets its own trip id and is recorded");

  // The related gap: a retry after a restart replays, it does not book again.
  const retry = bookInNewProcess(dir, "CUST-RESTART-A", "restart-test-key-A");
  assert.strictEqual(retry.status, "confirmed");
  assert.strictEqual(retry.replayed, true, "the replay survives a restart");
  assert.strictEqual(retry.tripId, first.tripId, "the same booking keeps the same trip id");
  assert.strictEqual(retry.rows.length, 2, "no extra row from the retry");
  console.log("bookTripService restart: a retry after a restart replays the original trip");

  // And the key still cannot be borrowed for someone else's booking.
  const borrowed = bookInNewProcess(dir, "CUST-RESTART-INTRUDER", "restart-test-key-A");
  assert.strictEqual(borrowed.status, "idempotency_conflict", "key reuse is caught after a restart too");
  assert.strictEqual(borrowed.rows.length, 2);
  console.log("bookTripService restart: a reused key is still refused after a restart");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("bookTripService restart: all tests passed");
