// STORY-001: pure booking logic — no I/O yet. Availability is an in-memory
// stand-in for a real inventory system, seeded for tests until one exists.

const { logTransaction } = require("./crmTransactionLog");
const { processPayment } = require("./paymentService");

const AVAILABILITY = {
  flights: new Set(["FL-100"]),
  hotels: new Set(["HT-200"]),
  safaris: new Set(["SF-300"]),
};

let nextTripId = 1;

function bookTrip({ customerId, flightId, hotelId, safariId }) {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    return {
      status: "invalid_customer",
      message: "Customer details are invalid.",
    };
  }

  const unavailable =
    !AVAILABILITY.flights.has(flightId) ||
    !AVAILABILITY.hotels.has(hotelId) ||
    !AVAILABILITY.safaris.has(safariId);

  if (unavailable) {
    return {
      status: "unavailable",
      message: "One or more selections are not available.",
    };
  }

  const payment = processPayment({ customerId });
  if (!payment.success) {
    return {
      status: "payment_failed",
      message: payment.message,
    };
  }

  const tripId = `TRIP-${nextTripId++}`;
  const booking = {
    tripId,
    customerId,
    status: "confirmed",
    legs: { flightId, hotelId, safariId },
  };

  logTransaction(booking);

  return booking;
}

module.exports = { bookTrip, AVAILABILITY };
