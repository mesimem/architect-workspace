// STORY-016: the seam between the HTTP pipeline and the two observability
// modules - metrics and the load governor.
//
// WHY THIS IS NOT JUST INLINE IN server.js. Two reasons, and the second is the
// real one. First, server.js was at 475 of its 500-line ceiling. Second, and
// more usefully: every decision in this file is one that is easy to get subtly
// wrong in a way no feature test would catch - which event marks a request
// finished, what a 4xx counts as, what happens to the slot when a handler
// throws. Those belong somewhere they can be unit-tested directly, not buried
// in a request handler that needs a socket to exercise.
//
// server.js keeps the four lines of the pipeline that read as pipeline; this
// file holds the reasoning behind them.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Admission failing closed means a 503, which
//     is the designed behaviour, not an outage. Observation failing means a
//     missing data point and nothing else - recording a measurement must never
//     be why a request fails, so nothing here can throw into the request path.
//  2. Will it retry? No. The shed response carries Retry-After; the client
//     decides. See the note in loadGovernor.js on why retrying inside the
//     governor is self-defeating.
//  3. Recovery path? Automatic as load drains. The snapshot interval is
//     unref'd, so it never holds a process open and never needs stopping in an
//     error path.
//  4. Handled: a handler that throws, a client that disconnects mid-response,
//     a double-counted request, a request shed before it was ever observed, a
//     route exempt from shedding. NOT handled: per-caller fairness, and
//     cross-process aggregation - each instance reports its own numbers, which
//     is what keeps them correct behind a load balancer.

"use strict";

const { createPerfMetrics, OUTCOMES } = require("../services/observability/perfMetrics");
const {
  createLoadGovernor,
  loadGovernorConfigFromEnv,
} = require("../services/observability/loadGovernor");

// HOW OFTEN THE AGGREGATE IS WRITTEN TO THE LOG STREAM. This interval is the
// third acceptance criterion of STORY-016 - when the system scales,
// performance metrics must be LOGGED. The per-request line in server.js
// records one duration; it cannot record a p95, because a percentile needs a
// sample. This is what puts the sample somewhere durable.
//
// A minute, because the log stream is the storage layer here (12-factor: logs
// are event streams) and one JSON object a minute is free, while one a second
// would bury the request lines an operator is grepping. Set
// COLABERRY_METRICS_INTERVAL_MS=0 to turn it off.
const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;

// NETWORK-LATENCY DEFENCE, and the whole of this story's third failure path.
// Node's own defaults are generous - requestTimeout 300s, headersTimeout 60s -
// which is reasonable for a file upload and badly wrong for a JSON API behind
// a load balancer. The problem is not politeness, it is that a slow client
// holds a connection and, past admission, a concurrency slot. A few hundred of
// them is a denial of service that costs the attacker nothing: open sockets,
// dribble one byte a second, never finish. Slowloris is thirty years old and
// still works against defaults.
//
// Each bound answers a different question:
const SERVER_TIMEOUTS = Object.freeze({
  // How long to wait for the whole request to arrive. Bodies here are capped
  // at 64KB (see wire.js), so anything that cannot manage that in 30 seconds
  // is not a client we are losing.
  requestTimeout: 30_000,
  // How long to wait for the HEADERS alone. Tighter, because there is no
  // legitimate reason for headers to trickle - this is the one that closes
  // slowloris specifically.
  headersTimeout: 10_000,
  // How long an idle keep-alive connection is held open. Short, so that
  // sockets return to the pool rather than accumulating. Must stay BELOW the
  // load balancer's own idle timeout, or the balancer will reuse a connection
  // we have just closed and report a 502 that is really a race.
  keepAliveTimeout: 5_000,
});

/**
 * The metrics label for a request. THE ROUTE PATTERN, NEVER THE PATH - see the
 * cardinality warning at the top of perfMetrics.js. `/api/crm/customers/C-1`
 * and `/api/crm/customers/C-2` must share one bucket, or thousands of
 * customers become thousands of metric buckets and the thing measuring our
 * scalability is what exhausts memory.
 */
function labelFor(route) {
  if (!route) {
    // Everything unroutable shares one bucket. A scanner walking a dictionary
    // of URLs is the exact traffic that would otherwise blow the label cap,
    // and "how many 404s" is the only question worth asking about it anyway.
    return "unmatched";
  }
  return route.method + " " + route.pattern.source;
}

/**
 * What a finished response counts as.
 *
 * THE JUDGEMENT CALL HERE IS 4xx, and it is worth stating out loud because the
 * number it produces will be read as "are we healthy". A 401, 403, 404 or 400
 * counts as a SUCCESS: the server received a request, applied its rules, and
 * answered correctly and quickly. That is the system working. Counting them as
 * failures would mean a burst of unauthenticated scanner traffic looks like an
 * outage, and someone would be paged for a system behaving perfectly.
 *
 * The cost of that choice, stated so nobody is surprised by it: a flood of
 * 401s reads as a healthy success_rate. That is a SECURITY question, not a
 * performance one, and it is answered elsewhere - server.js logs every
 * unauthenticated attempt, and every 403 gets a durable audit row.
 *
 * 5xx is the failure case: the server broke its own contract.
 */
function classifyOutcome(res) {
  // writableFinished is false when the socket closed before the response was
  // fully flushed - i.e. the client hung up on us. Checked FIRST because in
  // that case res.statusCode is whatever we last set, or the default 200, and
  // trusting it would file an abandoned request as a success.
  if (!res.writableFinished) {
    return OUTCOMES.ABORTED;
  }
  return res.statusCode >= 500 ? OUTCOMES.FAILURE : OUTCOMES.SUCCESS;
}

/**
 * Begin observing one request. Returns a handle the pipeline uses to mark a
 * shed, and otherwise records itself when the response closes.
 *
 * WHY "close" AND NOT "finish", which is the obvious choice and is wrong.
 * `finish` fires when a response is fully written - so it never fires for a
 * client that disconnected mid-flight. Those requests would simply be absent
 * from the metrics. Under overload, clients giving up IS the dominant
 * behaviour, which means `finish` would silently drop exactly the data points
 * that describe the incident, and the dashboard would look calm throughout.
 * `close` fires in both cases, always, exactly once.
 */
function observe({ metrics, res, route, startedAt, now = Date.now }) {
  // A route may exclude itself from the aggregate. Only the health probe does,
  // and it has to, for two reasons that a smoke test found the hard way:
  //
  //   1. ITS 503 IS A SIGNAL, NOT AN ERROR. classifyOutcome below files any
  //      5xx as a failure, which is right for every other route and exactly
  //      wrong here - a probe answering "degraded, drain me" is the system
  //      working as designed. A balancer polling every few seconds through a
  //      busy period would drive failure_rate up and manufacture an outage out
  //      of correct behaviour.
  //   2. PROBE TRAFFIC IS NOT USER TRAFFIC. It is constant, trivially cheap,
  //      and arrives whether anyone is using the system or not. Mixed into the
  //      aggregate it flatters every number: an idle instance polled once a
  //      second shows healthy volume and a beautiful p50.
  //
  // The probe is still fully visible - server.js logs a request line for it
  // like everything else. It is kept out of the AGGREGATE, which is the thing
  // an operator reads as "how is the application doing".
  if (route && route.excludeFromMetrics) {
    return { recordShed: function () { return false; } };
  }

  const label = labelFor(route);
  let recorded = false;

  function record(outcome) {
    // Idempotent. The shed path records and then sends a 503, which closes the
    // response and fires the listener below; without this guard one request
    // would be counted twice and every rate would be wrong in a way that is
    // very hard to notice.
    if (recorded) {
      return false;
    }
    recorded = true;
    metrics.record({ label: label, outcome: outcome, durationMs: now() - startedAt });
    return true;
  }

  res.on("close", function () {
    record(classifyOutcome(res));
  });

  return {
    recordShed: function () {
      return record(OUTCOMES.SHED);
    },
  };
}

/**
 * Ask the governor whether this request may run.
 *
 * Returns either `{ admitted: true, ticket }` - and the caller MUST release
 * that ticket in a finally - or `{ admitted: false, ... }` with everything the
 * caller needs to shape a 503.
 */
async function admit({ governor, route, observed }) {
  // A route may exempt itself. Today only the health probe does, and
  // assertShedExemptionsAreSafe below is what keeps that from quietly growing
  // into a back door around the bound.
  if (route && route.alwaysAdmit) {
    return { admitted: true, ticket: null, exempt: true };
  }

  const ticket = await governor.acquire();
  if (ticket.admitted) {
    return { admitted: true, ticket: ticket, waitedMs: ticket.waitedMs };
  }

  observed.recordShed();
  return {
    admitted: false,
    reason: ticket.reason,
    retryAfterSeconds: ticket.retryAfterSeconds,
    load: governor.state(),
  };
}

/**
 * A route marked `alwaysAdmit` bypasses the concurrency bound entirely, so the
 * exemption list is a hole in the only thing standing between a surge and a
 * dead process. This is checked at startup, like the permission table, and for
 * the same reason: a mistake here is invisible until the day it matters.
 *
 * The invariant: an exempt route must be a GET and must be public. Both halves
 * do work. A WRITE that bypasses the bound can reach the store and the audit
 * log - unbounded concurrent writes to a whole-file-rewrite store is the
 * database bottleneck this story is about, so an exempt write would walk
 * straight into it. And a non-public exemption means authentication runs
 * unbounded, which is the expensive part of a request.
 *
 * Throwing here is the point: an unsafe exemption must stop the process, not
 * wait to be discovered under load.
 */
function assertShedExemptionsAreSafe(routes) {
  for (const route of routes) {
    if (!route.alwaysAdmit) {
      continue;
    }
    const name = route.method + " " + String(route.pattern);
    if (route.method !== "GET") {
      throw new Error(
        name +
          " is exempt from load shedding but is not a GET. Only a cheap, " +
          "side-effect-free read may bypass the concurrency bound."
      );
    }
    if (!route.public) {
      throw new Error(
        name +
          " is exempt from load shedding but is not public. An exemption that " +
          "still authenticates runs the expensive half of the pipeline unbounded."
      );
    }
  }
}

function snapshotIntervalFromEnv() {
  const raw = process.env.COLABERRY_METRICS_INTERVAL_MS;
  if (raw === undefined || String(raw).trim() === "") {
    return DEFAULT_SNAPSHOT_INTERVAL_MS;
  }
  const value = Number(String(raw).trim());
  // A bad value falls back to the default rather than throwing. Unlike a
  // concurrency limit, a wrong interval here cannot hurt anything - and
  // refusing to boot because the METRICS cadence is misspelt would take the
  // system down to protect its own dashboard.
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_SNAPSHOT_INTERVAL_MS;
}

/**
 * Write the aggregate to the log stream on an interval. Returns a stop
 * function. This is the criterion "performance metrics must be logged".
 */
function startSnapshotLogging({ metrics, governor, log, intervalMs = snapshotIntervalFromEnv() }) {
  if (intervalMs === 0) {
    return function () {};
  }

  const timer = setInterval(function () {
    const load = governor.state();
    log("info", "perf_snapshot", {
      // Flattened onto one line so an operator can grep perf_snapshot and read
      // a time series without a JSON query tool.
      load: load,
      performance: metrics.snapshot(),
    });
  }, intervalMs);

  // UNREF IS LOAD-BEARING, not hygiene. Without it this interval keeps the
  // event loop alive forever, so every one of the repo's test files that
  // constructs a server would hang the runner instead of exiting, and a
  // production container would ignore SIGTERM. An unref'd timer still fires;
  // it just stops being a reason to stay running.
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }

  return function () {
    clearInterval(timer);
  };
}

function applyTimeouts(server, timeouts = SERVER_TIMEOUTS) {
  server.requestTimeout = timeouts.requestTimeout;
  server.headersTimeout = timeouts.headersTimeout;
  server.keepAliveTimeout = timeouts.keepAliveTimeout;
  return server;
}

/**
 * The observability context handed to every route via `context.ops`. One
 * governor and one metrics recorder per server, created here so that a test
 * can inject tiny limits and drive saturation deliberately.
 */
function createOps({ governor, metrics } = {}) {
  return {
    governor: governor || createLoadGovernor(loadGovernorConfigFromEnv()),
    metrics: metrics || createPerfMetrics(),
  };
}

module.exports = {
  createOps,
  admit,
  observe,
  labelFor,
  classifyOutcome,
  applyTimeouts,
  startSnapshotLogging,
  assertShedExemptionsAreSafe,
  snapshotIntervalFromEnv,
  SERVER_TIMEOUTS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
};
