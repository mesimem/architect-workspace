const assert = require("assert");
const { routeOutcomeToAdvisor } = require("./advisorRouting");
const { findReview, getQueuedReviews } = require("./advisorReviewQueue");
const { getOutbox } = require("./advisorNotifier");
const { getSafariDetails } = require("../africa/safariDetailsService");
const { bookTrip } = require("../booking/bookTripService");

// This suite is the answer to "nothing actually calls the triage service".
// It exercises the real services end to end and asserts that the outcomes a
// human can change reach an advisor - and, just as importantly, that the ones
// a human cannot change do not.

async function main() {
  // A customer asks about a destination we do not sell. Before this wiring the
  // customer was told "contact an advisor" and no advisor was ever told.
  const unsupported = await getSafariDetails({
    customerId: "CUST-ROUTE-1",
    destinationId: "SF-ANTARCTICA",
    interactionKey: "ROUTE-TEST-UNSUPPORTED",
  });

  assert.strictEqual(unsupported.status, "unsupported");
  assert.strictEqual(unsupported.advisor.routed, true);
  assert.strictEqual(unsupported.advisor.reason, "unsupported_destination");

  const unsupportedReview = findReview("ROUTE-TEST-UNSUPPORTED");
  assert.ok(unsupportedReview, "the customer's dead end must reach an advisor");
  assert.strictEqual(unsupportedReview.status, "pending_review");
  assert.strictEqual(unsupportedReview.customerId, "CUST-ROUTE-1");
  assert.strictEqual(unsupportedReview.source, "safari-details");
  assert.strictEqual(unsupportedReview.context.destinationId, "SF-ANTARCTICA");
  assert.strictEqual(unsupportedReview.notificationStatus, "notified");

  console.log("advisorRouting: an unsupported destination reaches an advisor");

  // A destination whose catalog record is unfinished: an advisor can quote it
  // by hand while the record is being completed.
  const incomplete = await getSafariDetails({
    customerId: "CUST-ROUTE-2",
    destinationId: "SF-301",
    interactionKey: "ROUTE-TEST-INCOMPLETE",
  });

  assert.strictEqual(incomplete.status, "incomplete");
  assert.strictEqual(incomplete.advisor.reason, "details_incomplete");
  assert.ok(findReview("ROUTE-TEST-INCOMPLETE"));

  console.log("advisorRouting: an unfinished catalog record reaches an advisor");

  // A successful lookup involves no advisor at all.
  const okLookup = await getSafariDetails({
    customerId: "CUST-ROUTE-3",
    destinationId: "SF-300",
    interactionKey: "ROUTE-TEST-HAPPYPATH",
  });
  assert.strictEqual(okLookup.status, "ok");
  assert.strictEqual(okLookup.advisor, undefined);
  assert.strictEqual(findReview("ROUTE-TEST-HAPPYPATH"), undefined);

  console.log("advisorRouting: a successful lookup does not create advisor work");

  // The strongest case in the system: the customer is actively trying to buy a
  // trip and one leg is unavailable. A full-service agency finds the other
  // lodge - so this is exactly the work an advisor should be handed.
  const unavailable = await bookTrip({
    customerId: "CUST-ROUTE-4",
    flightId: "FL-100",
    hotelId: "HT-999-NOT-REAL",
    safariId: "SF-300",
    idempotencyKey: "route-test-unavailable-1",
  });

  assert.strictEqual(unavailable.status, "unavailable");
  assert.strictEqual(unavailable.advisor.routed, true);
  assert.strictEqual(unavailable.advisor.reason, "booking_selection_unavailable");

  const bookingReview = findReview("route-test-unavailable-1");
  assert.ok(bookingReview);
  assert.strictEqual(bookingReview.source, "booking");
  assert.strictEqual(bookingReview.context.hotelId, "HT-999-NOT-REAL");

  console.log("advisorRouting: an unavailable booking leg reaches an advisor");

  // Retrying the same booking attempt produces ONE advisor task, not one per
  // retry. The review is keyed on the same idempotencyKey the booking uses.
  const queueBefore = getQueuedReviews().length;
  const outboxBefore = getOutbox().length;
  const retry = await bookTrip({
    customerId: "CUST-ROUTE-4",
    flightId: "FL-100",
    hotelId: "HT-999-NOT-REAL",
    safariId: "SF-300",
    idempotencyKey: "route-test-unavailable-1",
  });
  assert.strictEqual(retry.advisor.replayed, true);
  assert.strictEqual(getQueuedReviews().length, queueBefore);
  assert.strictEqual(getOutbox().length, outboxBefore);

  console.log("advisorRouting: retrying a failed booking does not duplicate the advisor task");

  // WHAT MUST NOT ROUTE. A declined card is between the customer and their
  // bank; an advisor cannot make it work, and routing it would fill the queue
  // with tasks nobody can action.
  const declined = await bookTrip({
    customerId: "CUST-DECLINED", // the mock processor's deterministic decline
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "route-test-declined-01",
  });
  assert.strictEqual(declined.status, "payment_failed");
  assert.strictEqual(declined.advisor, undefined);
  assert.strictEqual(findReview("route-test-declined-01"), undefined);

  console.log("advisorRouting: a declined payment does not create advisor work");

  // Explicitly: an outcome that is not on the routable list is skipped rather
  // than routed under some default. A default would quietly undo the whole
  // point of the list.
  const skipped = await routeOutcomeToAdvisor({
    source: "safari-details",
    outcome: "timeout",
    requestId: "ROUTE-TEST-TIMEOUT-01",
    customerId: "CUST-ROUTE-5",
  });
  assert.strictEqual(skipped.routed, false);
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(findReview("ROUTE-TEST-TIMEOUT-01"), undefined);

  console.log("advisorRouting: a non-routable outcome is skipped, not routed by default");

  // Routing must never turn a handled failure into an unhandled one: if the
  // review cannot be written, the caller still gets an answer.
  const storeBroken = await routeOutcomeToAdvisor({
    source: "safari-details",
    outcome: "unsupported",
    requestId: "short", // rejected by the queue's key guard
    customerId: "CUST-ROUTE-6",
  });
  assert.strictEqual(storeBroken.routed, false);
  assert.strictEqual(storeBroken.error, "flag_not_recorded");

  console.log("advisorRouting: a failed review write is reported, never thrown at the caller");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
