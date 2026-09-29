// STORY-014, ACCEPTANCE CRITERION 2: when a booking is completed, the
// customer's booking history updates.
//
// The criterion is proved by driving the REAL booking service and then reading
// the account back through the CRM. Seeding crmTransactionLog directly would
// only prove that a filter filters; what is worth proving is that the path a
// real booking takes ends up visible to sales, with no sync step in between.
//
// The two halves of the criterion are therefore tested as one: bookTrip() is
// the "booking completed", getCustomerRecord() is the "history updated".

const assert = require("assert");

const { bookTrip } = require("../booking/bookTripService");
const { getCustomerRecord, listCustomers, STATUSES } = require("./customerRecord");

// The fixture inventory in bookTripService: FL-100 + HT-200 + SF-300.
const TRIP = { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" };
const TRIP_TOTAL_CENTS = 128000 + 76000 + 245000;

async function main() {
  // ---------------------------------------------------------------------
  // Before the booking: this person is not a customer. In this model that is
  // NOT_FOUND rather than an empty history - see the module header.
  // ---------------------------------------------------------------------
  const cold = getCustomerRecord({ customerId: "CUST-CRM-1" });
  assert.strictEqual(cold.status, STATUSES.NOT_FOUND);
  assert.strictEqual(cold.customer, undefined, "a non-customer must not come back as an empty one");
  console.log("customerRecord: someone with no bookings is not a customer yet");

  // ---------------------------------------------------------------------
  // ACCEPTANCE CRITERION 2: complete a booking, the history updates.
  // ---------------------------------------------------------------------
  const first = await bookTrip({
    customerId: "CUST-CRM-1",
    ...TRIP,
    idempotencyKey: "crm-record-first-booking",
  });
  assert.strictEqual(first.status, "confirmed", "the fixture booking must confirm");

  const afterOne = getCustomerRecord({ customerId: "CUST-CRM-1" });
  assert.strictEqual(afterOne.status, STATUSES.OK);
  assert.strictEqual(afterOne.bookings.length, 1);
  assert.strictEqual(afterOne.bookings[0].tripId, first.tripId);
  assert.strictEqual(afterOne.bookings[0].status, "confirmed");
  assert.strictEqual(afterOne.bookings[0].amountCents, TRIP_TOTAL_CENTS);
  assert.strictEqual(afterOne.bookings[0].currency, "USD");
  assert.deepStrictEqual(
    { ...afterOne.bookings[0].legs },
    { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" }
  );
  console.log("customerRecord: a completed booking appears in the customer's history");

  // The relationship summary is derived from those rows, so it cannot drift
  // from them.
  assert.strictEqual(afterOne.customer.bookingCount, 1);
  assert.strictEqual(afterOne.customer.lifetimeValueCents, TRIP_TOTAL_CENTS);
  assert.deepStrictEqual([...afterOne.customer.currencies], ["USD"]);
  assert.strictEqual(afterOne.customer.firstBookedAt, afterOne.customer.lastBookedAt);
  console.log("customerRecord: the relationship summary is derived from the history it summarises");

  // ---------------------------------------------------------------------
  // A SECOND booking accumulates rather than replacing.
  // ---------------------------------------------------------------------
  const second = await bookTrip({
    customerId: "CUST-CRM-1",
    ...TRIP,
    idempotencyKey: "crm-record-second-booking",
  });
  assert.strictEqual(second.status, "confirmed");
  assert.notStrictEqual(second.tripId, first.tripId);

  const afterTwo = getCustomerRecord({ customerId: "CUST-CRM-1" });
  assert.strictEqual(afterTwo.bookings.length, 2);
  assert.strictEqual(afterTwo.customer.bookingCount, 2);
  assert.strictEqual(afterTwo.customer.lifetimeValueCents, TRIP_TOTAL_CENTS * 2);
  // Newest first.
  assert.ok(
    String(afterTwo.bookings[0].bookedAt) >= String(afterTwo.bookings[1].bookedAt),
    "the history must read newest first"
  );
  console.log("customerRecord: a second booking adds to the history and to the lifetime value");

  // ---------------------------------------------------------------------
  // IDEMPOTENCY: replaying a booking must not double-count the relationship.
  // This is the CRM-side consequence of bookTrip's idempotency key, and it is
  // the failure that would matter most - a lifetime value that inflates on
  // every retry is a number sales would act on.
  // ---------------------------------------------------------------------
  const replay = await bookTrip({
    customerId: "CUST-CRM-1",
    ...TRIP,
    idempotencyKey: "crm-record-first-booking", // the same key as `first`
  });
  assert.strictEqual(replay.replayed, true, "the same key must replay, not rebook");
  assert.strictEqual(replay.tripId, first.tripId);

  const afterReplay = getCustomerRecord({ customerId: "CUST-CRM-1" });
  assert.strictEqual(afterReplay.bookings.length, 2, "a replay must not add a row");
  assert.strictEqual(afterReplay.customer.bookingCount, 2);
  assert.strictEqual(
    afterReplay.customer.lifetimeValueCents,
    TRIP_TOTAL_CENTS * 2,
    "a replayed booking must not inflate the lifetime value"
  );
  console.log("customerRecord: replaying a booking does not double-count it in the CRM");

  // ---------------------------------------------------------------------
  // FAILURE PATH: a booking that did NOT complete must never appear as
  // history. A declined payment is not a relationship.
  // ---------------------------------------------------------------------
  const declined = await bookTrip({
    customerId: "CUST-DECLINED",
    ...TRIP,
    idempotencyKey: "crm-record-declined-booking",
  });
  assert.strictEqual(declined.status, "payment_failed");

  const declinedRecord = getCustomerRecord({ customerId: "CUST-DECLINED" });
  assert.strictEqual(
    declinedRecord.status,
    STATUSES.NOT_FOUND,
    "a declined booking must not create a customer"
  );
  console.log("customerRecord: a declined booking never becomes booking history");

  // ---------------------------------------------------------------------
  // OWNERSHIP: one account's history is only its own.
  // ---------------------------------------------------------------------
  const otherBooking = await bookTrip({
    customerId: "CUST-CRM-2",
    ...TRIP,
    idempotencyKey: "crm-record-other-customer",
  });
  assert.strictEqual(otherBooking.status, "confirmed");

  const one = getCustomerRecord({ customerId: "CUST-CRM-1" });
  const two = getCustomerRecord({ customerId: "CUST-CRM-2" });
  assert.strictEqual(one.bookings.length, 2);
  assert.strictEqual(two.bookings.length, 1);
  assert.ok(
    !one.bookings.some((booking) => booking.tripId === otherBooking.tripId),
    "one customer's history must not contain another's trip"
  );
  console.log("customerRecord: an account's history contains only its own bookings");

  // ---------------------------------------------------------------------
  // The roster, derived on read.
  // ---------------------------------------------------------------------
  const roster = listCustomers();
  const ids = roster.map((customer) => customer.customerId);
  assert.ok(ids.includes("CUST-CRM-1"));
  assert.ok(ids.includes("CUST-CRM-2"));
  assert.ok(!ids.includes("CUST-DECLINED"), "a declined payer is not on the roster");
  const onRoster = roster.find((customer) => customer.customerId === "CUST-CRM-1");
  assert.strictEqual(onRoster.bookingCount, 2);
  assert.strictEqual(onRoster.lifetimeValueCents, TRIP_TOTAL_CENTS * 2);
  // Most recently active first.
  for (let i = 1; i < roster.length; i += 1) {
    assert.ok(
      String(roster[i - 1].lastBookedAt || "") >= String(roster[i].lastBookedAt || ""),
      "the roster must read most-recently-active first"
    );
  }
  console.log("customerRecord: the roster is derived from the booking log, newest activity first");

  // ---------------------------------------------------------------------
  // BOUNDARY / malformed input. A bad id is a bad request, not a crash and
  // not an empty success.
  // ---------------------------------------------------------------------
  [undefined, null, "", "   ", 42, {}, "x".repeat(129)].forEach(function (customerId) {
    const result = getCustomerRecord({ customerId: customerId });
    assert.strictEqual(
      result.status,
      STATUSES.INVALID_REQUEST,
      JSON.stringify(customerId) + " must be an invalid request"
    );
    assert.strictEqual(result.bookings, undefined);
  });
  // 128 characters is the limit, not over it - and that id simply has no
  // bookings, which is a different answer from a malformed one.
  assert.strictEqual(
    getCustomerRecord({ customerId: "x".repeat(128) }).status,
    STATUSES.NOT_FOUND
  );
  console.log("customerRecord: a malformed customerId is refused, and the length limit holds");

  // A caller cannot edit the CRM through what it was handed. There is no write
  // path in this module, and the returned rows are frozen so that stays true.
  assert.throws(function () {
    "use strict";
    one.bookings[0].amountCents = 1;
  }, TypeError);
  assert.throws(function () {
    "use strict";
    one.customer.lifetimeValueCents = 0;
  }, TypeError);
  console.log("customerRecord: the record is read-only in the hands of its caller");

  console.log("customerRecord: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
