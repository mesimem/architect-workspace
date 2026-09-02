// STORY-005: the customer portal's routes.
//
// Extracted from server.js when that file crossed CLAUDE.md's 500-line hard
// ceiling, which requires a split before new code lands. The line the split
// follows: server.js owns HTTP MECHANICS (reading a body, authenticating,
// shaping an error, logging a request), and each module in this folder owns
// one area's ENDPOINTS. A route module never touches the socket - it returns
// { status, body, headers? } and lets the pipeline send it.
//
// Every handler here receives the context the pipeline builds:
//   { body, params, principal, correlationId, bearerToken, credentials }
// `principal` is null on a public route, and only the login route is public.

const {
  login,
  logout,
  STATUSES: LOGIN_STATUSES,
} = require("../../services/portal/portalLoginService");
const {
  listItineraries,
  getItinerary,
  STATUSES: ITINERARY_STATUSES,
} = require("../../services/portal/itineraryService");

// Envelope validation for the login body. Deliberately checks only that the
// two fields are strings of a sane size - NOT whether the password looks
// right, and NOT a minimum length. A length rule here would tell an attacker
// the shape of valid passwords, and it would reject a legitimate customer
// whose password predates the rule. Whether the pair is correct is the
// credential module's judgement, and it returns one answer either way.
const MAX_LOGIN_FIELD_LENGTH = 1024;

function validateLoginBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  const problems = [];
  for (const field of ["customerId", "password"]) {
    if (typeof body[field] !== "string" || body[field] === "") {
      problems.push(field + " must be a non-empty string");
    } else if (body[field].length > MAX_LOGIN_FIELD_LENGTH) {
      problems.push(field + " must be at most " + MAX_LOGIN_FIELD_LENGTH + " characters");
    }
  }
  return problems;
}

// Login outcome -> HTTP status. A table rather than a chain of ifs, so a new
// status added to the service shows up here as an explicit 500 (see the
// lookup below) instead of being quietly reported as a success.
const LOGIN_STATUS_CODES = {
  [LOGIN_STATUSES.AUTHENTICATED]: 200,
  [LOGIN_STATUSES.INVALID_CREDENTIALS]: 401,
  [LOGIN_STATUSES.LOCKED_OUT]: 429,
  [LOGIN_STATUSES.AUDIT_UNAVAILABLE]: 503,
};

const portalRoutes = [
  {
    method: "POST",
    pattern: /^\/api\/portal\/login$/,
    // THE ONLY PUBLIC ROUTE IN THE BUILD. It has to be: a customer cannot
    // present a credential before they have one. Everything that makes that
    // safe lives behind it - the throttle, the generic refusal, the audit
    // entry per attempt - not in front of it.
    public: true,
    roles: [],
    handler: async function (context) {
      const problems = validateLoginBody(context.body);
      if (problems.length > 0) {
        // A malformed submission is refused at the envelope, and that means it
        // is NOT audited as a login attempt - there was no attempt, just a
        // client sending the wrong shape. A caller who omits `password`
        // entirely never reaches the credential check.
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      if (!context.credentials) {
        // Fail closed. No credential table means no login can be verified, so
        // every login is refused - never allowed. See createServer.
        return {
          status: 503,
          body: {
            error: "portal_login_unconfigured",
            message: "Sign-in is not available. Please contact your travel advisor.",
          },
        };
      }

      const result = await login(
        {
          customerId: context.body.customerId,
          password: context.body.password,
          correlationId: context.correlationId,
        },
        { credentials: context.credentials }
      );

      const status = LOGIN_STATUS_CODES[result.status] || 500;

      if (result.status !== LOGIN_STATUSES.AUTHENTICATED) {
        return {
          status: status,
          body: { error: result.status, message: result.message },
          // Retry-After is the standard way to say "later" and lets a decent
          // client stop hammering us.
          headers: result.retryAfterSeconds
            ? { "Retry-After": String(result.retryAfterSeconds) }
            : undefined,
        };
      }

      // The token is returned here and never again. Timestamps go out as ISO
      // strings rather than the epoch milliseconds the store keeps, because
      // this is a published contract and a bare number is ambiguous.
      return {
        status: 200,
        body: {
          status: "authenticated",
          token: result.token,
          customerId: result.session.customerId,
          role: result.session.role,
          expiresAt: new Date(result.session.absoluteExpiresAt).toISOString(),
          idleExpiresAt: new Date(result.session.idleExpiresAt).toISOString(),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/portal\/logout$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      // Idempotent by construction: revoking an already-dead session reports
      // endedSession: false and is still audited. Both facts matter to an
      // incident review.
      const result = logout({
        token: context.bearerToken,
        customerId: context.principal.userId,
        correlationId: context.correlationId,
      });
      return {
        status: result.status === LOGIN_STATUSES.AUDIT_UNAVAILABLE ? 503 : 200,
        body: { status: result.status, endedSession: result.endedSession },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/portal\/trips$/,
    // Customers only. An advisor has no itineraries of their own, so this
    // route would return them an empty list; viewing a customer's trips ON
    // THEIR BEHALF is a permission, and permissions are STORY-006's work.
    // Better an honest 403 now than an advisor-shaped hole opened early.
    roles: ["customer"],
    handler: async function (context) {
      // THE CUSTOMER ID COMES FROM THE SESSION, NEVER FROM THE REQUEST. There
      // is no query parameter to override it and no body to carry one. This is
      // the line that makes "unauthorized access" unreachable rather than
      // merely checked: you cannot ask for someone else's trips, so there is
      // no comparison to get wrong.
      const result = listItineraries({ customerId: context.principal.userId });
      return {
        status: result.status === ITINERARY_STATUSES.OK ? 200 : 400,
        body: result,
      };
    },
  },
  {
    method: "GET",
    // Bounded in the pattern itself, so an absurd id never reaches a service.
    pattern: /^\/api\/portal\/trips\/([A-Za-z0-9-]{1,64})$/,
    roles: ["customer"],
    handler: async function (context) {
      const result = getItinerary({
        customerId: context.principal.userId,
        tripId: context.params[0],
      });
      // 404 for a trip that is not theirs, deliberately - NOT 403. A 403 would
      // confirm the trip exists, and walking TRIP-1..TRIP-500 would then map
      // every booking in the business. The service returns the same answer for
      // both cases; this table keeps them the same status code.
      const statusByOutcome = {
        ok: 200,
        not_found: 404,
        invalid_request: 400,
      };
      return { status: statusByOutcome[result.status] || 500, body: result };
    },
  },
];

module.exports = { portalRoutes, validateLoginBody, MAX_LOGIN_FIELD_LENGTH };
