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
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if a handler fails? The request gets a 500 with a
//     correlation id and no internal detail; the full error is logged server
//     side with that same id. A stack trace is never sent to a caller.
//  2. Will it retry? No. Retrying is the caller's decision - every write path
//     behind this boundary is keyed and idempotent, which is what makes a
//     client-side retry safe.
//  3. Recovery path? Every route reads or writes a durable store, so a crash
//     loses nothing that was already acknowledged.
//  4. Handled here: no credential, bad credential, wrong role, another
//     customer's data, malformed JSON, oversized body, unknown route, wrong
//     method, and a handler throwing. NOT handled: TLS (terminated by nginx in
//     front), rate limiting, CORS, and sessions/refresh - those belong to
//     REQ-008 / STORY-005 and STORY-006, not to this story.

const http = require("http");
const crypto = require("crypto");

const { loadPrincipals, authenticate, hasRole } = require("./auth");
const { triageRequest } = require("../services/advisor/requestTriageService");
const { getQueuedReviews } = require("../services/advisor/advisorReviewQueue");
const { listAfricanDestinations } = require("../services/africa/africanSectionService");
const { getSafariDetails } = require("../services/africa/safariDetailsService");

const MAX_BODY_BYTES = 64 * 1024;
const SERVICE_NAME = "http-api";

function log(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: SERVICE_NAME,
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

function send(res, status, body, correlationId) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "X-Correlation-ID": correlationId,
  });
  res.end(payload);
}

// One shape for every error, so a client never has to guess. `error` is a
// stable code; `message` is safe to show a human. Internal detail never
// crosses this line.
function sendError(res, status, code, message, correlationId) {
  send(res, status, { error: code, message: message, correlationId: correlationId }, correlationId);
}

// Anything past MAX_BODY_BYTES is dropped rather than buffered, but the
// request is still DRAINED so the 413 can actually be delivered. Destroying
// the socket the moment the limit is crossed - the obvious implementation, and
// the one written first here - makes the client see a dropped connection
// instead of a clear error, which is indistinguishable from the server having
// crashed. Only a genuinely pathological upload gets the socket closed.
const ABORT_BODY_BYTES = MAX_BODY_BYTES * 16;

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let tooLarge = false;
    let chunks = [];

    req.on("data", function (chunk) {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks = []; // release what was buffered; it will never be parsed
      } else {
        chunks.push(chunk);
      }

      if (size > ABORT_BODY_BYTES) {
        reject(Object.assign(new Error("body far too large"), { code: "body_too_large" }));
        req.destroy();
      }
    });

    req.on("error", function (error) {
      reject(Object.assign(error, { code: "read_failed" }));
    });

    req.on("end", function () {
      if (tooLarge) {
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error("invalid json"), { code: "invalid_json" }));
      }
    });
  });
}

// Envelope validation only: is this the right SHAPE to hand to the service?
// Whether the request is clear enough to act on is the triage service's
// judgement, not the router's, and duplicating those rules here would give us
// two sets that drift.
function validateTriageBody(body) {
  const problems = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  if (typeof body.requestId !== "string" || body.requestId.length < 8 || body.requestId.length > 128) {
    problems.push("requestId must be a string of 8-128 characters");
  }
  if (typeof body.customerId !== "string" || body.customerId.trim() === "") {
    problems.push("customerId must be a non-empty string");
  }
  if (body.travelDates !== undefined && (body.travelDates === null || typeof body.travelDates !== "object")) {
    problems.push("travelDates must be an object when supplied");
  }
  if (body.partySize !== undefined && typeof body.partySize !== "number") {
    problems.push("partySize must be a number when supplied");
  }
  if (body.notes !== undefined && typeof body.notes !== "string") {
    problems.push("notes must be a string when supplied");
  }
  return problems;
}

const ROUTES = [
  {
    method: "POST",
    pattern: /^\/api\/requests\/triage$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      const problems = validateTriageBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      // A customer may only submit requests as themselves. An advisor acts on
      // behalf of customers, so they may name any. This is CLAUDE.md's
      // "the resource belongs to them" rule at the only place it can be
      // enforced.
      if (context.principal.role === "customer" && context.body.customerId !== context.principal.userId) {
        return {
          status: 403,
          body: {
            error: "forbidden",
            message: "A customer may only submit requests for themselves.",
          },
        };
      }

      const result = await triageRequest(context.body);
      return { status: 200, body: result };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/advisor\/reviews$/,
    roles: ["advisor"], // the queue is advisor-only; a customer gets 403
    handler: async function () {
      const reviews = getQueuedReviews();
      return { status: 200, body: { count: reviews.length, reviews: reviews } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/africa\/destinations$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      const result = await listAfricanDestinations({
        customerId: context.principal.userId,
        interactionKey: "HTTP-BROWSE-" + context.correlationId,
      });
      return { status: result.status === "ok" ? 200 : 503, body: result };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/africa\/destinations\/([A-Za-z0-9-]{1,64})$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      const result = await getSafariDetails({
        customerId: context.principal.userId,
        destinationId: context.params[0],
        interactionKey: "HTTP-DETAIL-" + context.correlationId,
      });
      // "We do not sell that" is a 404 to a client, not a server error. A
      // catalog we could not read is a 503 - it may work in a moment.
      const statusByOutcome = {
        ok: 200,
        unsupported: 404,
        incomplete: 409,
        timeout: 503,
        unavailable: 503,
        invalid_request: 400,
      };
      return { status: statusByOutcome[result.status] || 500, body: result };
    },
  },
];

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

function createServer({ principals = loadPrincipals() } = {}) {
  return http.createServer(async function (req, res) {
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
      sendError(res, 400, "invalid_url", "The request URL could not be parsed.", correlationId);
      return;
    }

    try {
      const principal = authenticate(req.headers.authorization, principals);
      if (!principal) {
        // No detail about WHY: missing, malformed and wrong all look identical
        // from outside.
        log("error", "request_unauthenticated", { correlationId, pathname, method: req.method });
        sendError(res, 401, "unauthorized", "A valid bearer token is required.", correlationId);
        return;
      }

      const { route, params, wrongMethod } = matchRoute(req.method, pathname);
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

      if (!hasRole(principal, route.roles)) {
        log("error", "request_forbidden", {
          correlationId,
          pathname,
          role: principal.role, // the role, never the token
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
      });

      log("info", "request_handled", {
        correlationId,
        pathname,
        method: req.method,
        role: principal.role,
        status: result.status,
        duration_ms: Date.now() - started,
      });

      send(res, result.status, result.body, correlationId);
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
    }
  });
}

module.exports = { createServer, MAX_BODY_BYTES };
