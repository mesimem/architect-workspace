// STORY-016: the seam between the pipeline and the observability modules.
//
// Every assertion here is about a decision that would produce a PLAUSIBLE
// WRONG NUMBER rather than a visible break - a request counted twice, a
// cardinality explosion, an abandoned request filed as a success, a probe's
// "drain me" filed as an outage. None of those fail a feature test. All of
// them end with someone making a capacity decision on a figure that is not
// true, which is worse than having no figure.
//
// scalability.test.js drives the whole server under load and proves the
// story's acceptance criteria. This file proves the parts in isolation, where
// a wrong answer is unambiguous.

"use strict";

const assert = require("assert");
const test = require("node:test");
const { EventEmitter } = require("events");

const {
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
} = require("./opsPipeline");
const { createPerfMetrics, OUTCOMES } = require("../services/observability/perfMetrics");
const { createLoadGovernor } = require("../services/observability/loadGovernor");
const { ROUTES } = require("./routes");

// A response stand-in. `close` is the event the pipeline listens for, so a
// test can end a request exactly when it wants to.
function fakeResponse({ statusCode = 200, writableFinished = true } = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.writableFinished = writableFinished;
  res.finish = function () {
    res.emit("close");
  };
  return res;
}

// --- labelling: the cardinality defence -----------------------------------

test("a request is labelled by route pattern, never by path", function () {
  // THE WHOLE SCALABILITY POINT OF THE LABEL. Two customers hitting the same
  // endpoint must share one metric bucket. Label by path and "thousands of
  // customers" becomes thousands of buckets.
  const route = { method: "GET", pattern: /^\/api\/crm\/customers\/([^/]+)$/ };
  const label = labelFor(route);

  assert.ok(label.startsWith("GET "));
  assert.ok(!label.includes("CUST-"), "a label must not be able to contain an id");
  assert.strictEqual(labelFor(route), label, "the same route always gives the same bucket");
});

test("everything unroutable shares one bucket", function () {
  // A scanner walking a URL dictionary is exactly the traffic that would
  // otherwise blow the label cap.
  assert.strictEqual(labelFor(null), "unmatched");
  assert.strictEqual(labelFor(undefined), "unmatched");
});

// --- classification: what counts as what ----------------------------------

test("a 4xx is a success, because the server did its job", function () {
  // Stated as a test because the number it produces gets read as "are we
  // healthy". A burst of scanner 401s must not look like an outage.
  for (const statusCode of [200, 201, 304, 400, 401, 403, 404, 413, 429]) {
    assert.strictEqual(
      classifyOutcome(fakeResponse({ statusCode })),
      OUTCOMES.SUCCESS,
      statusCode + " should count as served"
    );
  }
});

test("a 5xx is a failure, because the server broke its own contract", function () {
  for (const statusCode of [500, 502, 503]) {
    assert.strictEqual(classifyOutcome(fakeResponse({ statusCode })), OUTCOMES.FAILURE);
  }
});

test("a client that hung up is aborted, not a success", function () {
  // THE TRAP. When a client disconnects mid-response, res.statusCode is
  // whatever was last set - often the default 200. Trusting it would file
  // every abandoned request as a success, and abandoned requests are the
  // signature of the overload this story is about.
  const res = fakeResponse({ statusCode: 200, writableFinished: false });
  assert.strictEqual(classifyOutcome(res), OUTCOMES.ABORTED);
});

// --- observation: counted exactly once ------------------------------------

test("a finished request is recorded once, by the close event", function () {
  const metrics = createPerfMetrics();
  const res = fakeResponse({ statusCode: 200 });

  observe({ metrics, res, route: { method: "GET", pattern: /^\/x$/ }, startedAt: Date.now() });
  res.finish();

  const snapshot = metrics.snapshot();
  assert.strictEqual(snapshot.overall.volume, 1);
  assert.strictEqual(snapshot.overall.successes, 1);
});

test("a shed request is not also counted when its 503 closes", function () {
  // DOUBLE COUNTING. The shed path records, then sends a 503, which fires
  // `close` and would record again. One request counted twice makes every
  // rate wrong in a way that is very hard to spot - the totals just drift.
  const metrics = createPerfMetrics();
  const res = fakeResponse({ statusCode: 503 });

  const observed = observe({
    metrics,
    res,
    route: { method: "GET", pattern: /^\/x$/ },
    startedAt: Date.now(),
  });

  assert.strictEqual(observed.recordShed(), true, "the shed is what gets recorded");
  res.finish();

  const snapshot = metrics.snapshot();
  assert.strictEqual(snapshot.overall.volume, 1, "once, not twice");
  assert.strictEqual(snapshot.overall.shed, 1);
  assert.strictEqual(snapshot.overall.failures, 0, "and not ALSO as a 5xx failure");
});

test("the health probe is kept out of the aggregate entirely", function () {
  // Found by a smoke test, not by reasoning: the probe's own 503 was being
  // filed as a server failure, so a balancer polling through a busy period
  // manufactured an outage out of correct behaviour. Probe traffic also
  // flatters volume and p50, since it arrives whether anyone is using the
  // system or not.
  const metrics = createPerfMetrics();
  const route = { method: "GET", pattern: /^\/api\/health$/, excludeFromMetrics: true };

  for (const statusCode of [200, 503, 200, 503]) {
    const res = fakeResponse({ statusCode });
    observe({ metrics, res, route, startedAt: Date.now() });
    res.finish();
  }

  const snapshot = metrics.snapshot();
  assert.strictEqual(snapshot.overall.volume, 0, "no probe traffic in the aggregate");
  assert.strictEqual(snapshot.overall.failure_rate, null, "and so no invented failure rate");
});

test("an excluded route still returns a usable handle", function () {
  // The pipeline calls recordShed() without knowing whether the route is
  // excluded. Returning null here would be a TypeError on a shed request.
  const metrics = createPerfMetrics();
  const observed = observe({
    metrics,
    res: fakeResponse(),
    route: { method: "GET", pattern: /^\/x$/, excludeFromMetrics: true },
    startedAt: Date.now(),
  });

  assert.doesNotThrow(function () {
    observed.recordShed();
  });
  assert.strictEqual(metrics.snapshot().overall.volume, 0);
});

// --- admission ------------------------------------------------------------

test("an admitted request carries a ticket the caller must release", async function () {
  const governor = createLoadGovernor({ maxInFlight: 2 });
  const metrics = createPerfMetrics();
  const res = fakeResponse();
  const observed = observe({ metrics, res, route: { method: "GET", pattern: /^\/x$/ }, startedAt: 0 });

  const admission = await admit({ governor, route: { method: "GET", pattern: /^\/x$/ }, observed });

  assert.strictEqual(admission.admitted, true);
  assert.ok(admission.ticket, "the caller needs something to release");
  assert.strictEqual(governor.state().in_flight, 1);

  admission.ticket.release();
  assert.strictEqual(governor.state().in_flight, 0);
});

test("an exempt route is admitted without taking a slot at all", async function () {
  // The probe must not consume the capacity it is reporting on, and the
  // pipeline must not be handed a ticket it would then release - that would
  // decrement a counter it never incremented.
  const governor = createLoadGovernor({ maxInFlight: 1 });
  const metrics = createPerfMetrics();
  const route = { method: "GET", pattern: /^\/api\/health$/, alwaysAdmit: true, public: true };
  const observed = observe({ metrics, res: fakeResponse(), route, startedAt: 0 });

  const admission = await admit({ governor, route, observed });

  assert.strictEqual(admission.admitted, true);
  assert.strictEqual(admission.ticket, null, "no ticket means nothing to release");
  assert.strictEqual(admission.exempt, true);
  assert.strictEqual(governor.state().in_flight, 0, "the probe costs no capacity");
});

test("the probe is admitted while everything else is being refused", async function () {
  // THE SELF-INFLICTED-OUTAGE TEST. If the probe were shed, a balancer could
  // not tell "at capacity" from "dead" - and it would never learn about the
  // recovery, because the probe that would report it is the one being refused.
  const governor = createLoadGovernor({ maxInFlight: 1, maxQueueDepth: 0 });
  const metrics = createPerfMetrics();
  const normal = { method: "GET", pattern: /^\/api\/quotes$/ };
  const probe = { method: "GET", pattern: /^\/api\/health$/, alwaysAdmit: true, public: true };

  const held = await admit({
    governor,
    route: normal,
    observed: observe({ metrics, res: fakeResponse(), route: normal, startedAt: 0 }),
  });
  assert.strictEqual(held.admitted, true);

  const refused = await admit({
    governor,
    route: normal,
    observed: observe({ metrics, res: fakeResponse(), route: normal, startedAt: 0 }),
  });
  assert.strictEqual(refused.admitted, false, "normal traffic is shed");

  const probed = await admit({
    governor,
    route: probe,
    observed: observe({ metrics, res: fakeResponse(), route: probe, startedAt: 0 }),
  });
  assert.strictEqual(probed.admitted, true, "the probe still answers");
});

test("a shed admission reports why, when to retry, and the load that caused it", async function () {
  const governor = createLoadGovernor({ maxInFlight: 1, maxQueueDepth: 0, retryAfterSeconds: 7 });
  const metrics = createPerfMetrics();
  const route = { method: "GET", pattern: /^\/x$/ };

  await admit({ governor, route, observed: observe({ metrics, res: fakeResponse(), route, startedAt: 0 }) });
  const admission = await admit({
    governor,
    route,
    observed: observe({ metrics, res: fakeResponse(), route, startedAt: 0 }),
  });

  assert.strictEqual(admission.admitted, false);
  assert.strictEqual(admission.reason, "queue_full");
  assert.strictEqual(admission.retryAfterSeconds, 7);
  assert.strictEqual(admission.load.saturated, true, "the log line can say why");
  assert.strictEqual(metrics.snapshot().overall.shed, 1, "and the shed is counted");
});

// --- the startup guard on shed exemptions ---------------------------------

test("the real route table passes the exemption guard", function () {
  // Runs the guard against the SHIPPING table, so adding an unsafe exemption
  // to any route module fails here rather than at boot in production.
  assert.doesNotThrow(function () {
    assertShedExemptionsAreSafe(ROUTES);
  });
});

test("a write may not bypass the concurrency bound", function () {
  // An exempt POST reaches the store and the audit log with no limit on
  // concurrency - which walks straight into the whole-file-rewrite bottleneck
  // this story exists to bound.
  assert.throws(
    function () {
      assertShedExemptionsAreSafe([
        { method: "POST", pattern: /^\/api\/x$/, public: true, alwaysAdmit: true },
      ]);
    },
    /not a GET/
  );
});

test("an exemption that still authenticates is refused", function () {
  // Authentication is the expensive half of the pipeline; exempting a route
  // that performs it defeats the purpose of refusing early.
  assert.throws(
    function () {
      assertShedExemptionsAreSafe([
        { method: "GET", pattern: /^\/api\/x$/, permission: "ops.metrics.read", alwaysAdmit: true },
      ]);
    },
    /not public/
  );
});

test("a route with no exemption is not examined", function () {
  assert.doesNotThrow(function () {
    assertShedExemptionsAreSafe([{ method: "POST", pattern: /^\/api\/x$/, permission: "quotes.write" }]);
  });
});

// --- the logged snapshot: the story's third acceptance criterion ----------

test("the aggregate is written to the log stream with its percentiles", async function () {
  const metrics = createPerfMetrics();
  const governor = createLoadGovernor({ maxInFlight: 4 });
  const lines = [];

  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 12 });

  const stop = startSnapshotLogging({
    metrics,
    governor,
    log: function (level, event, context) {
      lines.push({ level, event, context });
    },
    intervalMs: 10,
  });

  // Poll rather than sleep a fixed amount: slow under load, never flaky.
  const deadline = Date.now() + 2_000;
  while (lines.length === 0 && Date.now() < deadline) {
    await new Promise(function (resolve) {
      setTimeout(resolve, 5);
    });
  }
  stop();

  assert.ok(lines.length > 0, "a snapshot must actually reach the log stream");
  const line = lines[0];
  assert.strictEqual(line.event, "perf_snapshot");
  assert.strictEqual(line.context.performance.overall.latency_ms.p95, 12);
  assert.strictEqual(line.context.load.max_in_flight, 4);
});

test("stopping the snapshot logger stops it", async function () {
  const lines = [];
  const stop = startSnapshotLogging({
    metrics: createPerfMetrics(),
    governor: createLoadGovernor(),
    log: function () {
      lines.push(1);
    },
    intervalMs: 10,
  });
  stop();

  await new Promise(function (resolve) {
    setTimeout(resolve, 50);
  });
  assert.strictEqual(lines.length, 0);
});

test("an interval of zero disables snapshot logging without erroring", function () {
  let called = false;
  const stop = startSnapshotLogging({
    metrics: createPerfMetrics(),
    governor: createLoadGovernor(),
    log: function () {
      called = true;
    },
    intervalMs: 0,
  });

  assert.strictEqual(typeof stop, "function", "the caller still gets something to call");
  assert.doesNotThrow(stop);
  assert.strictEqual(called, false);
});

test("a misspelt metrics interval falls back instead of refusing to boot", function () {
  // Deliberately UNLIKE a concurrency limit, which throws. A wrong interval
  // cannot hurt anything, and taking the system down to protect the cadence of
  // its own dashboard would be the wrong trade.
  const saved = process.env.COLABERRY_METRICS_INTERVAL_MS;
  try {
    process.env.COLABERRY_METRICS_INTERVAL_MS = "every minute";
    assert.strictEqual(snapshotIntervalFromEnv(), DEFAULT_SNAPSHOT_INTERVAL_MS);

    process.env.COLABERRY_METRICS_INTERVAL_MS = "0";
    assert.strictEqual(snapshotIntervalFromEnv(), 0, "zero is a real choice, not a typo");

    process.env.COLABERRY_METRICS_INTERVAL_MS = "5000";
    assert.strictEqual(snapshotIntervalFromEnv(), 5_000);
  } finally {
    if (saved === undefined) {
      delete process.env.COLABERRY_METRICS_INTERVAL_MS;
    } else {
      process.env.COLABERRY_METRICS_INTERVAL_MS = saved;
    }
  }
});

// --- the network-latency bounds ------------------------------------------

test("the server timeouts are tightened well below Node's defaults", function () {
  // Node ships requestTimeout 300s and headersTimeout 60s. Those are sane for
  // a file upload and wrong for a 64KB JSON API: a few hundred slow sockets is
  // a denial of service that costs the attacker nothing.
  const server = {};
  applyTimeouts(server);

  assert.strictEqual(server.requestTimeout, 30_000);
  assert.strictEqual(server.headersTimeout, 10_000);
  assert.strictEqual(server.keepAliveTimeout, 5_000);

  assert.ok(
    server.headersTimeout < server.requestTimeout,
    "headers must be bounded tighter than the whole request - that is the slowloris case"
  );
  assert.ok(
    server.keepAliveTimeout < server.headersTimeout,
    "an idle socket must not outlive a request being read"
  );
  assert.strictEqual(SERVER_TIMEOUTS.requestTimeout, 30_000, "exported for the deploy docs");
});
