// STORY-010: the supplier book over HTTP - recording who we buy from, and
// reading it back.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, on purpose. It maps a
// request onto a service call and a service result onto a status code. What
// makes a supplier well-formed, what counts as a data mismatch, when two
// submissions are the same business, and what gets audited all live in
// ../../services/suppliers/, because those are decisions and this is plumbing.
// A rule implemented in a route is a rule that only applies to callers who
// arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it, once, before the handler runs - and audits
// every refusal. A second check in here would be a second policy that can
// disagree with the first, which is the whole reason STORY-006 centralised it.
// The pairing below is what makes it work: the two GETs declare suppliers.read,
// the POST and the PATCH declare suppliers.write, and the advisor is the only
// role holding either (see authz/permissions.js). That is tested against these
// routes in http/suppliers.test.js rather than handled in them.
//
// WHY suppliers.read IS NOT A MILD GRANT. A supplier record carries the rate
// card - what the agency PAYS. It is the cost base every margin is computed
// from, across every package that supplier appears in, which makes it a wider
// exposure than any single product's pricing.internal. There is deliberately no
// customer-facing projection of a supplier and no route a customer can reach:
// the right way to give a customer a price is a quote, which is already built
// to strip costs (see quotes/quoteView.js).
//
// WHY VALIDATION HERE IS ONLY THE ENVELOPE. Same rule as productRoutes.js and
// crmRoutes.js: this checks the SHAPE ("is this a JSON object?") and nothing
// else. It deliberately does NOT check that a rate has a contract behind it or
// that a contract's dates run the right way, even though it easily could. Those
// refusals are audited by the store, and rejecting them here would return the
// same 400 to the caller while quietly losing the audit entry - a refused
// supplier that leaves no trace. That directly defeats the story's trust
// criterion, so it is worth being explicit about: the boundary's job is to stop
// nonsense that never reached a decision, and an orphan rate DID reach one.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to an explicit
//     status via REFUSAL_STATUS below; an unmapped reason becomes 500 rather
//     than a misleading 400, because an unrecognised refusal is our bug and
//     should read like one. A malformed path parameter is a 400.
//  2. Will it retry? Nothing here retries. The operations are safe for the
//     CALLER to retry: POST dedups on (name + country) and says which happened
//     via the status code, PATCH dedups on the correlationId, and both GETs
//     are reads.
//  3. Recovery path? The caller gets an error code and, for a validation
//     failure, the full problem list naming every bad contract and every orphan
//     rate at once, so a form is corrected in one pass.
//  4. Handled: non-object bodies, a missing or malformed supplierId in the
//     path, percent-encoding that cannot be decoded, unknown suppliers,
//     duplicates and every validation refusal. NOT handled: pagination of the
//     supplier list (the book is small and scanning is honest; an index is a
//     second copy that can desync), supplier deletion (there is no delete route
//     - see the store header on why erasing a supplier erases the contracts we
//     are still liable under), and filtering by country or type, which no
//     acceptance criterion asks for.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  createSupplier,
  updateSupplier,
  getSupplier,
  listSuppliers,
  MUTABLE_FIELDS,
} = require("../../services/suppliers/supplierStore");

// Service refusal reason -> HTTP status. Written as a table so that adding a
// refusal to the service and forgetting it here produces a 500 (loud) rather
// than a 400 (plausible, and wrong).
const REFUSAL_STATUS = Object.freeze({
  invalid_supplier: 400,
  unknown_fields: 400,
  empty_update: 400,
  unknown_supplier: 404,
  // 409, not 400: the submission was well-formed, it just collided with a
  // supplier that already exists under that name and country. A client can tell
  // those apart and should.
  duplicate_supplier: 409,
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
      // The problem list is the validators', and they are written not to echo
      // untrusted input back - see supplierValidation's describeValue.
      problems: result.problems || [],
    },
  };
}

// Envelope only - see the header.
function validateSupplierBody(body) {
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

const supplierRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/suppliers$/,
    permission: PERMISSIONS.SUPPLIERS_READ,
    handler: async function () {
      const suppliers = listSuppliers();
      // `editable` ships with the list so a client can build its form without
      // hardcoding a copy of the store's allow-list - a copy that would
      // silently fall out of step the day one is extended.
      return {
        status: 200,
        body: { count: suppliers.length, suppliers: suppliers, editable: MUTABLE_FIELDS },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/suppliers$/,
    permission: PERMISSIONS.SUPPLIERS_WRITE,
    handler: async function (context) {
      const problems = validateSupplierBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = createSupplier({
        name: context.body.name,
        country: context.body.country,
        supplierType: context.body.supplierType,
        contactEmail: context.body.contactEmail,
        contactPhone: context.body.contactPhone,
        notes: context.body.notes,
        contracts: context.body.contracts,
        rates: context.body.rates,
        // Who recorded it comes from the resolved principal, never from the
        // body. A request cannot nominate who it is acting as.
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      // 200 on a replay, 201 only when a row was actually created. A client
      // retrying a submission it is unsure about can tell from the status
      // whether it recorded the supplier or found it already there.
      return {
        status: result.replayed ? 200 : 201,
        body: { replayed: result.replayed, supplier: result.supplier },
      };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/suppliers\/([^/]+)$/,
    permission: PERMISSIONS.SUPPLIERS_WRITE,
    handler: async function (context) {
      const supplierId = decodeParam(context.params[0]);
      if (supplierId === null) {
        return {
          status: 400,
          body: { error: "invalid_supplier_id", problems: ["Malformed supplierId."] },
        };
      }

      const problems = validateSupplierBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = updateSupplier({
        supplierId: supplierId,
        // The whole body is the patch. The store holds the allow-list of what
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
          supplier: result.supplier,
          editable: MUTABLE_FIELDS,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/suppliers\/([^/]+)$/,
    permission: PERMISSIONS.SUPPLIERS_READ,
    handler: async function (context) {
      const supplierId = decodeParam(context.params[0]);
      if (supplierId === null) {
        return {
          status: 400,
          body: { error: "invalid_supplier_id", problems: ["Malformed supplierId."] },
        };
      }

      const supplier = getSupplier(supplierId);
      if (!supplier) {
        // 404 for "no such supplier". There is nothing to withhold here: the
        // caller already holds suppliers.read, so telling them a supplier does
        // not exist tells them nothing they are not entitled to ask.
        return { status: 404, body: { error: "unknown_supplier" } };
      }

      return { status: 200, body: { supplier: supplier } };
    },
  },
];

module.exports = { supplierRoutes, validateSupplierBody, REFUSAL_STATUS };
