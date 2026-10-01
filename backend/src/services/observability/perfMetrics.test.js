// STORY-016: the metrics recorder, including the ways it could lie.
//
// A metrics module is unusual to test, because a bug in it does not break a
// feature - it produces a NUMBER THAT LOOKS FINE AND IS WRONG, which an
// operator then uses to decide the system is healthy. So these tests are
// weighted towards the lies: a percentile computed from a poisoned sample, a
// success rate that counts a shed request as a success, a breakdown that
// quietly stops being complete, a rate invented out of zero traffic.

"use strict";

const assert = require("assert");
const test = require("node:test");

const {
  createPerfMetrics,
  OUTCOMES,
  SAMPLE_WINDOW,
  MAX_LABELS,
  OTHER_LABEL,
  __percentile,
} = require("./perfMetrics");

// --- the percentile definition itself ------------------------------------

test("percentile uses nearest-rank over the ascending sort", function () {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  // ceil(p/100 * 10) - 1 => p50 lands on index 4, p95 and p99 on index 9.
  assert.strictEqual(__percentile(sorted, 50), 50);
  assert.strictEqual(__percentile(sorted, 95), 100);
  assert.strictEqual(__percentile(sorted, 99), 100);
});

test("percentile of nothing is null, not zero", function () {
  // Zero would read as "instant" on a dashboard. This is the difference
  // between "fast" and "never called", and they must not look the same.
  assert.strictEqual(__percentile([], 95), null);
});

test("percentile never indexes outside the sample", function () {
  // The clamp. An off-by-one here returns undefined, which serialises to null
  // in JSON and would look exactly like "no data" on a busy endpoint.
  assert.strictEqual(__percentile([7], 99), 7);
  assert.strictEqual(__percentile([7], 1), 7);
  assert.strictEqual(__percentile([1, 2], 100), 2);
});

// --- the happy path -------------------------------------------------------

test("records volume, rates and percentiles for a route", function () {
  const metrics = createPerfMetrics();

  for (const durationMs of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    metrics.record({ label: "GET /api/crm/customers", outcome: OUTCOMES.SUCCESS, durationMs });
  }

  const snapshot = metrics.snapshot();
  const route = snapshot.routes["GET /api/crm/customers"];

  assert.strictEqual(route.volume, 10);
  assert.strictEqual(route.successes, 10);
  assert.strictEqual(route.success_rate, 1);
  assert.strictEqual(route.failure_rate, 0);
  assert.strictEqual(route.latency_ms.samples, 10);
  assert.strictEqual(route.latency_ms.p50, 50);
  assert.strictEqual(route.latency_ms.p95, 100);
  assert.strictEqual(route.latency_ms.max, 100);

  // The overall bucket is charged in step with the per-route one, so a reader
  // can trust that the totals and the breakdown describe the same traffic.
  assert.strictEqual(snapshot.overall.volume, 10);
  assert.strictEqual(snapshot.overall.latency_ms.p50, 50);
});

test("emits every metric CLAUDE.md's observability framework requires", function () {
  // Named explicitly so that renaming a field fails HERE, loudly, rather than
  // silently blanking a dashboard panel that reads it.
  const metrics = createPerfMetrics();
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 5, retries: 2 });

  const overall = metrics.snapshot().overall;
  for (const field of ["volume", "success_rate", "failure_rate", "retry_count", "latency_ms"]) {
    assert.ok(field in overall, "missing required metric: " + field);
  }
  assert.strictEqual(overall.retry_count, 2);
  for (const p of ["p50", "p95", "p99"]) {
    assert.ok(p in overall.latency_ms, "missing required percentile: " + p);
  }
});

test("snapshot is pure - two snapshots of the same traffic agree", function () {
  // This is what makes a snapshot diffable to get a rate over an interval. If
  // reading reset the counters, the second reader would see zero and conclude
  // the system had gone idle.
  const metrics = createPerfMetrics();
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 1 });

  assert.strictEqual(metrics.snapshot().overall.volume, 1);
  assert.strictEqual(metrics.snapshot().overall.volume, 1);
});

// --- the lies -------------------------------------------------------------

test("a shed request is not a failure and is not a success", function () {
  // Shedding is the system working as designed under overload. Counting it as
  // a failure would make correct behaviour page someone; counting it as a
  // success would hide saturation completely.
  const metrics = createPerfMetrics();
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 1 });
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SHED, durationMs: 0 });

  const overall = metrics.snapshot().overall;
  assert.strictEqual(overall.volume, 2);
  assert.strictEqual(overall.successes, 1);
  assert.strictEqual(overall.failures, 0);
  assert.strictEqual(overall.shed, 1);
  assert.strictEqual(overall.success_rate, 0.5);
  assert.strictEqual(overall.shed_rate, 0.5);
});

test("an unrecognised outcome is never filed as a success", function () {
  // The failure mode this prevents: a caller typos "ok" and every dashboard
  // reports 100% success forever.
  const metrics = createPerfMetrics();
  metrics.record({ label: "GET /x", outcome: "ok", durationMs: 1 });

  const overall = metrics.snapshot().overall;
  assert.strictEqual(overall.volume, 1);
  assert.strictEqual(overall.successes, 0);
  assert.strictEqual(overall.unknown, 1);
  assert.strictEqual(overall.success_rate, 0);
});

test("a non-finite duration is counted but cannot poison the percentiles", function () {
  // FAILURE PATH. One NaN in the sample ring makes every percentile computed
  // from it afterwards NaN, so a single bad call would blind the whole window.
  const metrics = createPerfMetrics();
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 10 });
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: NaN });
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: undefined });
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: -5 });
  metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 30 });

  const route = metrics.snapshot().routes["GET /x"];
  assert.strictEqual(route.volume, 5, "every request still counts towards volume");
  assert.strictEqual(route.latency_ms.samples, 2, "only the measurable ones reach the ring");
  assert.strictEqual(route.latency_ms.p50, 10);
  assert.strictEqual(route.latency_ms.max, 30);
});

test("rates are null under zero traffic rather than invented", function () {
  const metrics = createPerfMetrics();
  const overall = metrics.snapshot().overall;

  assert.strictEqual(overall.volume, 0);
  assert.strictEqual(overall.success_rate, null, "0/0 is not 0% and not 100%");
  assert.strictEqual(overall.failure_rate, null);
  assert.strictEqual(overall.latency_ms.p95, null);
  assert.deepStrictEqual(metrics.snapshot().routes, {});
});

// --- the bounds, which is why this module exists at all -------------------

test("latency memory is bounded - the ring holds only the recent window", function () {
  // THE SCALABILITY PROPERTY. Without the ring, this loop would retain 2x
  // SAMPLE_WINDOW numbers and the percentile sort would get slower as traffic
  // grew. The thing built to prove we scale must not itself leak.
  const metrics = createPerfMetrics();

  // Fill the window with 1ms, then overwrite it completely with 500ms.
  for (let i = 0; i < SAMPLE_WINDOW; i += 1) {
    metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 1 });
  }
  for (let i = 0; i < SAMPLE_WINDOW; i += 1) {
    metrics.record({ label: "GET /x", outcome: OUTCOMES.SUCCESS, durationMs: 500 });
  }

  const route = metrics.snapshot().routes["GET /x"];
  assert.strictEqual(route.volume, SAMPLE_WINDOW * 2, "the COUNTER keeps all of history");
  assert.strictEqual(route.latency_ms.samples, SAMPLE_WINDOW, "the SAMPLE does not");
  assert.strictEqual(
    route.latency_ms.p50,
    500,
    "a regression that started recently is visible; the old fast window has aged out"
  );
});

test("label cardinality is capped, and the overflow is reported not hidden", function () {
  // THE OTHER SCALABILITY PROPERTY. This simulates the misuse the comment at
  // the top of perfMetrics.js warns about: labelling by path, so every
  // customer id becomes its own metric bucket. Thousands of customers is
  // exactly the load this story is about.
  const metrics = createPerfMetrics();

  const distinct = MAX_LABELS + 250;
  for (let i = 0; i < distinct; i += 1) {
    metrics.record({
      label: "GET /api/crm/customers/CUST-" + i,
      outcome: OUTCOMES.SUCCESS,
      durationMs: 3,
    });
  }

  const snapshot = metrics.snapshot();
  assert.ok(
    snapshot.labels_tracked <= MAX_LABELS + 1,
    "buckets must stay bounded, saw " + snapshot.labels_tracked
  );
  assert.ok(snapshot.label_overflows > 0, "overflow must be visible to an operator");
  assert.strictEqual(
    snapshot.overall.volume,
    distinct,
    "TOTALS STAY TRUE even when the breakdown degrades - folded, never dropped"
  );
  assert.ok(snapshot.routes[OTHER_LABEL], "the folded traffic lands somewhere readable");
});

test("a missing or blank label is charged to the fold, never thrown", function () {
  // Recording a measurement must not be the reason a request fails.
  const metrics = createPerfMetrics();

  assert.doesNotThrow(function () {
    metrics.record({ outcome: OUTCOMES.SUCCESS, durationMs: 1 });
    metrics.record({ label: "   ", outcome: OUTCOMES.SUCCESS, durationMs: 1 });
    metrics.record();
  });

  const snapshot = metrics.snapshot();
  assert.strictEqual(snapshot.overall.volume, 3);
  assert.strictEqual(snapshot.routes[OTHER_LABEL].volume, 3);
});

test("uptime comes from the injected clock", function () {
  // The snapshot's window bounds have to be testable without sleeping.
  let clock = 1_000;
  const metrics = createPerfMetrics({
    now: function () {
      return clock;
    },
  });

  clock = 61_000;
  assert.strictEqual(metrics.snapshot().uptime_ms, 60_000);
});
