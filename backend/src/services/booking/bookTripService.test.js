const assert = require("assert");
const { bookTrip } = require("./bookTripService");
const { logTransaction, getLoggedTransactions } = require("./crmTransactionLog");

// Happy path: all three legs available -> one confirmed trip covering all three.
const booking = bookTrip({
  customerId: "CUST-1",
  flightId: "FL-100",
  hotelId: "HT-200",
  safariId: "SF-300",
});

assert.strictEqual(booking.status, "confirmed");
assert.strictEqual(booking.customerId, "CUST-1");
assert.strictEqual(booking.legs.flightId, "FL-100");
assert.strictEqual(booking.legs.hotelId, "HT-200");
assert.strictEqual(booking.legs.safariId, "SF-300");
assert.ok(booking.tripId.startsWith("TRIP-"));

console.log("bookTripService: happy path test passed");

// Failure path: unavailable flight -> unavailable result, no trip created.
const unavailable = bookTrip({
  customerId: "CUST-2",
  flightId: "FL-999",
  hotelId: "HT-200",
  safariId: "SF-300",
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
