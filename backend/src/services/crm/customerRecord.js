// STORY-014: the customer half of the CRM - who has bought, and what.
//
// IT READS THE BOOKING LOG, IT DOES NOT KEEP ITS OWN COPY. Confirmed bookings
// are already durable in ../booking/crmTransactionLog.js, written by
// bookTripService the moment a booking is confirmed. This module is a read
// model over that. A CRM table of bookings would be a second answer to "what
// has this customer bought?", and the second answer is the one that goes stale
// the first time a booking is amended. The same reasoning is written out at
// portal/itineraryService.js:11.
//
// THAT IS ALSO WHY ACCEPTANCE CRITERION 2 NEEDS NO CODE HERE. The criterion is
// "when a booking is completed, the customer's booking history updates". It
// updates because the history IS the booking log: bookTripService calls
// logTransaction at the point of confirmation, and this module reads what is
// there. There is no sync step to get wrong, no job to fall behind, and no
// window in which the CRM disagrees with what the customer was charged. The
// test drives the real bookTrip() and then reads it back here, because the
// thing worth proving is that wiring and not that a filter works.
//
// WHO COUNTS AS A CUSTOMER. Someone with at least one confirmed booking. That
// is the whole definition, and it is deliberate: leads are the people who have
// not bought (crm/leadStore.js), customers are the people who have. So there
// is no customer directory here. Identity - who someone is, how they sign in -
// already belongs to portal/portalCredentials.js, and a CRM copy of it would
// be both a second truth and a second place to leak a contact list from.
//
// WHY IT IS A DIFFERENT VIEW FROM THE PORTAL'S. itineraryService.itineraryView
// exists to strip internal fields before a CUSTOMER sees their own trip. Sales
// is the opposite audience: they are entitled to what was charged, because
// that is the relationship they manage. Reusing the customer-facing view would
// couple two audiences whose needs point in opposite directions, so this has
// its own, and both list their fields explicitly rather than spreading the
// stored row - a new internal field on a booking stays invisible to both until
// somebody decides who may see it.
//
// WHY READS ARE NOT AUDITED. The story's trust criterion is about
// MODIFICATION, and this module cannot modify anything - there is no write
// path in the file. Access control is not skipped, it is just enforced
// somewhere better: the route declares crm.customers.read and http/server.js
// both gates on it and audits every refusal. Auditing successful reads as well
// is a legitimate thing to want, but it means an entry per page view, and that
// volume buries the entries that record a change. If it is wanted later it
// belongs at the boundary, once, not scattered through read models.
//
// NOT REVENUE REPORTING. lifetimeValueCents below is a per-customer
// relationship figure - "how much has this account been worth" - which is what
// a sales manager needs to prioritise their book. It is deliberately not
// accompanied by any cross-customer total: revenue and booking analytics are
// STORY-012's job, and two modules computing the business's revenue is exactly
// the duplication that ends in two numbers on two dashboards.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every outcome is a typed `status`; there is
//     no throw path on a read. A customer with no bookings is `not_found`
//     rather than an empty success, because in this model a person with no
//     bookings is not a customer yet - they are a lead, and answering "ok,
//     here is their empty history" would assert an account exists when the
//     only honest answer is that nothing here knows them.
//  2. Will it retry? No. One local read of an in-memory/JSON store.
//  3. Recovery path? A corrupt store refuses to load at startup rather than
//     serving a partial history - see shared/jsonFileStore.js.
//  4. Handled: unknown customer, malformed customerId, a stored row missing
//     fields or with a non-numeric amount, and mixed currencies on one
//     account. NOT handled: pagination, cancelled or amended bookings
//     (nothing in the build can cancel one yet), and merging two customerIds
//     found to be the same person.

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

// The sales-facing shape of a booking. Fields listed, never spread - see the
// header.
function salesView(booking) {
  return Object.freeze({
    tripId: booking.tripId,
    status: booking.status,
    bookedAt: booking.bookedAt || null,
    legs: Object.freeze({
      flightId: booking.legs ? booking.legs.flightId : null,
      hotelId: booking.legs ? booking.legs.hotelId : null,
      safariId: booking.legs ? booking.legs.safariId : null,
    }),
    amountCents: typeof booking.amountCents === "number" ? booking.amountCents : null,
    currency: booking.currency || null,
  });
}

// Newest first: a sales manager opens an account on "what happened lately".
function bookingsFor(customerId) {
  return getLoggedTransactions()
    .filter(function (booking) {
      return booking && booking.customerId === customerId;
    })
    .sort(function (a, b) {
      return String(b.bookedAt || "").localeCompare(String(a.bookedAt || ""));
    });
}

// The relationship at a glance, derived on read from the bookings themselves.
// Nothing here is stored, so there is no counter to drift out of step with the
// rows it counts.
function summarise(customerId, bookings) {
  // A null amount (a row written before amounts existed, or a malformed one)
  // contributes 0 rather than turning the whole total into NaN. A single bad
  // row should cost you that row, not the account's figure.
  const amounts = bookings.map(function (booking) {
    return typeof booking.amountCents === "number" && Number.isFinite(booking.amountCents)
      ? booking.amountCents
      : 0;
  });
  const lifetimeValueCents = amounts.reduce(function (total, amount) {
    return total + amount;
  }, 0);

  const bookedTimes = bookings
    .map(function (booking) {
      return booking.bookedAt || null;
    })
    .filter(Boolean)
    .sort();

  // Currencies are collected rather than assumed. The platform is
  // single-currency today (bookTripService pins USD), so this is normally one
  // entry - but reporting a total under one currency label when the rows
  // disagree would be a quietly wrong number, and a sales manager cannot see
  // that it is wrong. If this ever has two entries, lifetimeValueCents is a
  // sum of unlike things and the caller can tell.
  const currencies = Array.from(
    new Set(
      bookings
        .map(function (booking) {
          return booking.currency || null;
        })
        .filter(Boolean)
    )
  ).sort();

  return Object.freeze({
    customerId: customerId,
    bookingCount: bookings.length,
    lifetimeValueCents: lifetimeValueCents,
    currencies: Object.freeze(currencies),
    firstBookedAt: bookedTimes.length > 0 ? bookedTimes[0] : null,
    lastBookedAt: bookedTimes.length > 0 ? bookedTimes[bookedTimes.length - 1] : null,
  });
}

// One account: the relationship summary and the full booking history.
function getCustomerRecord({ customerId }) {
  if (!isUsableId(customerId)) {
    return { status: STATUSES.INVALID_REQUEST, message: "A customerId is required." };
  }

  const bookings = bookingsFor(customerId);
  if (bookings.length === 0) {
    // See FAILURE-FIRST note 1: no bookings means not a customer, not an
    // empty customer.
    return { status: STATUSES.NOT_FOUND, message: "No customer with that id has booked." };
  }

  return {
    status: STATUSES.OK,
    customer: summarise(customerId, bookings),
    bookings: bookings.map(salesView),
  };
}

// The book of accounts. Derived from the booking log on every call, so a
// customer appears here the moment their first booking confirms and there is
// no roster to keep in step.
//
// Most recently active first, which is the order a sales manager works in.
function listCustomers() {
  const byCustomer = new Map();
  getLoggedTransactions().forEach(function (booking) {
    if (!booking || !isUsableId(booking.customerId)) {
      return;
    }
    if (!byCustomer.has(booking.customerId)) {
      byCustomer.set(booking.customerId, []);
    }
    byCustomer.get(booking.customerId).push(booking);
  });

  const customers = Array.from(byCustomer.entries()).map(function ([customerId, bookings]) {
    return summarise(customerId, bookings);
  });

  return customers.sort(function (a, b) {
    return String(b.lastBookedAt || "").localeCompare(String(a.lastBookedAt || ""));
  });
}

module.exports = { getCustomerRecord, listCustomers, STATUSES };
