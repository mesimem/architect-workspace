// STORY-017: the package book over HTTP - combining products into an offering,
// and reading the offerings back.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, on purpose. It maps a
// request onto a service call and a service result onto a status code. What
// makes two products incompatible, what a package costs, when two submissions
// are the same offering, and what gets audited all live in
// ../../services/packages/, because those are decisions and this is plumbing.
// A rule implemented in a route is a rule that only applies to callers who
// arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it, once, before the handler runs - and audits
// every refusal. A second check in here would be a second policy that can
// disagree with the first, which is the whole reason STORY-006 centralised it.
// The story's "unauthorized access to package creation" failure path is
// therefore tested against these routes rather than handled in them, and the
// thing that makes it work is the pairing below: the two GETs declare
// packages.read, the POST and the PATCH declare packages.write.
//
// WHY VALIDATION HERE IS ONLY THE ENVELOPE. Same rule as productRoutes.js: this
// checks the SHAPE ("is this a JSON object?") and nothing else. It deliberately
// does NOT check that the components fit together or that the discount clears
// cost, even though it easily could. Those refusals are AUDITED by the store,
// and rejecting them here would return the same 400 to the caller while quietly
// losing the audit entry - a refused package that leaves no trace. The
// boundary's job is to stop nonsense that never reached a decision; two safaris
// that overlap DID reach one.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to an explicit
//     status via REFUSAL_STATUS below; an unmapped reason becomes 500 rather
//     than a misleading 400, because an unrecognised refusal is our bug and
//     should read like one. A malformed path parameter is a 400.
//  2. Will it retry? Nothing here retries, and nothing here should: these are
//     local calls. The operations are safe for the CALLER to retry - POST
//     dedups on the package name and says which happened via the status code,
//     PATCH applied twice reports the second as unchanged, and both GETs are
//     reads.
//  3. Recovery path? The caller gets an error code and, for a validation or
//     pricing failure, the full problem list naming every incompatible pair and
//     every bad figure at once, so a form is corrected in one pass. A 503 means
//     the store is unchanged and the request can simply be repeated.
//  4. Handled: non-object bodies, a missing or malformed packageId in the path,
//     percent-encoding that cannot be decoded, unknown packages, duplicate
//     names, every compatibility and pricing refusal, and the two
//     infrastructure refusals. NOT handled: pagination of the package list
//     (the book is small and STORY-016 owns scale), package deletion (there is
//     no delete route - see the store header), and a customer-facing
//     projection that strips pricing.internal, which is not needed while
//     packages.read is staff-only.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  createPackage,
  updatePackage,
  getPackage,
  listPackages,
  MUTABLE_FIELDS,
  REASONS,
} = require("../../services/packages/packageStore");

// Service refusal reason -> HTTP status. Written as a table so that adding a
// refusal to the service and forgetting it here produces a 500 (loud) rather
// than a 400 (plausible, and wrong). Keyed off the service's own REASONS
// constants rather than string literals, so a renamed reason is a startup
// error instead of a silently unmapped 500.
const REFUSAL_STATUS = Object.freeze({
  [REASONS.INVALID_PACKAGE]: 400,
  [REASONS.INVALID_PRICING]: 400,
  [REASONS.UNKNOWN_FIELDS]: 400,
  [REASONS.EMPTY_UPDATE]: 400,
  [REASONS.UNKNOWN_PACKAGE]: 404,
  // 409, not 400: the submission was well-formed, it just collided with an
  // offering that already exists under that name. A client can tell those
  // apart and should.
  [REASONS.DUPLICATE_PACKAGE]: 409,
  // 503, not 500. The store is UNCHANGED and the request can simply be
  // repeated - which is a different instruction to a client than "something
  // broke and we do not know what state you are in". These are the two
  // refusals the audited commit returns when it could not save or could not
  // prove the save was recorded.
  [REASONS.NOT_SAVED]: 503,
  [REASONS.AUDIT_UNAVAILABLE]: 503,
  // Our bug, not the caller's: server.js always supplies a correlationId, so
  // reaching this means the plumbing broke.
  [REASONS.MISSING_CORRELATION_ID]: 500,
});

function refusalResponse(result) {
  const status = REFUSAL_STATUS[result.reason] || 500;
  return {
    status: status,
    body: {
      error: result.reason,
      // The problem list is the service's, and every module that builds one is
      // written not to echo untrusted input back - see describeValue in
      // packageCompatibility.js and packagePricing.js.
      problems: result.problems || [],
    },
  };
}

// Envelope only - see the header.
function validatePackageBody(body) {
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

const packageRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/packages$/,
    permission: PERMISSIONS.PACKAGES_READ,
    handler: async function () {
      const packages = listPackages();
      // `editable` ships with the list so a client can build its form without
      // hardcoding a copy of the store's allow-list - a copy that would
      // silently fall out of step the day one is extended. Note what is NOT in
      // it: `pricing`, which is derived.
      return {
        status: 200,
        body: { count: packages.length, packages: packages, editable: MUTABLE_FIELDS },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/packages$/,
    permission: PERMISSIONS.PACKAGES_WRITE,
    handler: async function (context) {
      const problems = validatePackageBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = createPackage({
        name: context.body.name,
        summary: context.body.summary,
        components: context.body.components,
        discountBasisPoints: context.body.discountBasisPoints,
        // Who built it comes from the resolved principal, never from the body.
        // A request cannot nominate who it is acting as.
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      // 200 on a replay, 201 only when a row was actually created. A client
      // retrying a submission it is unsure about can tell from the status
      // whether it built the package or found it already there.
      return {
        status: result.replayed ? 200 : 201,
        body: { replayed: result.replayed, package: result.travelPackage },
      };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/packages\/([^/]+)$/,
    permission: PERMISSIONS.PACKAGES_WRITE,
    handler: async function (context) {
      const packageId = decodeParam(context.params[0]);
      if (packageId === null) {
        return {
          status: 400,
          body: { error: "invalid_package_id", problems: ["Malformed packageId."] },
        };
      }

      const problems = validatePackageBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = updatePackage({
        packageId: packageId,
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
          package: result.travelPackage,
          editable: MUTABLE_FIELDS,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/packages\/([^/]+)$/,
    permission: PERMISSIONS.PACKAGES_READ,
    handler: async function (context) {
      const packageId = decodeParam(context.params[0]);
      if (packageId === null) {
        return {
          status: 400,
          body: { error: "invalid_package_id", problems: ["Malformed packageId."] },
        };
      }

      const travelPackage = getPackage(packageId);
      if (!travelPackage) {
        // 404 for "no such offering". There is nothing to withhold here: the
        // caller already holds packages.read, so telling them a package does
        // not exist tells them nothing they are not entitled to ask.
        return { status: 404, body: { error: "unknown_package" } };
      }

      return { status: 200, body: { package: travelPackage } };
    },
  },
];

module.exports = { packageRoutes, validatePackageBody, REFUSAL_STATUS };
