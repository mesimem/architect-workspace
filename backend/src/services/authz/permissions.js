// STORY-006: what each role is allowed to do. The single source of truth.
//
// Until now the answer to "may this caller do this?" was a `roles: [...]` array
// copied onto each route (see http/routes/*.js). Six copies of a policy is six
// places to forget, and the forgetting is silent: a new route with a roles list
// that is one entry too generous looks exactly like a correct one. This module
// replaces those copies with one table, and routes ask for a PERMISSION instead
// of naming roles.
//
// WHY THAT INDIRECTION IS WORTH IT. A permission names the ACT ("read someone
// else's itinerary"); a role names the KIND OF PERSON. Routes care about the
// act. When a fourth role arrives - a supplier, an auditor - the routes do not
// change at all, only this table does. And because every permission a route can
// ask for is listed here, a route asking for a permission that does not exist
// is a startup error rather than a route nobody can reach.
//
// THE THREE ROLES, AND WHY THEY ARE NOT NESTED.
//   customer  - their own trips, their own bookings. Nothing else.
//   advisor   - the review queue and the catalog. NOT customer data by default.
//   admin     - operates the system: sees the audit trail, assigns roles.
//
// Admin is deliberately NOT "advisor plus more", and advisor is not "customer
// plus more". Role inheritance is the standard shortcut here and it is how
// privilege creep happens: the day someone adds a permission to `customer`
// because a customer needs it, every inheriting role silently gains it too.
// Each role's grants are written out in full. It is more lines and it is the
// only version you can audit by reading.
//
// ADMIN IS NOT A SUPERUSER. It has no `portal.trips.read` and no
// `requests.triage`, because an admin is not a customer and has no itineraries
// of their own. "Admin can do everything" is what turns one compromised admin
// token into total data access. If an admin genuinely needs to see a customer's
// trips, that is a distinct permission granted deliberately - not a side effect
// of being an admin.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Two kinds. Asking `can()` about an UNKNOWN
//     role or an UNKNOWN permission returns false - deny by default, because
//     the safe answer to a question we do not understand is no. Asking
//     `assertKnownPermission()` about an unknown permission THROWS, because
//     that call site is startup-time route validation, where a typo must stop
//     the server rather than produce a route nobody can reach.
//  2. Will it retry? Nothing to retry. This module is pure: no I/O, no clock,
//     no state. The same inputs always give the same answer.
//  3. Recovery path? A wrong grant here is fixed by editing this table and
//     redeploying. There is no runtime override, on purpose - a permission
//     table that can be changed at runtime is a permission table an attacker
//     can change at runtime.
//  4. Handled here: unknown roles, unknown permissions, non-string inputs,
//     prototype-chain keys ("constructor", "toString"), and callers mutating
//     the table they are handed. NOT handled: per-resource rules ("this
//     advisor may see THIS customer"), time-bounded grants, and delegation -
//     all of which need a policy engine, not a table, and none of which
//     REQ-008 asks for.

// Every permission the system recognises. A route may only ask for one of
// these. Grouped by area, named <area>.<resource>.<verb> so the list stays
// readable as it grows.
const PERMISSIONS = Object.freeze({
  // Portal - a customer acting on their own data.
  PORTAL_TRIPS_READ: "portal.trips.read",
  PORTAL_SESSION_END: "portal.session.end",

  // Requests - submitting something for triage.
  REQUESTS_TRIAGE: "requests.triage",

  // Advisor - the human-review queue.
  ADVISOR_REVIEWS_READ: "advisor.reviews.read",

  // Catalog - destination browsing. The least sensitive thing here.
  CATALOG_READ: "catalog.read",

  // Administration. These three are the reason this story exists.
  ADMIN_ROLES_READ: "admin.roles.read",
  ADMIN_ROLES_ASSIGN: "admin.roles.assign",
  ADMIN_AUDIT_READ: "admin.audit.read",
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

// The table. Written out per role, no inheritance - see the header.
//
// Read this as the answer to "if this token leaked, what could the holder
// do?", because that is the question it actually answers.
const ROLE_PERMISSIONS = Object.freeze({
  customer: Object.freeze([
    PERMISSIONS.PORTAL_TRIPS_READ,
    PERMISSIONS.PORTAL_SESSION_END,
    PERMISSIONS.REQUESTS_TRIAGE,
    PERMISSIONS.CATALOG_READ,
  ]),

  advisor: Object.freeze([
    PERMISSIONS.ADVISOR_REVIEWS_READ,
    PERMISSIONS.REQUESTS_TRIAGE,
    PERMISSIONS.CATALOG_READ,
    // An advisor logs out of their own session like anyone else. Ending YOUR
    // OWN session is not a privilege, and withholding it would mean an advisor
    // could never revoke a token they thought was compromised.
    PERMISSIONS.PORTAL_SESSION_END,
  ]),

  admin: Object.freeze([
    PERMISSIONS.ADMIN_ROLES_READ,
    PERMISSIONS.ADMIN_ROLES_ASSIGN,
    PERMISSIONS.ADMIN_AUDIT_READ,
    PERMISSIONS.PORTAL_SESSION_END,
    // Note what is absent: PORTAL_TRIPS_READ, ADVISOR_REVIEWS_READ,
    // REQUESTS_TRIAGE. An admin administers; it does not get to read customer
    // itineraries as a perk of the job. See "ADMIN IS NOT A SUPERUSER" above.
  ]),
});

const ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

class UnknownPermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnknownPermissionError";
    this.errorClass = "ConfigError";
  }
}

// Object.prototype.hasOwnProperty.call, not `role in ROLE_PERMISSIONS` and not
// `ROLE_PERMISSIONS[role]`. Both of those say yes to "constructor" and
// "toString", which arrive from a request body more often than anyone expects:
// a caller posting { role: "constructor" } would otherwise get a truthy lookup
// and a function where a permission array should be.
function isKnownRole(role) {
  return typeof role === "string" && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

function isKnownPermission(permission) {
  return typeof permission === "string" && ALL_PERMISSIONS.includes(permission);
}

// THE ONE FUNCTION EVERY ACCESS DECISION GOES THROUGH.
//
// Deny by default, in both directions. An unknown role cannot do anything, and
// no role can do an unknown thing. That second half matters more than it
// looks: if a route asks for a permission that was renamed, this returns false
// and the route 403s, rather than the rename accidentally opening it up.
function can(role, permission) {
  if (!isKnownRole(role) || !isKnownPermission(permission)) {
    return false;
  }
  return ROLE_PERMISSIONS[role].includes(permission);
}

// Startup-time validation for the route table. Throws rather than returning
// false, because at this call site a false would produce a route that is
// silently unreachable, and an unreachable route is discovered by a customer,
// not by us.
function assertKnownPermission(permission, context) {
  if (!isKnownPermission(permission)) {
    throw new UnknownPermissionError(
      "Unknown permission " +
        JSON.stringify(permission) +
        (context ? " required by " + context : "") +
        ". Known permissions: " +
        ALL_PERMISSIONS.join(", ") +
        "."
    );
  }
}

// A copy, so a caller cannot edit the live table through what it is handed.
// Returns [] for an unknown role rather than throwing: callers asking "what
// can this role do?" are usually building a response, and an empty list is the
// truthful answer for a role that does not exist.
function permissionsFor(role) {
  return isKnownRole(role) ? ROLE_PERMISSIONS[role].slice() : [];
}

module.exports = {
  can,
  isKnownRole,
  isKnownPermission,
  assertKnownPermission,
  permissionsFor,
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLES,
  UnknownPermissionError,
};
