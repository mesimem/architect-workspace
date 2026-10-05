// STORY-018: the operations booking board over HTTP - every booking the agency
// holds, and moving one along its lifecycle.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, on purpose. It maps a
// request onto a service call and a service result onto a status code. Which
// statuses exist, which changes are legal, what gets audited and what "all
// bookings" means all live in ../../services/booking/, because those are
// decisions and this is plumbing. A rule implemented in a route is a rule that
// only applies to callers who arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it, once, before the handler runs - and audits
// every refusal. A second check in here would be a second policy that can
// disagree with the first, which is the whole reason STORY-006 centralised it.
// The story's "unauthorized access to booking management features" failure path
// is therefore tested against these routes rather than handled in them, and the
// thing that makes it work is the pairing below: the two GETs declare
// ops.bookings.read, the PATCH declares ops.bookings.write.
//
// WHY THE READ AND THE WRITE ARE DIFFERENT PERMISSIONS, at the boundary where
// it is visible: GET returns every booking the agency holds - who is
// travelling, where, for how much - while PATCH can only move one booking along
// a four-state lifecycle that refuses to leave a terminal state. The read is
// the more dangerous of the two. Splitting them is what lets a future reporting
// integration be given the board without being given the ability to cancel
// anything.
//
// WHY VALIDATION HERE IS ONLY THE ENVELOPE. Same rule as packageRoutes.js: this
// checks the SHAPE ("is this a JSON object?") and nothing else. It deliberately
// does NOT check that the status is a real one or that the transition is legal,
// even though it easily could. Those refusals are AUDITED by the service, and
// rejecting them here would return the same 4xx to the caller while quietly
// losing the audit entry - a refused status change that leaves no trace. The
// boundary's job is to stop nonsense that never reached a decision; an attempt
// to reopen a completed booking DID reach one, and the trail should say so.
//
// NO FILTERS ON THE LIST, AND WHY NOT YET. opsBookingBoard.listBookings takes
// status and groupId filters, and this route passes neither. The reason is that
// nothing in this pipeline reads query strings: server.js parses the pathname
// only, and no route in the system takes a query parameter. Adding that is an
// edit to the central request pipeline that every route shares, for a
// capability no acceptance criterion on this story asks for - so it is left to
// whoever needs it, to be done once for all routes rather than smuggled in
// here. The response carries countsByStatus and the whole board, which is what
// a dashboard needs to render and filter client-side at this volume. When query
// support lands, this handler passes the two filters through and the service
// side is already built and tested.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to an explicit
//     status via REFUSAL_STATUS below; an unmapped reason becomes 500 rather
//     than a misleading 400, because an unrecognised refusal is our bug and
//     should read like one. A malformed path parameter is a 400.
//  2. Will it retry? Nothing here retries, and nothing here should: these are
//     local calls. The operations are safe for the CALLER to retry - the GETs
//     are reads, and a PATCH applied twice reports the second as changed:false
//     without writing or auditing anything.
//  3. Recovery path? The caller gets an error code and a problem list naming
//     what was wrong, including - for an illegal transition - which statuses
//     the booking could legally move to instead. A 503 means the stored status
//     is unchanged and the request can simply be repeated.
//  4. Handled: non-object bodies, a missing or malformed tripId in the path,
//     percent-encoding that cannot be decoded, bookings that do not exist,
//     every lifecycle refusal, and the two infrastructure refusals. NOT
//     handled: filtering and pagination (see above - the board is small and
//     STORY-016 owns scale), bulk status changes across many bookings at once
//     (each change is its own audited decision, and a bulk endpoint would make
//     the trail harder to read for the one case it saves time on), and
//     deleting a booking, which is what `cancelled` is for.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  listBookings,
  getBooking,
  updateBookingStatus,
  BOARD_REASONS,
} = require("../../services/booking/opsBookingBoard");
const { REFUSAL_REASONS, ALL_STATUSES } = require("../../services/booking/bookingStatusLifecycle");
const { REASONS: STORE_REASONS } = require("../../services/booking/bookingStatusStore");

// Service refusal reason -> HTTP status. Written as a table so that adding a
// refusal to the service and forgetting it here produces a 500 (loud) rather
// than a 400 (plausible, and wrong). Keyed off the services' own constants
// rather than string literals, so a renamed reason is a startup error instead
// of a silently unmapped 500.
const REFUSAL_STATUS = Object.freeze({
  [BOARD_REASONS.INVALID_REQUEST]: 400,
  [BOARD_REASONS.UNKNOWN_BOOKING]: 404,

  // 400: the caller named a status that does not exist. Their typo, and the
  // problem list names the statuses that would have worked.
  [REFUSAL_REASONS.UNKNOWN_TARGET_STATUS]: 400,

  // 409, not 400: both of these requests were perfectly well-formed and asked
  // for a real status. They collided with the STATE the booking is in - which
  // is a conflict, and a client can tell those apart and should. The same
  // request may well succeed after the booking moves on (illegal_transition),
  // or never (terminal_status), and the problem list says which.
  [REFUSAL_REASONS.ILLEGAL_TRANSITION]: 409,
  [REFUSAL_REASONS.TERMINAL_STATUS]: 409,

  // 500: the stored status is outside the vocabulary. That is corruption or a
  // version skew - our bug, not the caller's - and dressing it as a 4xx would
  // send somebody looking for a mistake in a request that was fine.
  [REFUSAL_REASONS.UNKNOWN_CURRENT_STATUS]: 500,

  // 503, not 500. The stored status is UNCHANGED and the request can simply be
  // repeated - a different instruction to a client than "something broke and we
  // do not know what state you are in". These are the two refusals the audited
  // commit returns when it could not save, or could not prove the save was
  // recorded.
  [STORE_REASONS.NOT_SAVED]: 503,
  [STORE_REASONS.AUDIT_UNAVAILABLE]: 503,
});

function refusalResponse(result) {
  const status = REFUSAL_STATUS[result.reason] || 500;
  return {
    status: status,
    body: {
      error: result.reason,
      // The problem list is the service's. Every module that builds one is
      // written not to echo untrusted input back - see describeStatus in
      // bookingStatusLifecycle.js.
      problems: result.problems || [],
    },
  };
}

// Envelope only - see the header.
function validateStatusBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  return [];
}

// A path parameter arrives percent-encoded and decodeURIComponent THROWS on a
// malformed sequence ("%" on its own). Unguarded that is a 500 on a URL a
// scanner will find within the hour, so it is a 400 here.
function decodeParam(raw) {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return null;
  }
}

const opsBookingRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/ops\/bookings$/,
    permission: PERMISSIONS.OPS_BOOKINGS_READ,
    handler: async function () {
      const board = listBookings();
      return {
        status: 200,
        body: {
          bookings: board.bookings,
          total: board.total,
          shown: board.shown,
          countsByStatus: board.countsByStatus,
          // Non-zero means the ledger holds rows too malformed to display.
          // Shipped rather than hidden so a booking somebody cannot find has an
          // explanation on the same screen.
          unlistable: board.unlistable,
          // The vocabulary ships with the board so a client can build its
          // status controls without hardcoding a copy that falls out of step
          // the day a status is added. Note that each ROW also carries its own
          // allowedNextStatuses - this is the full set, that is what is legal
          // for that booking right now.
          statuses: ALL_STATUSES,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/ops\/bookings\/([^/]+)$/,
    permission: PERMISSIONS.OPS_BOOKINGS_READ,
    handler: async function (context) {
      const tripId = decodeParam(context.params[0]);
      if (tripId === null) {
        return {
          status: 400,
          body: { error: "invalid_trip_id", problems: ["Malformed tripId."] },
        };
      }

      const booking = getBooking(tripId);
      if (!booking) {
        // 404 for "no such booking". There is nothing to withhold: the caller
        // already holds ops.bookings.read, which would have shown them every
        // booking in the agency, so telling them this one does not exist tells
        // them nothing they were not entitled to ask.
        return { status: 404, body: { error: "unknown_booking" } };
      }

      return { status: 200, body: { booking: booking, statuses: ALL_STATUSES } };
    },
  },
  {
    // The status is its own sub-resource rather than a PATCH on the booking,
    // because it is the ONLY thing about a booking this endpoint may change.
    // A PATCH on /api/ops/bookings/:tripId would invite a body that also tried
    // to move the price or the traveller - fields that belong to the booking
    // path and its payment, not to operations.
    method: "PATCH",
    pattern: /^\/api\/ops\/bookings\/([^/]+)\/status$/,
    permission: PERMISSIONS.OPS_BOOKINGS_WRITE,
    handler: async function (context) {
      const tripId = decodeParam(context.params[0]);
      if (tripId === null) {
        return {
          status: 400,
          body: { error: "invalid_trip_id", problems: ["Malformed tripId."] },
        };
      }

      const problems = validateStatusBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = updateBookingStatus({
        tripId: tripId,
        // Passed through unchecked on purpose - the lifecycle owns the
        // vocabulary, and refusing here would lose the audit entry. See the
        // header.
        targetStatus: context.body.status,
        // Who changed it comes from the resolved principal, never from the
        // body. A request cannot nominate who it is acting as.
        actor: context.principal.userId,
        // Always supplied by server.js, which honours a valid inbound
        // X-Correlation-ID so a change can be traced across services.
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      // 200 either way - the booking IS in the state the caller asked for, so
      // this is not an error. `changed` is what tells them whether THEY moved
      // it: false means the booking was already there and nothing was written
      // or audited. A client retrying a request whose response it never saw can
      // read that and show "saved" honestly rather than claiming an edit it did
      // not make.
      return {
        status: 200,
        body: {
          changed: result.changed,
          booking: result.booking,
          statuses: ALL_STATUSES,
        },
      };
    },
  },
];

module.exports = { opsBookingRoutes, validateStatusBody, REFUSAL_STATUS };
