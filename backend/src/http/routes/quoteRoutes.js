// STORY-007: quotes over HTTP - the advisor's desk and the customer's copy.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, the same as crmRoutes.js:
// it maps a request onto a service call and a service result onto a status
// code. What a quote costs, when a revision is a duplicate, and what a
// customer may see are decided in services/quotes/, because those are
// decisions and this is plumbing. A rule implemented in a route is a rule that
// only applies to callers who arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it once, before the handler runs, and audits
// every refusal. A second check here would be a second policy that can
// disagree with the first.
//
// THE TWO GET ROUTES ARE THE ACCEPTANCE CRITERION MADE ROUTABLE.
//   GET /api/quotes/:id         -> staff. internalQuoteView. costs, margins.
//   GET /api/portal/quotes/:id  -> customer. customerQuoteView. no costs.
// Two paths, two permissions, two projections - not one endpoint that decides
// what to strip based on who is asking. A single endpoint with a conditional
// inside it is one inverted boolean away from showing a customer the margin
// on their own holiday, and that inversion is invisible in review. Here the
// customer path has no access to the internal projection at all: it does not
// import it.
//
// THE CUSTOMER ID COMES FROM THE SESSION, NEVER FROM THE REQUEST, on both
// customer routes - the same rule as /api/portal/trips. There is no query
// parameter to override it, so "show me someone else's quote" is not a request
// that can be expressed, rather than one that is checked and refused.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to a status via
//     REFUSAL_STATUS below; an unmapped reason becomes 500, not a plausible
//     400, because an unrecognised refusal is our bug and should read like one.
//     A quote that cannot be rendered is a 500 with a correlation id, never a
//     200 with a half-built document - see the customer view error path.
//  2. Will it retry? Nothing here retries. POST and PATCH are safe for the
//     CALLER to retry: both dedup on the correlationId the server generates
//     per request, so a resubmitted form with the same id cannot double-issue.
//  3. Recovery path? The caller gets a stable error code plus, for a
//     validation failure, the full problem list, so an advisor can fix the
//     whole form in one pass.
//  4. Handled: non-object bodies, a malformed or percent-broken path
//     parameter, unknown quotes, another customer's quote, every service
//     refusal, and an unrenderable stored record. NOT handled: pagination of
//     the quote list (STORY-016 owns scale), quote deletion (there is no
//     route - a quote is evidence of what was offered), and PDF rendering.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  generateQuote,
  modifyQuote,
  getQuoteForCustomer,
  listQuotesForCustomer,
  getQuoteForStaff,
  MUTABLE_FIELDS,
  REASONS,
} = require("../../services/quotes/quoteStore");
const { customerQuoteView, internalQuoteView } = require("../../services/quotes/quoteView");

// Service refusal reason -> HTTP status. A table, so that adding a refusal to
// the service and forgetting it here produces a 500 (loud) rather than a 400
// (plausible, and wrong).
const REFUSAL_STATUS = Object.freeze({
  [REASONS.INVALID_REQUEST]: 400,
  [REASONS.INVALID_QUOTE]: 400,
  [REASONS.UNKNOWN_FIELDS]: 400,
  [REASONS.EMPTY_UPDATE]: 400,
  [REASONS.UNKNOWN_QUOTE]: 404,
  // 503, not 500: both are temporary conditions where the right client
  // behaviour is to try again, and the request was not at fault.
  [REASONS.NOT_SAVED]: 503,
  [REASONS.AUDIT_UNAVAILABLE]: 503,
  // Our plumbing, not the caller's: server.js always supplies a correlationId,
  // so reaching this means something upstream broke.
  [REASONS.MISSING_CORRELATION_ID]: 500,
});

function refusalResponse(result) {
  return {
    status: REFUSAL_STATUS[result.reason] || 500,
    body: {
      error: result.reason,
      // The problem list is the service's, and it is written not to echo
      // untrusted input back - see quotePricing's describeValue.
      problems: result.problems || [],
    },
  };
}

// Envelope only. This checks the SHAPE ("is this a JSON object?") and nothing
// else: whether the lines price correctly is a decision, that decision is
// audited by the service, and rejecting it here would return the same 400
// while quietly losing the audit entry - a refused quote that leaves no trace.
function validateBodyEnvelope(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  return [];
}

// A path parameter arrives percent-encoded and decodeURIComponent THROWS on a
// malformed sequence ("%" alone). Unguarded that is a 500 on a URL a scanner
// finds within the hour, so it is a 400 here.
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

// A stored record we cannot render honestly. Never a 200 with gaps in it: the
// customer would be looking at a total they might act on. The correlation id
// goes back so the broken row is findable in the audit trail.
function unrenderable(correlationId) {
  return {
    status: 500,
    body: {
      error: "quote_unavailable",
      message: "This quote cannot be displayed. Please contact your travel advisor.",
      correlationId: correlationId,
    },
  };
}

const quoteRoutes = [
  {
    method: "POST",
    pattern: /^\/api\/quotes$/,
    permission: PERMISSIONS.QUOTES_WRITE,
    handler: async function (context) {
      const problems = validateBodyEnvelope(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = generateQuote({
        customerId: context.body.customerId,
        tripReference: context.body.tripReference,
        title: context.body.title,
        lines: context.body.lines,
        currency: context.body.currency,
        discountBasisPoints: context.body.discountBasisPoints,
        customerNote: context.body.customerNote,
        internalNotes: context.body.internalNotes,
        // THE ADVISOR IS THE SESSION, not a field in the body. A quote records
        // who issued it, and a body-supplied actor is an advisor's name that
        // any caller could type.
        actor: context.principal.userId,
        // Server-generated, one per request. This is what makes a resubmitted
        // form idempotent rather than a second quote.
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      const view = internalQuoteView(result.quote);
      if (view === null) {
        return unrenderable(context.correlationId);
      }

      // 200 rather than 201 on a replay: nothing was created the second time,
      // and saying "created" twice for one quote would be a lie a client can
      // act on. Location is sent either way - the resource is there.
      return {
        status: result.replayed ? 200 : 201,
        body: { status: result.replayed ? "replayed" : "generated", quote: view },
        headers: { Location: "/api/quotes/" + result.quote.quoteId },
      };
    },
  },
  {
    method: "PATCH",
    // Bounded in the pattern itself, so an absurd id never reaches a service.
    pattern: /^\/api\/quotes\/([A-Za-z0-9_-]{1,128})$/,
    permission: PERMISSIONS.QUOTES_WRITE,
    handler: async function (context) {
      const quoteId = decodeParam(context.params[0]);
      if (quoteId === null) {
        return { status: 400, body: { error: "invalid_quote_id", problems: ["Malformed quote id."] } };
      }
      const problems = validateBodyEnvelope(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = modifyQuote({
        quoteId: quoteId,
        // The whole body is the change set. The service holds the allow-list
        // (MUTABLE_FIELDS) and refuses anything outside it - one list, checked
        // in one place, rather than a copy here that can fall out of step.
        changes: context.body,
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      const view = internalQuoteView(result.quote);
      if (view === null) {
        return unrenderable(context.correlationId);
      }

      return {
        status: 200,
        body: {
          // Three outcomes a client can tell apart: we revised it, you sent
          // that save twice, or nothing you sent was actually different.
          status: result.replayed ? "replayed" : result.changed ? "modified" : "unchanged",
          // The editable set ships with the response so a client can build its
          // form without hardcoding a copy that silently falls out of step.
          editableFields: MUTABLE_FIELDS,
          quote: view,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/quotes\/([A-Za-z0-9_-]{1,128})$/,
    // The STAFF read - costs and margins. Deliberately a different permission
    // from the customer's, on a different path, returning a different document.
    permission: PERMISSIONS.QUOTES_READ,
    handler: async function (context) {
      const quoteId = decodeParam(context.params[0]);
      const quote = quoteId === null ? null : getQuoteForStaff({ quoteId: quoteId });
      if (!quote) {
        return { status: 404, body: { error: "unknown_quote", message: "No such quote." } };
      }
      const view = internalQuoteView(quote);
      if (view === null) {
        return unrenderable(context.correlationId);
      }
      return { status: 200, body: { quote: view } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/portal\/quotes$/,
    permission: PERMISSIONS.PORTAL_QUOTES_READ,
    handler: async function (context) {
      // Session, not request - see the header.
      const quotes = listQuotesForCustomer({ customerId: context.principal.userId });
      // listQuotesForCustomer has already dropped anything unrenderable, so
      // the map below cannot produce a null. One bad row must not take down a
      // customer's whole list: they still see the quotes we can show honestly.
      return {
        status: 200,
        body: { count: quotes.length, quotes: quotes.map(customerQuoteView) },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/portal\/quotes\/([A-Za-z0-9_-]{1,128})$/,
    permission: PERMISSIONS.PORTAL_QUOTES_READ,
    handler: async function (context) {
      const quoteId = decodeParam(context.params[0]);
      const quote =
        quoteId === null
          ? null
          : getQuoteForCustomer({ customerId: context.principal.userId, quoteId: quoteId });

      // 404 for another customer's quote, deliberately - NOT 403. A 403 would
      // confirm the quote exists, and walking ids would then map out the quote
      // book. The service returns the same answer for both cases; this keeps
      // them the same status code. Same rule as /api/portal/trips/:id.
      if (!quote) {
        return { status: 404, body: { error: "unknown_quote", message: "No such quote." } };
      }

      const view = customerQuoteView(quote);
      if (view === null) {
        return unrenderable(context.correlationId);
      }
      return { status: 200, body: { quote: view } };
    },
  },
];

module.exports = { quoteRoutes, REFUSAL_STATUS };
