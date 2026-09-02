// STORY-005 step 5: tests for the itinerary read model.
//
// The load-bearing test in here is the ownership one. Everything else is
// plumbing; "a customer cannot see another customer's trip, and cannot even
// learn that it exists" is the requirement.

const assert = require("assert");

const { logTransaction } = require("../booking/crmTransactionLog");
const { listItineraries, getItinerary, STATUSES } = require("./itineraryService");

function seedBooking(overrides) {
  return logTransaction(
    Object.assign(
      {
        tripId: "TRIP-SEED",
        customerId: "CUST-A",
        status: "confirmed",
        legs: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
        amountCents: 449000,
        currency: "USD",
        bookedAt: "2026-09-01T10:00:00.000Z",
      },
      overrides
    )
  );
}

function main() {
  delete process.env.COLABERRY_DATA_DIR;

  seedBooking({ tripId: "TRIP-A1", customerId: "CUST-A", bookedAt: "2026-09-01T10:00:00.000Z" });
  seedBooking({ tripId: "TRIP-A2", customerId: "CUST-A", bookedAt: "2026-09-03T10:00:00.000Z" });
  seedBooking({ tripId: "TRIP-B1", customerId: "CUST-B", bookedAt: "2026-09-02T10:00:00.000Z" });

  // ---------------------------------------------------------------- happy path
  const mine = listItineraries({ customerId: "CUST-A" });
  assert.strictEqual(mine.status, STATUSES.OK);
  assert.strictEqual(mine.count, 2);
  assert.deepStrictEqual(
    mine.itineraries.map(function (trip) {
      return trip.tripId;
    }),
    ["TRIP-A2", "TRIP-A1"],
    "most recent first"
  );
  console.log("itinerary: a customer sees their own trips, most recent first");

  const one = getItinerary({ customerId: "CUST-A", tripId: "TRIP-A1" });
  assert.strictEqual(one.status, STATUSES.OK);
  assert.deepStrictEqual(one.itinerary, {
    tripId: "TRIP-A1",
    status: "confirmed",
    bookedAt: "2026-09-01T10:00:00.000Z",
    legs: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
    amountCents: 449000,
    currency: "USD",
  });
  console.log("itinerary: a single trip comes back with its legs and its price");

  // ------------------------------------------------------------- OWNERSHIP
  // The rule this module exists to enforce.
  const notMine = getItinerary({ customerId: "CUST-A", tripId: "TRIP-B1" });
  assert.strictEqual(notMine.status, STATUSES.NOT_FOUND, "ANOTHER CUSTOMER'S TRIP IS NOT VISIBLE");

  // And indistinguishable from a trip that never existed - otherwise the
  // difference between the two answers maps out every booking in the business.
  const invented = getItinerary({ customerId: "CUST-A", tripId: "TRIP-DOES-NOT-EXIST" });
  assert.deepStrictEqual(
    notMine,
    invented,
    "a stranger's trip and a nonexistent trip must be BYTE-IDENTICAL answers"
  );
  console.log("itinerary: another customer's trip reads exactly like one that does not exist");

  // The list is filtered too, not just the single-trip lookup. A filter
  // applied in one place and forgotten in the other is the classic version of
  // this bug.
  const everyTripSeen = listItineraries({ customerId: "CUST-A" }).itineraries.map(function (trip) {
    return trip.tripId;
  });
  assert.ok(!everyTripSeen.includes("TRIP-B1"), "the LIST is scoped as well as the lookup");
  console.log("itinerary: the list is scoped to the caller, not filtered only on lookup");

  // ------------------------------------------------------- nothing booked yet
  const empty = listItineraries({ customerId: "CUST-NEW" });
  assert.deepStrictEqual(empty, { status: STATUSES.OK, count: 0, itineraries: [] });
  console.log("itinerary: a customer with no bookings gets an empty list, not an error");

  // ------------------------------------------------------------ bad arguments
  for (const bad of [undefined, null, "", "   ", 7, {}, "x".repeat(129)]) {
    assert.strictEqual(
      listItineraries({ customerId: bad }).status,
      STATUSES.INVALID_REQUEST,
      "unusable customerId: " + String(bad).slice(0, 12)
    );
    assert.strictEqual(
      getItinerary({ customerId: bad, tripId: "TRIP-A1" }).status,
      STATUSES.INVALID_REQUEST
    );
    assert.strictEqual(
      getItinerary({ customerId: "CUST-A", tripId: bad }).status,
      STATUSES.INVALID_REQUEST
    );
  }
  console.log("itinerary: an unusable customerId or tripId is refused, never treated as a wildcard");

  // -------------------------------------------- internal fields are not published
  // The stored CRM row may grow fields a customer must never see. The view
  // lists its fields explicitly, so a new internal field is invisible until
  // someone decides to publish it.
  seedBooking({
    tripId: "TRIP-SECRET",
    customerId: "CUST-C",
    supplierMarginCents: 90000,
    advisorNotes: "client will pay more for the private guide",
  });
  const published = getItinerary({ customerId: "CUST-C", tripId: "TRIP-SECRET" }).itinerary;
  assert.deepStrictEqual(Object.keys(published).sort(), [
    "amountCents",
    "bookedAt",
    "currency",
    "legs",
    "status",
    "tripId",
  ]);
  const serialised = JSON.stringify(published);
  assert.ok(!serialised.includes("90000"), "THE MARGIN IS NOT PUBLISHED");
  assert.ok(!serialised.includes("private guide"), "NOR ARE ADVISOR NOTES");
  console.log("itinerary: internal CRM fields are not published to the customer");

  // --------------------------------------------------- a row missing its fields
  // Defensive: the store is written by bookTrip today, but a read model that
  // crashes on an odd row takes the whole portal down with it.
  seedBooking({ tripId: "TRIP-PARTIAL", customerId: "CUST-D", legs: undefined, amountCents: undefined });
  const partial = getItinerary({ customerId: "CUST-D", tripId: "TRIP-PARTIAL" });
  assert.strictEqual(partial.status, STATUSES.OK);
  assert.deepStrictEqual(partial.itinerary.legs, {
    flightId: null,
    hotelId: null,
    safariId: null,
  });
  assert.strictEqual(partial.itinerary.amountCents, null);
  console.log("itinerary: a store row with missing fields reads as nulls, it does not throw");

  console.log("itinerary: all tests passed");
}

main();
