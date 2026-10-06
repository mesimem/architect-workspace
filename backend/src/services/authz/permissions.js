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

// Every permission the system recognises. A route may only ask for one of
// these. Grouped by area, named <area>.<resource>.<verb> so the list stays
// readable as it grows.
const PERMISSIONS = Object.freeze({
  // Portal - a customer acting on their own data.
  PORTAL_TRIPS_READ: "portal.trips.read",
  PORTAL_SESSION_END: "portal.session.end",
  // STORY-007. Separate from PORTAL_TRIPS_READ because a quote and a booking
  // are different things: a trip is what a customer has bought, a quote is
  // what they have been offered. Reading the second is not implied by the
  // first, and a future read-only sharing link wants one without the other.
  PORTAL_QUOTES_READ: "portal.quotes.read",

  // Requests - submitting something for triage.
  REQUESTS_TRIAGE: "requests.triage",

  // Advisor - the human-review queue.
  ADVISOR_REVIEWS_READ: "advisor.reviews.read",

  // Quotes (STORY-007). The STAFF side of quoting - reading a quote WITH its
  // costs and margins, and issuing or revising one. Split from the customer's
  // PORTAL_QUOTES_READ above rather than reusing it, because the two grants
  // reach different documents: the customer's view of a quote never contains
  // a cost, and this one is defined by the fact that it does.
  //
  // Read and write are split for the same reason CRM_LEADS_READ and
  // CRM_LEADS_WRITE are: a future reporting or margin-analysis integration
  // needs to read the quote book without being able to change what a customer
  // has been offered.
  QUOTES_READ: "quotes.read",
  QUOTES_WRITE: "quotes.write",

  // Proposals (STORY-013). The advisor's timed workspace: open a proposal,
  // issue it, read it back with its costs and its SLA position.
  //
  // SEPARATE FROM QUOTES_READ / QUOTES_WRITE, even though a proposal is priced
  // by the same code. The two grants reach different things: a quote is a
  // document that has been issued to a customer, a proposal is a piece of work
  // in progress with a deadline attached. A future margin-analysis integration
  // wants the quote book without the ability to open work on an advisor's desk,
  // and a future scheduling worker wants the reverse.
  PROPOSALS_READ: "proposals.read",
  PROPOSALS_WRITE: "proposals.write",
  // Deliberately its own grant, and the narrowest one here. Running the sweep
  // SENDS MESSAGES TO PEOPLE - it is the only permission in this table whose
  // exercise an advisor feels on their phone. Splitting it means the scheduled
  // job that will eventually run it can be given exactly this and nothing else:
  // it never needs to open, issue or read a proposal to do its job.
  PROPOSALS_SLA_SWEEP: "proposals.sla.sweep",

  // Catalog - destination browsing. The least sensitive thing here.
  CATALOG_READ: "catalog.read",

  // Trip suggestions (STORY-009). Asking the system for trip ideas.
  //
  // SEPARATE FROM CATALOG_READ, which is the thing it most resembles. Browsing
  // the catalog is a read; asking for suggestions WRITES - an audit row every
  // time, and a review-queue row whenever the answer is thin. Granting it with
  // catalog.read would mean any future read-only integration given the catalog
  // could also fill the advisor queue. A permission is named for the act, and
  // these are two different acts.
  SUGGESTIONS_REQUEST: "suggestions.request",

  // Safari products (STORY-015). The AUTHORED inventory: a package, its
  // day-by-day itinerary, and what it costs us against what we sell it for.
  //
  // SEPARATE FROM CATALOG_READ, which every role here holds. catalog.read is
  // the customer-facing destination lookup (africa/catalogSource.js) and
  // carries no cost figure. A product record carries pricing.internal - our
  // supplier cost and our margin - so reading one is a different act from
  // browsing a destination, and it is granted to staff only. A customer who
  // held this would be reading our margin.
  //
  // Read and write are split because they leak differently: a read exposes the
  // margin on every package at once, a write can change what the agency
  // charges. Splitting them is what lets an advisor sell from the catalog
  // without being able to reprice it.
  PRODUCTS_READ: "products.read",
  PRODUCTS_WRITE: "products.write",

  // Travel packages (STORY-017). Combining products the agency already sells
  // into ONE offering: which products, in what order, and at what package
  // discount.
  //
  // SEPARATE FROM PRODUCTS_READ / PRODUCTS_WRITE, which it most resembles, and
  // the split is the reason both exist. Authoring a product sets what the
  // agency charges for a thing it sells; combining products sets what it offers
  // as a journey. They are held by overlapping but not identical roles - an
  // advisor composes packages and may NOT reprice the products inside them,
  // which is precisely the boundary products.write draws. Folding packages into
  // products.write would have handed every package-building advisor the ability
  // to reprice the whole catalogue, which is the larger blast radius for a
  // leaked advisor token and the exact trade the PRODUCTS_READ comment above
  // already refused once.
  //
  // Read and write are split because they leak differently - a read exposes the
  // margin on every offering at once (a package carries pricing.internal, same
  // as a product), a write can change what the agency offers. Splitting them is
  // what lets a future catalogue or reporting integration read the package book
  // without being able to alter an offering.
  PACKAGES_READ: "packages.read",
  PACKAGES_WRITE: "packages.write",

  // Suppliers (STORY-010). Who the agency BUYS from: the business, the
  // contracts signed with them, and the rate card under each contract.
  //
  // THE MOST COST-SENSITIVE READ IN THIS TABLE. A product record carries our
  // margin on one package; a supplier record carries the cost base those
  // margins are computed from, for every package that supplier appears in. So
  // this is granted to staff only, and narrowly: a customer holding
  // suppliers.read would be reading what we pay, which is the one figure that
  // makes every quote we have ever issued negotiable.
  //
  // Read and write are split because they leak differently - a read exposes the
  // whole cost base at once, a write can change what we believe we owe under a
  // signed agreement. Splitting them is what lets a future margin-analysis or
  // reporting integration read the book without being able to alter a contract.
  SUPPLIERS_READ: "suppliers.read",
  SUPPLIERS_WRITE: "suppliers.write",

  // Administration. These three are the reason this story exists.
  ADMIN_ROLES_READ: "admin.roles.read",
  ADMIN_ROLES_ASSIGN: "admin.roles.assign",
  ADMIN_AUDIT_READ: "admin.audit.read",

  // STORY-016. Reading the system's own performance numbers: latency
  // percentiles, success and failure rates, how saturated the instance is.
  //
  // SEPARATE FROM ADMIN_AUDIT_READ, which it most resembles - both are "look
  // at the system rather than the business". The difference is what they are
  // FOR and who should eventually hold them. The audit trail is evidence about
  // PEOPLE: who changed a supplier's terms, whose access was denied. Metrics
  // are evidence about the MACHINE, and they carry no actor, no customer and no
  // money. That makes this the one grant it is safe to hand to a monitoring
  // integration - a Grafana scraper or an on-call dashboard - and the whole
  // point of splitting it is that doing so must not also hand over the audit
  // trail. One row here is cheaper than explaining that conflation later.
  //
  // Note that this is a READ with no write twin. There is nothing to write:
  // metrics are produced by serving traffic, and an endpoint that let a caller
  // reset or edit them would be an endpoint for making an outage disappear.
  OPS_METRICS_READ: "ops.metrics.read",

  // CRM (STORY-014). Read and write are split because they leak differently:
  // a read exposes every lead in the book at once, a write can only corrupt
  // one record at a time. Splitting them means a future reporting integration
  // can be given the read without the ability to edit anything.
  // The operations booking board (STORY-018). Read and write are split for the
  // same reason as everywhere else in this table, and here the asymmetry is
  // unusually sharp: the READ exposes every booking the agency holds in one
  // response - who is travelling, where, and for how much - while the WRITE can
  // only move one booking along a four-state lifecycle that refuses to leave a
  // terminal state. So the read is the more dangerous of the two, which is the
  // opposite of the usual intuition and the reason a future reporting or
  // finance integration must be given the read deliberately rather than as a
  // side effect of being allowed to manage statuses.
  //
  // SEPARATE FROM CRM_CUSTOMERS_READ, which it most resembles - both show what
  // customers have bought. The difference is the question each answers.
  // CRM_CUSTOMERS_READ answers "what has this customer booked with us", for a
  // salesperson holding that relationship. This one answers "what does the
  // agency have to deliver", across all customers, for whoever is arranging it.
  // Conflating them would mean that managing operations required a grant over
  // the CRM, or that holding the CRM silently included the operations board.
  OPS_BOOKINGS_READ: "ops.bookings.read",
  OPS_BOOKINGS_WRITE: "ops.bookings.write",

  CRM_LEADS_READ: "crm.leads.read",
  CRM_LEADS_WRITE: "crm.leads.write",
  // Separate from CRM_LEADS_READ: a lead is someone who asked about a trip, a
  // customer's booking history is what they have actually paid for. The second
  // is the more sensitive of the two and does not come free with the first.
  CRM_CUSTOMERS_READ: "crm.customers.read",

  // Payments (STORY-011). The customer's side: read and pay down THEIR OWN
  // balances - ownership is enforced per account in customerPaymentService.
  // Split because paying moves money and reading does not.
  PORTAL_PAYMENTS_READ: "portal.payments.read",
  PORTAL_PAYMENTS_WRITE: "portal.payments.write",
  // The finance side: open an account for what a customer owes, and read any
  // account. Separate from the portal grants because these reach every
  // customer's balance, not one's own.
  PAYMENTS_ACCOUNTS_READ: "payments.accounts.read",
  PAYMENTS_ACCOUNTS_WRITE: "payments.accounts.write",
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
