// STORY-005: what a signed-in customer can see - their own trips, and nobody
// else's.
//
// REQ-007 is "view and manage their itineraries through a secure portal". This
// module is the VIEW half. The manage half (change requests, cancellations)
// is deliberately not here: cancelling drags in refunds and reversing an
// accounting entry, and a change request is the advisor routing STORY-003
// already owns. Read-only was agreed as this story's scope rather than
// half-building a mutation path.
//
// IT READS THE CRM LOG, IT DOES NOT KEEP ITS OWN COPY. Confirmed bookings are
// already durable in ../booking/crmTransactionLog.js, written by bookTrip.
// A second store would be a second truth, and the two would drift the first
// time a booking was amended. So this is a read model over what booking
// already records - no new state, nothing to keep in step.
//
// THE OWNERSHIP RULE IS THE WHOLE POINT. Every function here takes a
// customerId and filters on it. There is no "list all itineraries" and no way
// to ask for a trip without saying who is asking, because an endpoint that can
// return anyone's trip is one forgotten parameter away from returning
// everyone's.
//
// WHY A STRANGER'S TRIP IS 'not_found' AND NOT 'forbidden'. "You may not see
// this" confirms the trip exists. Ask for TRIP-1 through TRIP-500 and the
// difference between forbidden and not-found maps out every booking in the
// business, including how many there are. Both answers are therefore
// identical: as far as this customer is concerned, that trip does not exist.
// The failure path the story calls "unauthorized access" is handled here by
// refusing to acknowledge, and at the boundary by 401/403.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every outcome is a typed `status`. There is
//     no throw path on a read: a customer with no bookings gets an empty list,
//     which is a valid answer and not an error.
//  2. Will it retry? No. The only read is a local in-memory/JSON store.
//  3. Recovery path? A corrupt store file refuses to load at startup rather
//     than serving a customer a partial trip list - see jsonFileStore.js.
//  4. Handled here: no bookings, unknown trip, another customer's trip, a
//     malformed customerId or tripId, and a store row missing fields.
//     NOT handled: pagination (a customer with thousands of trips is not a
//     problem this business has), sorting options, cancelled/amended trips
//     (nothing in the build can cancel one yet), and advisor-on-behalf-of
//     access, which needs the permission model in STORY-006.

const { getLoggedTransactions } = require("../booking/crmTransactionLog");

const MAX_ID_LENGTH = 128;

const STATUSES = {
  OK: "ok",
  NOT_FOUND: "not_found",
  INVALID_REQUEST: "invalid_request",
};

function isUsableId(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID_LENGTH;
}

// The customer-facing shape of a booking. Deliberately NOT the stored row:
// the CRM record is internal and may grow fields (margins, supplier
// references, advisor notes) that a customer must never be shown. Listing the
// fields explicitly means a new internal field is invisible here until someone
// decides to publish it - the opposite of spreading the row and hoping.
function itineraryView(booking) {
  return {
    tripId: booking.tripId,
    status: booking.status,
    bookedAt: booking.bookedAt,
    legs: {
      flightId: booking.legs ? booking.legs.flightId : null,
      hotelId: booking.legs ? booking.legs.hotelId : null,
      safariId: booking.legs ? booking.legs.safariId : null,
    },
    amountCents: typeof booking.amountCents === "number" ? booking.amountCents : null,
    currency: booking.currency || null,
  };
}

function bookingsFor(customerId) {
  return getLoggedTransactions()
    .filter(function (booking) {
      return booking && booking.customerId === customerId;
    })
    // Most recent first: a portal opens on "what is happening next", not on
    // whatever the store happened to write first.
    .sort(function (a, b) {
      return String(b.bookedAt || "").localeCompare(String(a.bookedAt || ""));
    });
}

// Every trip belonging to this customer. An empty list is `ok`, not an error.
function listItineraries({ customerId }) {
  if (!isUsableId(customerId)) {
    return {
      status: STATUSES.INVALID_REQUEST,
      message: "A customerId is required.",
      count: 0,
      itineraries: [],
    };
  }

  const itineraries = bookingsFor(customerId).map(itineraryView);
  return { status: STATUSES.OK, count: itineraries.length, itineraries: itineraries };
}

// One trip, and only if it is theirs. See the note above on why someone else's
// trip is reported exactly like a trip that does not exist.
function getItinerary({ customerId, tripId }) {
  if (!isUsableId(customerId) || !isUsableId(tripId)) {
    return { status: STATUSES.INVALID_REQUEST, message: "A customerId and tripId are required." };
  }

  const match = bookingsFor(customerId).find(function (booking) {
    return booking.tripId === tripId;
  });

  if (!match) {
    return {
      status: STATUSES.NOT_FOUND,
      message: "No such trip.",
    };
  }

  return { status: STATUSES.OK, itinerary: itineraryView(match) };
}

module.exports = { listItineraries, getItinerary, STATUSES };
