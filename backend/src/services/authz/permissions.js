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
// THE FIVE ROLES, AND WHY THEY ARE NOT NESTED.
//   customer        - their own trips, their own bookings. Nothing else.
//   advisor         - the review queue and the catalog. NOT customer data by
//                     default.
//   admin           - operates the system: sees the audit trail, assigns roles.
//   sales           - the CRM: leads, and the booking history of customers they
//                     hold a relationship with. NOT the system, NOT the review
//                     queue.
//   product_manager - the inventory: authors safari packages, their itineraries
//                     and their prices. NOT customer data, NOT the CRM, NOT the
//                     system.
//   operations_manager - delivery: the booking board, and moving each booking
//                     along its lifecycle. NOT the CRM, NOT authoring products,
//                     NOT the audit trail that records what they did.
//   finance         - payment accounts: opens what a customer owes, reads
//                     balances. NOT paying on a customer's behalf (STORY-011).
//
// STORY-015 added `product_manager` for the same reason STORY-014 added
// `sales`, and against the same alternative. Giving the product grants to
// `advisor` was the cheaper change, and it would have meant every advisor could
// reprice any package the agency sells - a much larger blast radius for a
// leaked advisor token, in exchange for one fewer row in this table. An advisor
// gets PRODUCTS_READ instead: sell from the catalog, do not author it. That
// read/write split is the whole point of having the two permissions.
//
// STORY-014 added `sales` rather than widening `advisor`, which is the change
// this file's own header predicted ("when a fourth role arrives ... only this
// table does"). The alternative was to give advisor the CRM grants, and the
// line above it - "NOT customer data by default" - is exactly the rule that
// would have had to be deleted to do it. A rule you delete to make today's
// story fit is not a rule. Leads and booking history are customer data; the
// role that reads them is named for that job and holds nothing else.
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

// The vocabulary - every permission, with the reasoning for each split - lives
// in permissionCatalog.js. This file is the table that grants them.
const { PERMISSIONS, ALL_PERMISSIONS } = require("./permissionCatalog");

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
    // STORY-007: their own quotes, in the customer view. Note what is absent -
    // QUOTES_READ, the staff grant that carries costs and margins.
    PERMISSIONS.PORTAL_QUOTES_READ,
    // STORY-009: asking for trip ideas. This is the customer's own act, about
    // their own preferences, and REQ-011 exists to serve them - so if any role
    // holds it, this one must.
    PERMISSIONS.SUGGESTIONS_REQUEST,
    // STORY-011: their own balances, and paying them.
    PERMISSIONS.PORTAL_PAYMENTS_READ,
    PERMISSIONS.PORTAL_PAYMENTS_WRITE,
  ]),

  advisor: Object.freeze([
    PERMISSIONS.ADVISOR_REVIEWS_READ,
    PERMISSIONS.REQUESTS_TRIAGE,
    PERMISSIONS.CATALOG_READ,
    // STORY-007: quoting is the advisor's job, so both halves sit here. This
    // does NOT widen "NOT customer data by default" above: a quote is a
    // document the advisor writes, not a record about a customer they were
    // never given. Reading a customer's BOOKINGS still needs the sales grant.
    PERMISSIONS.QUOTES_READ,
    PERMISSIONS.QUOTES_WRITE,
    // STORY-013: creating trip proposals is the same job as quoting, one step
    // earlier, so all three sit with the advisor. The sweep is here because
    // today an advisor is the only principal who could run it; when a scheduled
    // worker exists it gets PROPOSALS_SLA_SWEEP and none of the rest, which is
    // the whole reason that one is split out.
    PERMISSIONS.PROPOSALS_READ,
    PERMISSIONS.PROPOSALS_WRITE,
    PERMISSIONS.PROPOSALS_SLA_SWEEP,
    // STORY-015: READ ONLY. An advisor quotes from the product book, so they
    // need to see a package's itinerary and its price - including the cost,
    // because that is what a margin conversation with a customer rests on. They
    // cannot author or reprice one; PRODUCTS_WRITE sits with product_manager
    // alone. This is the read/write split doing its job.
    PERMISSIONS.PRODUCTS_READ,
    // STORY-017: BOTH halves. The story is written in the advisor's voice -
    // "as a travel advisor, I want to combine multiple travel products into
    // one package" - and composing an offering out of the catalogue is selling
    // work, which is this role's job. Note how this sits against the line
    // above: an advisor may combine the Masai Mara package into an offering
    // and may NOT change what the Masai Mara package costs. That is the
    // read/write split on products doing exactly the work it was added for.
    PERMISSIONS.PACKAGES_READ,
    PERMISSIONS.PACKAGES_WRITE,
    // STORY-010: BOTH halves, and this is the only role that holds either.
    // Managing supplier information is the advisor's own job - the story is
    // written in their voice - and it is the same job as quoting, one step
    // further back: you cannot price a trip honestly without knowing what the
    // lodge actually charges under the contract we signed.
    //
    // Deliberately NOT given to product_manager, which is the role it most
    // resembles. A product manager prices packages against supplier cost, so a
    // read there is arguable - but arguable is not a reason to grant it. One
    // row is cheap to add the day a story asks; a grant made on a guess is
    // discovered years later by reading a leaked token's blast radius.
    //
    // Deliberately NOT given to admin either, for the reason the table already
    // applies to sales: admin holds ADMIN_AUDIT_READ, and the trail is what
    // records who changed a supplier's terms. A role that can both alter a
    // contract and read the record of having altered it is the conflict of
    // interest this table keeps breaking up.
    PERMISSIONS.SUPPLIERS_READ,
    PERMISSIONS.SUPPLIERS_WRITE,
    // STORY-009: an advisor pulls up trip ideas while working a request - it
    // is the same job as quoting, one step earlier still. Note that holding
    // this does NOT let them read anyone else's suggestions; there is no read
    // grant, because there is no read route. The record of what was suggested
    // lives in the audit trail, which is admin.audit.read.
    PERMISSIONS.SUGGESTIONS_REQUEST,
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
    // STORY-016: operating the system includes knowing whether it is coping.
    // This is the role the table already describes as the one that "operates
    // the system", so if any human role holds it, this is the one - and it is
    // the ONLY role that holds it. An advisor does not need latency
    // percentiles to sell a safari, and a customer holding this would learn
    // how close the agency is to its capacity ceiling.
    PERMISSIONS.OPS_METRICS_READ,
    // STORY-012: aggregate revenue and booking trends, for running the business.
    // Aggregates only - no customer record, no single booking - so this does not
    // breach "ADMIN IS NOT A SUPERUSER" above.
    PERMISSIONS.ANALYTICS_READ,
    // Note what is absent: PORTAL_TRIPS_READ, ADVISOR_REVIEWS_READ,
    // REQUESTS_TRIAGE. An admin administers; it does not get to read customer
    // itineraries as a perk of the job. See "ADMIN IS NOT A SUPERUSER" above.
    //
    // STORY-014: nor does it get the CRM. An admin can GRANT the sales role
    // (ADMIN_ROLES_ASSIGN) and that act is audited; it cannot quietly read the
    // lead book itself. Granting yourself access leaves a record, which is the
    // whole difference between an admin and a superuser.
  ]),

  // STORY-014. A sales manager works the relationship: takes leads in, reads
  // the book back, looks at what a customer has already bought. Deliberately
  // absent: ADMIN_AUDIT_READ (the audit trail records what sales did, so sales
  // reading it is a conflict of interest), ADVISOR_REVIEWS_READ (triage is not
  // their job), and PORTAL_TRIPS_READ (that permission means "my own trips",
  // and a sales manager has none - CRM_CUSTOMERS_READ is the grant that lets
  // them see someone else's).
  sales: Object.freeze([
    PERMISSIONS.CRM_LEADS_READ,
    PERMISSIONS.CRM_LEADS_WRITE,
    PERMISSIONS.CRM_CUSTOMERS_READ,
    PERMISSIONS.CATALOG_READ,
    // Ending your own session is not a privilege - same reasoning as advisor.
    PERMISSIONS.PORTAL_SESSION_END,
  ]),

  // STORY-015. A product manager authors what the agency sells: the package,
  // the day-by-day itinerary, the cost and the price. Deliberately absent:
  // CRM_LEADS_READ and CRM_CUSTOMERS_READ (authoring inventory is not a reason
  // to read who bought it), ADMIN_AUDIT_READ (the trail records what a product
  // manager did to a price, so reading it is the same conflict of interest that
  // keeps it away from sales), QUOTES_* and PROPOSALS_* (pricing a package is
  // not the same job as quoting a customer, and a product manager has no
  // customers), and ADVISOR_REVIEWS_READ.
  //
  // CATALOG_READ is here because authoring a package means looking at the
  // destinations it visits.
  product_manager: Object.freeze([
    PERMISSIONS.PRODUCTS_READ,
    PERMISSIONS.PRODUCTS_WRITE,
    // STORY-017: BOTH halves, granted DELIBERATELY rather than inherited. The
    // story names the advisor, so this row is the one that needed an argument
    // of its own: a product manager who authors the components is the other
    // principal who combines them, and a catalogue package assembled from
    // in-house products is inventory work as much as it is selling work.
    //
    // This is the grant most likely to be wrong, so here is the test to apply
    // if it is ever revisited: if the agency's product managers turn out not to
    // build packages, delete these two lines. Nothing else changes - the
    // permission stays, the routes stay, and the advisor keeps working. A grant
    // that can be withdrawn by deleting two rows is the shape a debatable grant
    // should have.
    PERMISSIONS.PACKAGES_READ,
    PERMISSIONS.PACKAGES_WRITE,
    PERMISSIONS.CATALOG_READ,
    // Ending your own session is not a privilege - same reasoning as advisor.
    PERMISSIONS.PORTAL_SESSION_END,
  ]),

  // STORY-018. Delivery: what the agency has sold and has to arrange. This role
  // watches the booking board and moves each booking along its lifecycle.
  //
  // WHY A SIXTH ROLE RATHER THAN A GRANT ON AN EXISTING ONE. The story is
  // written in the operations manager's voice, and no existing role is that
  // person. The two candidates were both refused for the same reason the header
  // gives for `sales` and `product_manager`: the cheaper change has the larger
  // blast radius.
  //
  //   admin - operates the SYSTEM. Putting the booking board here would mean
  //           the role that reads the audit trail and assigns roles is also the
  //           role that can cancel bookings, so there would be no one who could
  //           be given operations work without also being handed the system.
  //   sales - holds customer relationships. The booking board is every
  //           customer's booking at once, which is a strictly wider read than
  //           the relationship-scoped one CRM_CUSTOMERS_READ was argued for.
  //
  // WHAT THIS ROLE DELIBERATELY DOES NOT HOLD, and these absences are the point
  // of it being its own row: CRM_* (arranging a trip does not require the lead
  // pipeline or a customer's full purchase history), PRODUCTS_WRITE and
  // PACKAGES_WRITE (operations deliver what was sold; they do not reprice or
  // re-author it), QUOTES_* and PROPOSALS_* (selling is not delivering),
  // ADMIN_* including ADMIN_AUDIT_READ - and that last one matters most. The
  // trail records what an operations manager did to a booking, so reading it is
  // the same conflict of interest that keeps it away from sales and product
  // manager. Someone who can both change a status and read the record of who
  // changed it is a weaker control than two people.
  operations_manager: Object.freeze([
    PERMISSIONS.OPS_BOOKINGS_READ,
    PERMISSIONS.OPS_BOOKINGS_WRITE,
    // Arranging a booking means looking at what was actually sold: the safari's
    // itinerary and the package it was part of. READ ONLY on both - see the
    // absences above.
    PERMISSIONS.PRODUCTS_READ,
    PERMISSIONS.PACKAGES_READ,
    // The destinations those products visit, for the same reason.
    PERMISSIONS.CATALOG_READ,
    // Ending your own session is not a privilege - same reasoning as advisor.
    PERMISSIONS.PORTAL_SESSION_END,
  ]),

  // STORY-011. The Finance Manager the story names: opens payment accounts and
  // reads balances across customers. A seventh role rather than a grant on
  // admin, for the reason given for operations_manager - admin reads the audit
  // trail that records what finance did. Deliberately absent: ADMIN_*, CRM_*,
  // and PORTAL_PAYMENTS_WRITE - finance opens what is owed, it never pays on a
  // customer's behalf.
  finance: Object.freeze([
    PERMISSIONS.PAYMENTS_ACCOUNTS_READ,
    PERMISSIONS.PAYMENTS_ACCOUNTS_WRITE,
    // STORY-012: revenue trends are finance's own question.
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.PORTAL_SESSION_END,
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
