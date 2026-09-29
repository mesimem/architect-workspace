// STORY-014: the CRM over HTTP - the lead book and the customer accounts.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, on purpose. It maps a
// request onto a service call and a service result onto a status code. The
// rules about what a lead is, when two captures are the same person, and what
// gets audited all live in ../../services/crm/, because those are decisions and
// this is plumbing. A rule implemented in a route is a rule that only applies
// to callers who arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it, once, before the handler runs - and audits
// every refusal. A second check in here would be a second policy that can
// disagree with the first, which is the whole reason STORY-006 centralised it.
// The story's "unauthorized data access" failure path is therefore tested
// against these routes rather than handled in them.
//
// WHY VALIDATION HERE IS ONLY THE ENVELOPE. The rule adminRoutes.js:98 sets
// out applies here too: this checks the SHAPE ("is this a JSON object?") and
// nothing else. It deliberately does NOT check that the email is well-formed
// or that the source is a known one, even though it easily could. Those
// refusals are audited by leadStore, and rejecting them here would return the
// same 400 to the caller while quietly losing the audit entry - a rejected
// lead that leaves no trace. The boundary's job is to stop nonsense that never
// reached a decision; a malformed email DID reach one.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to an explicit
//     status via REFUSAL_STATUS below; an unmapped reason becomes 500 rather
//     than a misleading 400, because an unrecognised refusal is our bug and
//     should read like one. A malformed path parameter is a 400.
//  2. Will it retry? Nothing here retries. The operations are safe for the
//     CALLER to retry: POST dedups on (email + source), PATCH dedups on the
//     correlationId, and both GETs are reads.
//  3. Recovery path? The caller gets an error code and, for a validation
//     failure, the full problem list, so a form can be corrected and
//     re-submitted without guessing.
//  4. Handled: non-object bodies, a missing or malformed leadId in the path,
//     percent-encoding that cannot be decoded, unknown leads, duplicates and
//     every validation refusal. NOT handled: pagination of the lead list or
//     the customer roster (STORY-016 owns scale), and lead deletion - there is
//     no delete route, because "lost" is a status and erasing a lead erases
//     the audit trail's subject.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  createLead,
  updateLead,
  listLeads,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MUTABLE_FIELDS,
} = require("../../services/crm/leadStore");
const {
  getCustomerRecord,
  listCustomers,
  STATUSES: CUSTOMER_STATUSES,
} = require("../../services/crm/customerRecord");

// Service refusal reason -> HTTP status. Written as a table so that adding a
// refusal to the service and forgetting it here produces a 500 (loud) rather
// than a 400 (plausible, and wrong).
const REFUSAL_STATUS = Object.freeze({
  invalid_lead: 400,
  unknown_fields: 400,
  empty_update: 400,
  unknown_lead: 404,
  // 409, not 400: the submission was well-formed, it just lost a race with a
  // record that already exists. A client can tell those apart and should.
  duplicate_lead: 409,
  // Our bug, not the caller's: server.js always supplies a correlationId, so
  // reaching this means the plumbing broke.
  missing_correlation_id: 500,
});

function refusalResponse(result) {
  const status = REFUSAL_STATUS[result.reason] || 500;
  return {
    status: status,
    body: {
      error: result.reason,
      // The problem list is the service's, and it is written not to echo
      // untrusted input back - see leadStore's validateLead.
      problems: result.problems || [],
    },
  };
}

// Envelope only - see the header.
function validateLeadBody(body) {
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

const crmRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/crm\/leads$/,
    permission: PERMISSIONS.CRM_LEADS_READ,
    handler: async function () {
      const leads = listLeads();
      // The vocabulary ships with the list so a client can build the status and
      // source pickers without hardcoding a copy of the service's enums - a
      // copy that would silently fall out of step the day one is extended.
      return {
        status: 200,
        body: {
          count: leads.length,
          leads: leads,
          sources: LEAD_SOURCES,
          statuses: LEAD_STATUSES,
        },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/crm\/leads$/,
    permission: PERMISSIONS.CRM_LEADS_WRITE,
    handler: async function (context) {
      const problems = validateLeadBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = createLead({
        fullName: context.body.fullName,
        email: context.body.email,
        source: context.body.source,
        notes: context.body.notes,
        // Who captured it comes from the resolved principal, never from the
        // body. A request cannot nominate who it is acting as.
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      // 200 on a replay, 201 only when a row was actually created. A client
      // retrying a submission it is unsure about can tell from the status
      // whether it captured the lead or found it already there.
      return {
        status: result.replayed ? 200 : 201,
        body: { replayed: result.replayed, lead: result.lead },
      };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/crm\/leads\/([^/]+)$/,
    permission: PERMISSIONS.CRM_LEADS_WRITE,
    handler: async function (context) {
      const leadId = decodeParam(context.params[0]);
      if (leadId === null) {
        return { status: 400, body: { error: "invalid_lead_id", problems: ["Malformed leadId."] } };
      }

      const problems = validateLeadBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = updateLead({
        leadId: leadId,
        // The whole body is the patch. leadStore holds the allow-list of what
        // may be edited and refuses anything else by name, so this does not
        // need its own copy of that list to keep in step.
        changes: context.body,
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      return {
        status: 200,
        body: {
          // `changed` is [] on a save that altered nothing. Reporting the
          // fields that actually moved lets a client show "saved" honestly
          // instead of claiming an edit it did not make.
          changed: result.changed,
          unchanged: Boolean(result.unchanged),
          lead: result.lead,
          editable: MUTABLE_FIELDS,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/crm\/customers$/,
    permission: PERMISSIONS.CRM_CUSTOMERS_READ,
    handler: async function () {
      const customers = listCustomers();
      return { status: 200, body: { count: customers.length, customers: customers } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/crm\/customers\/([^/]+)$/,
    permission: PERMISSIONS.CRM_CUSTOMERS_READ,
    handler: async function (context) {
      const customerId = decodeParam(context.params[0]);
      if (customerId === null) {
        return {
          status: 400,
          body: { error: "invalid_customer_id", problems: ["Malformed customerId."] },
        };
      }

      const result = getCustomerRecord({ customerId: customerId });

      if (result.status === CUSTOMER_STATUSES.INVALID_REQUEST) {
        return { status: 400, body: { error: "invalid_customer_id", problems: [result.message] } };
      }
      if (result.status === CUSTOMER_STATUSES.NOT_FOUND) {
        // 404 for "has never booked". Unlike the portal's itinerary route,
        // there is no information to withhold here: the caller already holds
        // crm.customers.read, so telling them an account is empty tells them
        // nothing they are not entitled to ask.
        return { status: 404, body: { error: "unknown_customer", message: result.message } };
      }

      return {
        status: 200,
        body: { customer: result.customer, bookings: result.bookings },
      };
    },
  },
];

module.exports = { crmRoutes, validateLeadBody, REFUSAL_STATUS };
