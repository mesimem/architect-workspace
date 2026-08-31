const assert = require("assert");
const { bookTrip } = require("./bookTripService");
const { logTransaction, getLoggedTransactions } = require("./crmTransactionLog");

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

}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
