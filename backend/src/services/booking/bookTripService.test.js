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

// Failure path: invalid customer details -> no trip, no CRM log.
const beforeInvalidCount = getLoggedTransactions().length;
const invalidCustomer = bookTrip({
  customerId: "",
  flightId: "FL-100",
  hotelId: "HT-200",
  safariId: "SF-300",
});

assert.strictEqual(invalidCustomer.status, "invalid_customer");
assert.strictEqual(invalidCustomer.message, "Customer details are invalid.");
assert.strictEqual(invalidCustomer.tripId, undefined);
assert.strictEqual(getLoggedTransactions().length, beforeInvalidCount);

console.log("bookTripService: invalid-customer-details failure path test passed");

// Failure path: payment declined -> no trip, no CRM log.
const beforePaymentCount = getLoggedTransactions().length;
const paymentFailed = bookTrip({
  customerId: "CUST-DECLINED",
  flightId: "FL-100",
  hotelId: "HT-200",
  safariId: "SF-300",
});

assert.strictEqual(paymentFailed.status, "payment_failed");
assert.strictEqual(paymentFailed.message, "Payment could not be processed.");
assert.strictEqual(paymentFailed.tripId, undefined);
assert.strictEqual(getLoggedTransactions().length, beforePaymentCount);

console.log("bookTripService: payment-failure failure path test passed");
