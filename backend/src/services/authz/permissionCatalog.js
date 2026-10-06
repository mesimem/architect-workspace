// STORY-006: every permission the system recognises - the VOCABULARY that
// permissions.js grants to roles. Split out of permissions.js (STORY-012) when
// that file passed CLAUDE.md's 500-line ceiling; the seam is real, not a line
// count: this file names the ACTS, permissions.js decides WHO may do them.
// Nothing imports this directly - permissions.js re-exports both symbols, so
// every existing caller is unchanged. Read permissions.js's header for the model.

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

  // Analytics (STORY-012). Revenue and booking trends across the whole agency.
  // A READ with no write twin: the figures are derived from the booking log on
  // every call, so there is nothing to edit. Its own grant rather than riding
  // on OPS_BOOKINGS_READ or PAYMENTS_ACCOUNTS_READ, because it exposes neither
  // a single booking nor a single balance - only aggregates - and a future
  // reporting integration should be able to hold this without either of those.
  ANALYTICS_READ: "analytics.read",

  // Marketing (STORY-019). READ lists segments and who is in them; WRITE
  // defines a segment, records a customer's contact preference, and sends a
  // campaign. Split because sending email to customers is the action with
  // consequences, and a reporting integration should be able to see segments
  // without being able to mail anyone.
  MARKETING_READ: "marketing.read",
  MARKETING_WRITE: "marketing.write",
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

module.exports = { PERMISSIONS, ALL_PERMISSIONS };
