// STORY-015: the safari product book over HTTP - authoring packages, and
// reading them back.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, on purpose. It maps a
// request onto a service call and a service result onto a status code. What
// makes a product well-formed, what counts as an itinerary conflict, when two
// submissions are the same package, and what gets audited all live in
// ../../services/products/, because those are decisions and this is plumbing.
// A rule implemented in a route is a rule that only applies to callers who
// arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it, once, before the handler runs - and audits
// every refusal. A second check in here would be a second policy that can
// disagree with the first, which is the whole reason STORY-006 centralised it.
// The story's "unauthorized product modification" failure path is therefore
// tested against these routes rather than handled in them, and the thing that
// makes it work is the pairing below: the two GETs declare products.read, the
// POST and the PATCH declare products.write, and only product_manager holds
// the second. An advisor can read every package and change none.
//
// WHY VALIDATION HERE IS ONLY THE ENVELOPE. Same rule as crmRoutes.js: this
// checks the SHAPE ("is this a JSON object?") and nothing else. It deliberately
// does NOT check that the itinerary has no gaps or that the price clears cost,
// even though it easily could. Those refusals are audited by the store, and
// rejecting them here would return the same 400 to the caller while quietly
// losing the audit entry - a refused package that leaves no trace. The
// boundary's job is to stop nonsense that never reached a decision; a package
// priced below cost DID reach one.
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
//     failure, the full problem list naming every bad day and every bad figure
//     at once, so a form is corrected in one pass.
//  4. Handled: non-object bodies, a missing or malformed productId in the path,
//     percent-encoding that cannot be decoded, unknown products, duplicates and
//     every validation refusal. NOT handled: pagination of the product list
//     (STORY-016 owns scale), product deletion (there is no delete route - see
//     the store header), and a customer-facing projection that strips
//     pricing.internal, which is not needed while products.read is staff-only.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  createSafariProduct,
  updateSafariProduct,
  getSafariProduct,
  listSafariProducts,
  MUTABLE_FIELDS,
} = require("../../services/products/safariProductStore");

// Service refusal reason -> HTTP status. Written as a table so that adding a
// refusal to the service and forgetting it here produces a 500 (loud) rather
// than a 400 (plausible, and wrong).
const REFUSAL_STATUS = Object.freeze({
  invalid_product: 400,
  unknown_fields: 400,
  empty_update: 400,
  unknown_product: 404,
  // 409, not 400: the submission was well-formed, it just collided with a
  // package that already exists under that name and country. A client can tell
  // those apart and should.
  duplicate_product: 409,
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
      // The problem list is the validator's, and it is written not to echo
      // untrusted input back - see safariProductValidation's describeValue.
      problems: result.problems || [],
    },
  };
}

// Envelope only - see the header.
function validateProductBody(body) {
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

const productRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/products\/safari$/,
    permission: PERMISSIONS.PRODUCTS_READ,
    handler: async function () {
      const products = listSafariProducts();
      // `editable` ships with the list so a client can build its form without
      // hardcoding a copy of the store's allow-list - a copy that would
      // silently fall out of step the day one is extended.
      return {
        status: 200,
        body: { count: products.length, products: products, editable: MUTABLE_FIELDS },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/products\/safari$/,
    permission: PERMISSIONS.PRODUCTS_WRITE,
    handler: async function (context) {
      const problems = validateProductBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = createSafariProduct({
        name: context.body.name,
        country: context.body.country,
        summary: context.body.summary,
        durationDays: context.body.durationDays,
        itinerary: context.body.itinerary,
        pricing: context.body.pricing,
        // Who authored it comes from the resolved principal, never from the
        // body. A request cannot nominate who it is acting as.
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      // 200 on a replay, 201 only when a row was actually created. A client
      // retrying a submission it is unsure about can tell from the status
      // whether it authored the package or found it already there.
      return {
        status: result.replayed ? 200 : 201,
        body: { replayed: result.replayed, product: result.product },
      };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/products\/safari\/([^/]+)$/,
    permission: PERMISSIONS.PRODUCTS_WRITE,
    handler: async function (context) {
      const productId = decodeParam(context.params[0]);
      if (productId === null) {
        return {
          status: 400,
          body: { error: "invalid_product_id", problems: ["Malformed productId."] },
        };
      }

      const problems = validateProductBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = updateSafariProduct({
        productId: productId,
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
          product: result.product,
          editable: MUTABLE_FIELDS,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/products\/safari\/([^/]+)$/,
    permission: PERMISSIONS.PRODUCTS_READ,
    handler: async function (context) {
      const productId = decodeParam(context.params[0]);
      if (productId === null) {
        return {
          status: 400,
          body: { error: "invalid_product_id", problems: ["Malformed productId."] },
        };
      }

      const product = getSafariProduct(productId);
      if (!product) {
        // 404 for "no such package". There is nothing to withhold here: the
        // caller already holds products.read, so telling them a product does
        // not exist tells them nothing they are not entitled to ask.
        return { status: 404, body: { error: "unknown_product" } };
      }

      return { status: 200, body: { product: product } };
    },
  },
];

module.exports = { productRoutes, validateProductBody, REFUSAL_STATUS };
