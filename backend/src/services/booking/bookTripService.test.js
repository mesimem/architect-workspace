// STORY-004: the booking path now posts to the accounting software. A test
// token keeps that deterministic instead of depending on the developer's
// environment - with no token configured the client refuses to post, which
// would make these assertions pass or fail for the wrong reason.
process.env.COLABERRY_ACCOUNTING_API_TOKEN = "test-token-not-a-secret";

const assert = require("assert");
const { bookTrip } = require("./bookTripService");
const { logTransaction, getLoggedTransactions } = require("./crmTransactionLog");
const { getLedger } = require("../accounting/accountingClient");
const { accountingAuditKey } = require("../accounting/transactionRecorder");
const { findAuditEntry, deriveAuditKey } = require("../audit/auditLog");

// bookTrip() is async as of STORY-003 (an unavailable selection is routed to
// a travel advisor), so the whole suite runs inside one async main().
async function main() {

  // Happy path: all three legs available -> one confirmed trip covering all three.
  const booking = await bookTrip({
    customerId: "CUST-1",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0001",
  });

  assert.strictEqual(booking.status, "confirmed");
  assert.strictEqual(booking.customerId, "CUST-1");
  assert.strictEqual(booking.legs.flightId, "FL-100");
  assert.strictEqual(booking.legs.hotelId, "HT-200");
  assert.strictEqual(booking.legs.safariId, "SF-300");
  assert.ok(booking.tripId.startsWith("TRIP-"));
  assert.strictEqual(booking.replayed, false);

  console.log("bookTripService: happy path test passed");

  // Failure path: unavailable flight -> unavailable result, no trip created.
  const unavailable = await bookTrip({
    customerId: "CUST-2",
    flightId: "FL-999",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0002",
  });

  assert.strictEqual(unavailable.status, "unavailable");
  assert.strictEqual(unavailable.message, "One or more selections are not available.");
  assert.strictEqual(unavailable.tripId, undefined);

  console.log("bookTripService: unavailable-dates failure path test passed");

  // CRM logging: a confirmed booking is logged exactly once.
  const loggedForTrip = getLoggedTransactions().filter(function (t) {
    return t.tripId === booking.tripId;
  });
  assert.strictEqual(loggedForTrip.length, 1);
  assert.strictEqual(loggedForTrip[0].customerId, "CUST-1");

  console.log("bookTripService: CRM transaction logging test passed");

  // Idempotency: logging the same tripId twice does not duplicate the entry.
  logTransaction(booking);
  logTransaction(booking);
  const loggedAgain = getLoggedTransactions().filter(function (t) {
    return t.tripId === booking.tripId;
  });
  assert.strictEqual(loggedAgain.length, 1);

  console.log("bookTripService: CRM logging idempotency test passed");

  // Failure path: invalid customer details -> no trip, no CRM log.
  const beforeInvalidCount = getLoggedTransactions().length;
  const invalidCustomer = await bookTrip({
    customerId: "",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0003",
  });

  assert.strictEqual(invalidCustomer.status, "invalid_customer");
  assert.strictEqual(invalidCustomer.message, "Customer details are invalid.");
  assert.strictEqual(invalidCustomer.tripId, undefined);
  assert.strictEqual(getLoggedTransactions().length, beforeInvalidCount);

  console.log("bookTripService: invalid-customer-details failure path test passed");

  // Failure path: payment declined -> no trip, no CRM log.
  const beforePaymentCount = getLoggedTransactions().length;
  const paymentFailed = await bookTrip({
    customerId: "CUST-DECLINED",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0004",
  });

  assert.strictEqual(paymentFailed.status, "payment_failed");
  assert.strictEqual(paymentFailed.message, "Payment could not be processed.");
  assert.strictEqual(paymentFailed.tripId, undefined);
  assert.strictEqual(getLoggedTransactions().length, beforePaymentCount);

  console.log("bookTripService: payment-failure failure path test passed");

  // ---------------------------------------------------------------------------
  // Idempotency of bookTrip() itself. Before the 2026-08-28 change every one of
  // these produced a NEW trip ID and a SECOND charge.
  // ---------------------------------------------------------------------------

  // Replay: the same key with the same arguments returns the original booking
  // and does not create a second trip or a second CRM entry.
  const beforeReplayCount = getLoggedTransactions().length;
  const replay = await bookTrip({
    customerId: "CUST-1",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0001",
  });

  assert.strictEqual(replay.status, "confirmed");
  assert.strictEqual(replay.tripId, booking.tripId);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(getLoggedTransactions().length, beforeReplayCount);

  console.log("bookTripService: replay returns the original trip, no second charge");

  // A DIFFERENT key for the same trip is a genuinely new booking. This is the
  // documented escape hatch, and it must keep working.
  const deliberateRebook = await bookTrip({
    customerId: "CUST-1",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0005",
  });

  assert.strictEqual(deliberateRebook.status, "confirmed");
  assert.notStrictEqual(deliberateRebook.tripId, booking.tripId);
  assert.strictEqual(deliberateRebook.replayed, false);

  console.log("bookTripService: a new key books a genuinely new trip");

  // Key reuse with different arguments is caught rather than returning someone
  // else's booking.
  const conflict = await bookTrip({
    customerId: "CUST-OTHER",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0001",
  });

  assert.strictEqual(conflict.status, "idempotency_conflict");
  assert.strictEqual(conflict.tripId, undefined);

  console.log("bookTripService: key reuse with different arguments is rejected");

  // A declined payment must not wedge its key — the agent fixes payment and
  // retries with the same key, and that retry must be able to succeed.
  const declinedRetry = await bookTrip({
    customerId: "CUST-DECLINED",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0004",
  });
  assert.strictEqual(declinedRetry.status, "payment_failed");
  assert.strictEqual(declinedRetry.replayed, false);

  const recovered = await bookTrip({
    customerId: "CUST-RECOVERED",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0004",
  });
  assert.strictEqual(recovered.status, "confirmed");
  assert.strictEqual(recovered.replayed, false);

  console.log("bookTripService: a declined key is not wedged, retry can succeed");

  // A missing or too-short key is refused outright — no trip, no charge.
  const beforeKeyGuardCount = getLoggedTransactions().length;
  // for...of rather than forEach: the callback would need its own `async`,
  // and an async forEach callback is not awaited, so a failing assertion
  // inside it would be an unhandled rejection instead of a failing test.
  for (const badKey of [undefined, "", "short", 12345678]) {
    const rejected = await bookTrip({
      customerId: "CUST-1",
      flightId: "FL-100",
      hotelId: "HT-200",
      safariId: "SF-300",
      idempotencyKey: badKey,
    });
    assert.strictEqual(rejected.status, "invalid_idempotency_key");
    assert.strictEqual(rejected.tripId, undefined);
  }
  assert.strictEqual(getLoggedTransactions().length, beforeKeyGuardCount);

  console.log("bookTripService: missing or malformed idempotencyKey is refused");

  // ---------------------------------------------------------------------------
  // STORY-004: accounting integration and audit trail.
  // ---------------------------------------------------------------------------

  // CRITERION 1: a completed transaction is logged in the accounting software.
  // 1280.00 flight + 760.00 hotel + 2450.00 safari = 4490.00.
  assert.strictEqual(booking.amountCents, 449000);
  assert.strictEqual(booking.currency, "USD");
  assert.strictEqual(booking.accounting.status, "recorded_and_posted");
  assert.strictEqual(booking.accounting.posted, true);
  assert.ok(booking.accounting.reference.startsWith("ACCT-"));

  const ledgerRow = getLedger().find(function (r) {
    return r.transactionId === "trip-key-0001";
  });
  assert.strictEqual(ledgerRow.amountCents, 449000);
  assert.strictEqual(ledgerRow.currency, "USD");
  assert.strictEqual(ledgerRow.entryType, "sale");
  assert.strictEqual(ledgerRow.memo, "Trip " + booking.tripId);

  console.log("bookTripService: a confirmed booking is posted to the accounting software");

  // CRITERION 3: the same booking produced an audit entry for the transaction
  // and one for what we did about it in the books.
  const confirmedKey = deriveAuditKey("trip-key-0001", "confirmed");
  const processedEntry = findAuditEntry(confirmedKey);
  assert.strictEqual(processedEntry.event, "transaction.processed");
  assert.strictEqual(processedEntry.outcome, "success");
  assert.strictEqual(processedEntry.actor, "CUST-1");
  assert.strictEqual(processedEntry.context.amountCents, 449000);

  const postEntry = findAuditEntry(accountingAuditKey(confirmedKey, "posted"));
  assert.strictEqual(postEntry.event, "accounting.post");
  assert.strictEqual(postEntry.outcome, "success");
  assert.strictEqual(postEntry.context.reference, booking.accounting.reference);

  console.log("bookTripService: the confirmed booking produced both audit entries");

  // CRITERION 2: a failed transaction is audited but must NOT reach the books.
  // A key of its own, never retried, so nothing later can put it in the ledger.
  const declinedForGood = await bookTrip({
    customerId: "CUST-DECLINED",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "trip-key-0006",
  });

  assert.strictEqual(declinedForGood.status, "payment_failed");
  assert.strictEqual(declinedForGood.accounting.status, "recorded_not_posted");
  assert.strictEqual(declinedForGood.accounting.posted, false);
  assert.strictEqual(declinedForGood.accounting.reference, null);

  const declinedEntry = findAuditEntry(deriveAuditKey("trip-key-0006", "payment_failed"));
  assert.strictEqual(declinedEntry.event, "transaction.processed");
  assert.strictEqual(declinedEntry.outcome, "failure");
  assert.strictEqual(declinedEntry.context.reason, "payment_declined");
  assert.strictEqual(declinedEntry.context.completed, false);

  console.log("bookTripService: a declined booking is audited but kept out of the books");

  // The declined-then-recovered key from earlier: BOTH facts are on record.
  // Keying the audit entry on the bare booking key would have kept only the
  // decline, because the audit log is first-write-wins.
  assert.strictEqual(
    findAuditEntry(deriveAuditKey("trip-key-0004", "payment_failed")).outcome,
    "failure"
  );
  assert.strictEqual(
    findAuditEntry(deriveAuditKey("trip-key-0004", "confirmed")).outcome,
    "success"
  );

  console.log("bookTripService: a decline and its later recovery are both on the audit trail");

  // The whole point, stated once against the ledger: only the three bookings
  // that actually completed are in the accounting software. The unavailable
  // one, the invalid-customer one and the two declines are not - and
  // trip-key-0004 appears exactly once despite being attempted twice.
  const ledgerIds = getLedger()
    .map(function (r) {
      return r.transactionId;
    })
    .sort();
  assert.deepStrictEqual(ledgerIds, ["trip-key-0001", "trip-key-0004", "trip-key-0005"]);

  console.log("bookTripService: only completed transactions reached the accounting software");

}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
