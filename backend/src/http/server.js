// STORY-003 (boundary work): the first HTTP entry point in this build.
//
// Until now every service was called directly from a test or a script, so
// nothing in the system had ever validated an untrusted request, authenticated
// a caller, or checked a permission. This puts all three in front of the
// services that already exist. It does not change any of them.
//
// node:http and nothing else. CLAUDE.md classifies introducing a dependency as
// a decision to escalate, and Express would buy routing sugar for four routes.
//
// WHAT THIS FILE OWNS, AS OF STORY-005. It grew past CLAUDE.md's 500-line hard
// ceiling when the portal routes landed, and the rule is that the next change
// to an oversize file splits it before adding code. The endpoints moved to
// routes/ and this file kept the MECHANICS:
//
//   here            reading and bounding a body, correlation ids, resolving a
//                   credential, checking a role, one error envelope, the
//                   structured request log, the catch-all
//   routes/*        what each endpoint actually does
//
// The test for whether something belongs here: does it touch the socket, or
// apply to EVERY request? If not, it is a route module's business. A handler
// returns { status, body, headers? } and never sees `res`, which is what keeps
// this pipeline the only place a response can be shaped.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if a handler fails? The request gets a 500 with a
//     correlation id and no internal detail; the full error is logged server
//     side with that same id. A stack trace is never sent to a caller.
//  2. Will it retry? No. Retrying is the caller's decision - every write path
//     behind this boundary is keyed and idempotent, which is what makes a
//     client-side retry safe.
//  3. Recovery path? Every route reads or writes a durable store, so a crash
//     loses nothing that was already acknowledged.
//  4. Handled here: no credential, bad credential, EXPIRED SESSION, MISSING
//     PERMISSION, another customer's data, malformed JSON, oversized body,
//     unknown route, wrong method, and a handler throwing. NOT handled: TLS
//     (terminated by nginx in front), per-IP rate limiting, CORS, and refresh
//     tokens. Sessions were deferred by this note when STORY-003 wrote it;
//     STORY-005 has since added them, and STORY-006 has since added
//     permissions.
//
// STORY-006 CHANGED THE ROUTE CONTRACT. A route used to declare `roles: [...]`
// and this file checked membership. It now declares a single `permission`, and
// the answer comes from services/authz/permissions.js. The difference that
// matters: the policy lived in six route files and now lives in one table, so
// adding a role is one edit rather than six, and the six cannot disagree.
// Routes are validated against that table at load - see
// assertRoutesDeclarePermissions - so a route that forgets its permission, or
// names one that does not exist, stops the process instead of silently
// serving everybody or nobody.

const http = require("http");
const crypto = require("crypto");

const { loadPrincipals, authenticate, bearerTokenFrom } = require("./auth");
const {
  loadPortalCredentials,
  PortalCredentialError,
} = require("../services/portal/portalCredentials");
const { can, assertKnownPermission } = require("../services/authz/permissions");
const { recordAudit, deriveAuditKey } = require("../services/audit/auditLog");
// The route table. Each area lives in its own module under routes/; this file
// no longer knows what any endpoint does, only how to run one.
const { ROUTES } = require("./routes");

// STORY-016 moved the socket-level mechanics to wire.js, under CLAUDE.md's
// rule that an oversize file is split before new code lands. A pure move: the
// four functions below are unchanged, and this file's job is now only the
// pipeline that calls them. See wire.js's header for the line the split
// follows.
const { log, send, sendError, readJsonBody, MAX_BODY_BYTES } = require("./wire");
// STORY-016: admission control and performance measurement. The reasoning for
// every decision in here - which event ends a request, what a 4xx counts as,
// why the health probe is exempt - is in opsPipeline.js, not repeated below.
const {
  createOps,
  admit,
  observe,
  applyTimeouts,
  startSnapshotLogging,
  assertShedExemptionsAreSafe,
} = require("./opsPipeline");

// STORY-006: every route is checked ONCE, at startup, before a socket is ever
// opened. Three things have to hold, and each one has a specific hole behind it:
//
//   a route declares either `public: true` or a `permission`, never neither
//       - neither means the permission check below has nothing to test, and the
//         obvious implementation of "no permission required" is "let it
//         through". A route that forgets its permission must fail loudly at
//         boot, not quietly serve everybody.
//   the permission it names is one the table knows
//       - a typo or a renamed permission makes can() return false forever, so
//         the route 403s for every caller including the right one. That is
//         discovered by a customer, not by us.
//   a public route names no permission
//       - the two are contradictory, and shipping both means the reader cannot
//         tell which one is the truth.
//
// Throwing here is the point. This is config, and CLAUDE.md's rule for config
// that cannot be used is to refuse to start rather than degrade.
function assertRoutesDeclarePermissions(routes) {
  for (const route of routes) {
    const name = route.method + " " + String(route.pattern);

    if (route.public) {
      if (route.permission) {
        throw new Error(
          name + " is marked public and also names a permission. It can only be one of the two."
        );
      }
      continue;
    }

    if (!route.permission) {
      throw new Error(
        name + " declares no permission and is not public. Every route must say what it requires."
      );
    }

    assertKnownPermission(route.permission, name);
  }
}

// Run at module load, not inside createServer: an unreachable route is a
// defect in the source, so it should stop `require`, not wait for a test to
// happen to construct a server.
assertRoutesDeclarePermissions(ROUTES);
// STORY-016: same rule, same reason - a route that exempts itself from the
// concurrency bound is a hole in it, so the exemption is validated at load
// rather than discovered under load.
assertShedExemptionsAreSafe(ROUTES);

function matchRoute(method, pathname) {
  let pathMatchedWrongMethod = false;

  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    if (route.method !== method) {
      pathMatchedWrongMethod = true;
      continue;
    }
    return { route: route, params: match.slice(1) };
  }

  return { route: null, params: [], wrongMethod: pathMatchedWrongMethod };
}

// STORY-005: the portal credential table is loaded once, here, rather than per
// request - hashing is the expensive part of a login and re-reading the
// environment on every attempt would add nothing but latency.
//
// WHY A MISSING TABLE DOES NOT STOP THE SERVER, when a missing API-token table
// does. They are not the same kind of absence. COLABERRY_API_TOKENS protects
// EVERY route, so without it the correct behaviour is to refuse to start -
// anything else would serve an unauthenticated API. COLABERRY_PORTAL_CREDENTIALS
// backs ONE feature, customer sign-in. An advisor deployment that has no
// portal customers yet should not be unable to boot, and a typo in it must not
// take the advisor API down with it.
//
// The distinction that keeps this honest: absent means every login is REFUSED
// (503, see the login route), never allowed. This is fail-closed with a
// reduced feature set, not an auth layer degrading to "allow everyone".
function loadPortalCredentialsOrWarn() {
  try {
    return loadPortalCredentials();
  } catch (error) {
    if (!(error instanceof PortalCredentialError)) {
      throw error; // not our problem to swallow
    }
    log("error", "portal_login_unconfigured", {
      // The message names the variable and the fix, and contains no hash.
      reason: error.message,
      effect: "POST /api/portal/login will refuse every attempt with 503.",
    });
    return null;
  }
}

function createServer({
  principals = loadPrincipals(),
  credentials = loadPortalCredentialsOrWarn(),
  // STORY-016: one governor and one metrics recorder per server. Injectable so
  // a test can set a concurrency limit of 2 and drive real saturation, rather
  // than trying to generate enough load to hit the production default of 64.
  ops = createOps(),
} = {}) {
  // STORY-006: the DIRECTORY - every user the environment declares, as
  // { userId, role } and NOTHING ELSE. The admin routes need it to count how
  // many admins exist (see the last-admin guard in roleAssignments.js), and a
  // `principals` entry also carries the raw bearer token. Projecting the two
  // safe fields here, once, means no handler is ever handed a token it could
  // log, echo, or pass on by accident. Built at startup, not per request: the
  // token table does not change while the process runs.
  const directory = principals.map(function (principal) {
    return { userId: principal.userId, role: principal.role };
  });

  const server = http.createServer(async function (req, res) {
    // Honour an inbound correlation id so a trace can span services, but only
    // if it looks like one - an unvalidated header ends up in log lines.
    const inbound = req.headers["x-correlation-id"];
    const correlationId =
      typeof inbound === "string" && /^[A-Za-z0-9-]{8,64}$/.test(inbound)
        ? inbound
        : crypto.randomUUID();

    const started = Date.now();
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch (error) {
      ops.metrics.record({ label: "invalid_url", outcome: "failure", durationMs: 0 });
      sendError(res, 400, "invalid_url", "The request URL could not be parsed.", correlationId);
      return;
    }

    // Released in the finally below. Null when shed, and null for an exempt
    // route - releasing a ticket never taken is what the null guard prevents.
    let ticket = null;

    try {
      // STORY-005 reordered this: the route is matched BEFORE authenticating,
      // because one route (login) must be reachable without a credential.
      //
      // The property that reordering could easily have lost, and does not: an
      // unauthenticated request to a path that does not exist still gets 401,
      // not 404. `!route` falls into the branch below and is rejected there,
      // so an anonymous caller cannot map which endpoints exist by reading
      // status codes.
      const { route, params, wrongMethod } = matchRoute(req.method, pathname);

      // STORY-016. Observation starts here because the metrics LABEL is the
      // route pattern, which is only known once the route is matched. From
      // this point every exit - 401, 403, 404, 413, 200, 500, or the client
      // vanishing - is recorded exactly once, by the response's own close
      // event rather than by each branch remembering to.
      const observed = observe({
        metrics: ops.metrics,
        res: res,
        route: route,
        startedAt: started,
      });

      // ADMISSION, AND WHY IT SITS EXACTLY HERE: after matching, before
      // authenticating. After matching, because the health probe has to be
      // reachable while everything else is being refused, and a route cannot
      // exempt itself before it is known. Before authenticating, because
      // authentication is the first thing in this pipeline that costs real
      // work, and the point of shedding is to refuse before spending it.
      //
      // A shed request never has its body read either - see where readJsonBody
      // is called, far below. That is what makes saying no cheap enough to
      // survive a surge much larger than our capacity.
      const admission = await admit({ governor: ops.governor, route: route, observed: observed });
      if (!admission.admitted) {
        log("error", "request_shed", {
          correlationId,
          pathname,
          method: req.method,
          reason: admission.reason,
          load: admission.load,
        });
        sendError(
          res,
          503,
          "overloaded",
          "The service is busy right now. Please retry in a moment.",
          correlationId,
          // Tells the client when to come back, so a retry storm spreads out
          // instead of arriving together and re-creating the overload.
          { "Retry-After": String(admission.retryAfterSeconds) }
        );
        return;
      }
      ticket = admission.ticket;

      let principal = null;
      if (!route || !route.public) {
        const auth = authenticate(req.headers.authorization, principals);
        if (!auth.ok) {
          // One reason is distinguished - an expired session, so the customer
          // is told to sign in again rather than left guessing. Every other
          // rejection reports the same thing: missing, malformed, unknown and
          // revoked all look identical from outside.
          log("error", "request_unauthenticated", {
            correlationId,
            pathname,
            method: req.method,
            reason: auth.reason,
          });
          sendError(
            res,
            401,
            auth.reason,
            auth.reason === "session_expired"
              ? "Your session has expired. Please sign in again."
              : "A valid bearer token is required.",
            correlationId
          );
          return;
        }
        principal = auth.principal;
      }

      if (!route) {
        const status = wrongMethod ? 405 : 404;
        sendError(
          res,
          status,
          wrongMethod ? "method_not_allowed" : "not_found",
          wrongMethod ? "That method is not allowed on this path." : "No such endpoint.",
          correlationId
        );
        return;
      }

      // STORY-006: ONE access decision, and it goes through can(). The route
      // names an act; the permission table says whether this role may perform
      // it. Neither this file nor the route module knows which roles are
      // involved, which is what stopped the policy being six copies.
      if (!route.public && !can(principal.role, route.permission)) {
        // A FORBIDDEN REQUEST IS WRITTEN TO THE DURABLE AUDIT TRAIL, not just
        // the log stream. This is a known caller, holding a credential we
        // issued, reaching for something they may not have - the single most
        // interesting event a security review looks for, and the half of AC-3
        // that the role-assignment audit does not cover.
        //
        // WHY 401s DO NOT GET AN AUDIT ROW AND 403s DO. A 401 is anonymous:
        // there is no actor to attribute it to, so the row would say little,
        // and anyone on the internet could write one. Since the audit store
        // rewrites its whole file per row (see jsonFileStore.js), that is an
        // unauthenticated disk-fill with quadratic write amplification. A 403
        // requires a valid credential, so the volume is bounded by the people
        // we gave one to. Unauthenticated attempts are still fully recorded in
        // the structured log stream above - logged, but not in the evidence
        // store an auditor reads.
        //
        // If recordAudit throws, the catch-all turns this into a 500 and the
        // request is still denied. Failing closed is correct: per auditLog.js,
        // an unauditable event is a refusal to serve, and the one outcome that
        // must be impossible is granting access we cannot account for.
        recordAudit({
          auditKey: deriveAuditKey("access:" + correlationId, "forbidden"),
          event: "authz.access.denied",
          outcome: "failure",
          actor: principal.userId,
          resource: pathname,
          correlationId: correlationId,
          context: {
            method: req.method,
            requiredPermission: route.permission,
            role: principal.role,
            // Surfaces the case where a role assignment, not the token, is
            // what denied this. Without it the denial looks like a broken
            // token and the operator chases the wrong thing.
            declaredRole: principal.declaredRole,
            credential: principal.credential,
          },
        });

        log("error", "request_forbidden", {
          correlationId,
          pathname,
          role: principal.role, // the role, never the token
          requiredPermission: route.permission,
        });
        sendError(
          res,
          403,
          "forbidden",
          "Your role does not have access to this endpoint.",
          correlationId
        );
        return;
      }

      let body = {};
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        try {
          body = await readJsonBody(req);
        } catch (error) {
          const status = error.code === "body_too_large" ? 413 : 400;
          sendError(
            res,
            status,
            error.code || "invalid_body",
            status === 413 ? "Request body is too large." : "Request body must be valid JSON.",
            correlationId
          );
          return;
        }
      }

      const result = await route.handler({
        body: body,
        params: params,
        principal: principal,
        correlationId: correlationId,
        // The presented token, for the one route that has to revoke it. Never
        // logged, never echoed - see the log line below, which records the
        // session ID instead.
        bearerToken: bearerTokenFrom(req.headers.authorization),
        credentials: credentials,
        directory: directory,
        // STORY-016: the health probe and the metrics endpoint read these.
        // Handed in like every other dependency rather than imported by the
        // route, so the numbers a test reads are the ones its own server
        // produced - not a module-level singleton shared across every server
        // the suite ever constructed.
        ops: ops,
      });

      // Every access attempt that gets this far is recorded here with the role
      // it was granted under and the permission that let it through - so the
      // log stream answers "who did what, and on what authority" for the
      // allowed requests, while the audit store holds the denied ones.
      log("info", "request_handled", {
        correlationId,
        pathname,
        method: req.method,
        role: principal ? principal.role : "anonymous",
        grantedPermission: route.public ? null : route.permission,
        credential: principal ? principal.credential : "none",
        sessionId: principal ? principal.sessionId : null,
        status: result.status,
        duration_ms: Date.now() - started,
      });

      send(res, result.status, result.body, correlationId, result.headers);
    } catch (error) {
      // The catch-all. A handler that throws must not take the process down or
      // leak a stack trace; the caller gets a code they can quote back.
      log("error", "request_failed", {
        correlationId,
        pathname,
        method: req.method,
        error_class: error && error.name && error.name !== "Error" ? error.name : "UnhandledError",
        message: error && error.message,
        duration_ms: Date.now() - started,
      });
      sendError(
        res,
        500,
        "internal_error",
        "Something went wrong on our side. Quote the correlation id if you contact us.",
        correlationId
      );
    } finally {
      // STORY-016: THE SLOT IS RELEASED ON EVERY PATH, including the ones that
      // return early and the one where the handler threw. A finally rather
      // than a call at the end of the happy path, because a leaked slot is
      // permanent: capacity drops by one for the life of the process, with
      // nothing in the logs to say so, and enough of them starve the server
      // down to refusing everything. release() is idempotent, so a second
      // release from anywhere is a no-op rather than a counter drifting below
      // the real in-flight count.
      //
      // Note what this does NOT wait for: the response finishing its journey
      // to the client. The slot bounds WORK, and the work is done here; a slow
      // client is held off by the socket timeouts in opsPipeline.js instead.
      if (ticket) {
        ticket.release();
      }
    }
  });

  // STORY-016, the three pieces that live on the server rather than a request:
  //   timeouts    a slow client must not hold a connection, or a slot, forever
  //   snapshots   the aggregate reaches the log stream on an interval, the only
  //               place a p95 can actually be observed
  //   ops         exposed so an operator script - and this story's load test -
  //               can read the same numbers the metrics endpoint serves
  applyTimeouts(server);
  const stopSnapshots = startSnapshotLogging({
    metrics: ops.metrics,
    governor: ops.governor,
    log: log,
  });
  server.on("close", stopSnapshots);
  server.ops = ops;

  return server;
}

module.exports = {
  createServer,
  MAX_BODY_BYTES,
  // Exported for its own test. Underscored because it is not part of the
  // operational surface: it runs once at load, above, and no caller should be
  // invoking it. Untested, it could be deleted and every other test would
  // still pass, since they only ever run against a route table that is valid.
  __assertRoutesDeclarePermissions: assertRoutesDeclarePermissions,
};
