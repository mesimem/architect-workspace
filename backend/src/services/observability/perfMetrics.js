// STORY-016: what the system records about its own performance under load.
//
// WHY THIS EXISTS. server.js already logs one line per request with a
// duration_ms on it, which answers "how long did THAT request take". It cannot
// answer the question REQ-018 actually asks - "is the system still healthy with
// forty advisors and a few thousand customers on it" - because nothing
// aggregates those lines. A p95 is not visible in a stream of individual
// timings; you have to hold a sample and sort it. That is this file's whole
// job, and it is the third acceptance criterion of this story: when the system
// scales, performance metrics must be LOGGED, not merely produced.
//
// CLAUDE.md's Observability Framework names the five metrics every
// long-running operation must emit. This module produces all five:
//
//   volume          count over the window
//   success_rate    rolling, to catch a silent regression
//   failure_rate    rolling, to triage classes of failure
//   retry_count     to catch upstream brittleness
//   latency_ms      p50, p95, p99, to catch a performance regression
//
// BOUNDED ON PURPOSE - THIS IS THE PART THAT MATTERS. The naive metrics
// recorder is `{}` keyed on the request path with every duration pushed onto an
// array. Under the exact load this story is about, that is a memory leak with
// two heads:
//
//   1. UNBOUNDED KEYS. Key on the pathname and /api/crm/customers/<uuid>
//      becomes one key per customer. Thousands of customers means thousands of
//      metric buckets, and the thing built to prove we scale is what runs the
//      process out of memory. So callers pass a route LABEL (the pattern, not
//      the path), and even then the number of labels is capped - see
//      MAX_LABELS. Overflow is folded into one "other" bucket rather than
//      dropped, so the totals stay true even when the breakdown stops.
//   2. UNBOUNDED SAMPLES. Keeping every duration forever means the array grows
//      with traffic and the percentile sort gets slower as the system gets
//      busier - the cost lands exactly when you can least afford it. So each
//      label holds a fixed-size ring of the most recent durations. Memory per
//      label is constant and the sort is over a known, small N.
//
// The counters (volume, successes, failures, retries) are NOT windowed - they
// are monotonic totals since process start, which is what makes them safe to
// diff between two snapshots. The LATENCY is windowed, because a percentile
// over all of history stops reacting to a regression that started a minute ago.
// Those are two different jobs and conflating them is why metrics lie.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Nothing user-visible, and that is a
//     deliberate choice: recording a measurement must never be the reason a
//     request fails. record() does no I/O and cannot throw on a well-formed
//     call; a malformed call is charged to the "other" label rather than
//     raising. Observability is not worth a 500.
//  2. Will it retry? There is nothing to retry. No I/O, no network, no disk.
//  3. Recovery path? A restart. The counters are in-process by design - this
//     module is the SOURCE of metrics, not their long-term store. The snapshot
//     is emitted to the structured log stream, which is where durability for
//     metrics belongs (12-factor: logs are event streams).
//  4. Handled: label cardinality overflow, a sample window smaller than the
//     traffic, zero-traffic percentiles, non-finite durations, unknown
//     outcomes. NOT handled: cross-process aggregation (each instance reports
//     its own numbers; summing them is the log aggregator's job, and is exactly
//     how this stays correct behind a load balancer), and clock changes - we
//     take durations from the caller rather than timestamping twice.

"use strict";

// Sized so the percentile sort is trivial and a label costs a predictable
// couple of kilobytes. 512 samples at the traffic this story tests is the last
// several seconds of requests, which is the window an operator cares about.
const SAMPLE_WINDOW = 512;

// Beyond this many distinct route labels we stop breaking down and start
// folding into OTHER_LABEL. The route table has well under this many entries,
// so hitting the cap means something is passing paths instead of patterns -
// which the overflow counter in the snapshot makes visible rather than silent.
const MAX_LABELS = 64;

const OTHER_LABEL = "other";

// The outcomes a request can have, and the only strings that move the
// rate counters. An outcome outside this set is counted in `volume` and
// `unknown` but is NOT silently filed as a success - a metric that reports
// 100% success because it did not recognise the failure is worse than no
// metric at all.
const OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  // A request the load governor refused to admit. Deliberately NOT a failure:
  // shedding is the system working as designed under overload, and folding it
  // into failure_rate would make correct behaviour look like an outage. It gets
  // its own counter so saturation is visible on its own terms.
  SHED: "shed",
  // The client disconnected before we finished answering - it gave up, or its
  // own timeout fired. Not a success (nobody was served) and not a server
  // failure (we did not break), so it gets a third category rather than being
  // forced into one of the first two.
  //
  // THIS IS THE MOST DIAGNOSTIC COUNTER HERE, and the reason it exists at all.
  // A rising abort rate is the leading indicator of the queueing collapse
  // loadGovernor.js describes: clients time out, retry, and add the load that
  // made them time out. Folded into success it would be invisible; folded into
  // failure it would look like our bug and send someone reading stack traces
  // that do not exist. It does drag success_rate down, which is correct - a
  // client that gave up was not served.
  ABORTED: "aborted",
});

function createRing(capacity) {
  return { values: new Array(capacity), count: 0, next: 0 };
}

function pushSample(ring, value) {
  ring.values[ring.next] = value;
  ring.next = (ring.next + 1) % ring.values.length;
  if (ring.count < ring.values.length) {
    ring.count += 1;
  }
}

// Nearest-rank percentile on the samples currently held. Stated explicitly
// because "p95" is ambiguous - there are several defensible definitions and a
// reader comparing these numbers against another tool needs to know which one
// this is. index = ceil(p/100 * n) - 1 over the ascending sort, clamped.
//
// Returns null, not 0, when there is nothing to measure. Zero would read as
// "instant" on a dashboard and is the wrong answer to "how slow is an endpoint
// nobody has called".
function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index];
}

function emptyBucket() {
  return {
    volume: 0,
    successes: 0,
    failures: 0,
    shed: 0,
    aborted: 0,
    unknown: 0,
    retries: 0,
    latency: createRing(SAMPLE_WINDOW),
  };
}

function rate(part, total) {
  // No traffic means no rate. 0/0 is not 0% and not 100%; reporting either one
  // invents a fact. null is the honest answer and renders as "-".
  return total === 0 ? null : Number((part / total).toFixed(4));
}

function summarise(bucket) {
  // Copy before sorting: the ring is live and a sort in place would scramble
  // the insertion order that pushSample relies on.
  const samples = bucket.latency.values.slice(0, bucket.latency.count).sort(function (a, b) {
    return a - b;
  });

  return {
    volume: bucket.volume,
    successes: bucket.successes,
    failures: bucket.failures,
    shed: bucket.shed,
    aborted: bucket.aborted,
    unknown: bucket.unknown,
    retry_count: bucket.retries,
    success_rate: rate(bucket.successes, bucket.volume),
    failure_rate: rate(bucket.failures, bucket.volume),
    shed_rate: rate(bucket.shed, bucket.volume),
    // Published as its own rate, not just a count, because it is the one an
    // alert should fire on - see the ABORTED note in OUTCOMES.
    abort_rate: rate(bucket.aborted, bucket.volume),
    latency_ms: {
      // Named so a reader knows the percentiles describe the window, not all
      // of history, and knows how many points they are computed from. A p99
      // over 7 samples is not a p99, and this is what says so.
      samples: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples.length === 0 ? null : samples[samples.length - 1],
    },
  };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] Injectable clock, for deterministic
 *   tests. Used only for the snapshot's window bounds - durations are supplied
 *   by the caller, who is the only one who knows when the work started.
 */
function createPerfMetrics({ now = Date.now } = {}) {
  const startedAt = now();
  const overall = emptyBucket();
  const byLabel = new Map();
  let labelOverflows = 0;

  function bucketFor(label) {
    const existing = byLabel.get(label);
    if (existing) {
      return existing;
    }
    if (byLabel.size >= MAX_LABELS) {
      // Fold rather than drop. The breakdown degrades; the totals do not.
      //
      // DELIBERATELY NOT RECURSIVE. The first version of this called
      // bucketFor(OTHER_LABEL) to reuse the create-and-insert path below, and
      // that recursed until the stack blew: at the cap, the fold bucket does
      // not exist yet either, so every call took this same branch again. It
      // failed under precisely the load this module is here to survive, which
      // is what the cardinality test caught. The fold bucket is created
      // directly, and is the one bucket allowed to exceed the cap - overflow
      // traffic must always have somewhere to go.
      labelOverflows += 1;
      let fold = byLabel.get(OTHER_LABEL);
      if (!fold) {
        fold = emptyBucket();
        byLabel.set(OTHER_LABEL, fold);
      }
      return fold;
    }
    const created = emptyBucket();
    byLabel.set(label, created);
    return created;
  }

  function charge(bucket, outcome, durationMs, retries) {
    bucket.volume += 1;

    if (outcome === OUTCOMES.SUCCESS) {
      bucket.successes += 1;
    } else if (outcome === OUTCOMES.FAILURE) {
      bucket.failures += 1;
    } else if (outcome === OUTCOMES.SHED) {
      bucket.shed += 1;
    } else if (outcome === OUTCOMES.ABORTED) {
      bucket.aborted += 1;
    } else {
      bucket.unknown += 1;
    }

    if (Number.isFinite(retries) && retries > 0) {
      bucket.retries += retries;
    }

    // A non-finite duration is charged to volume but not to latency. Letting
    // NaN into the sample ring poisons every percentile computed from it
    // afterwards, and a single bad call should not blind the whole window.
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      pushSample(bucket.latency, durationMs);
    }
  }

  return {
    OUTCOMES: OUTCOMES,

    /**
     * Record one completed (or refused) request.
     *
     * @param {object} measurement
     * @param {string} measurement.label The route PATTERN, never the raw path.
     *   See the cardinality note at the top of this file - passing a path here
     *   is the one way to misuse this module.
     * @param {string} measurement.outcome One of OUTCOMES.
     * @param {number} [measurement.durationMs] Wall time the caller measured.
     * @param {number} [measurement.retries] Retries the caller spent, if any.
     */
    record: function ({ label, outcome, durationMs, retries } = {}) {
      const safeLabel = typeof label === "string" && label.trim() !== "" ? label.trim() : OTHER_LABEL;
      charge(overall, outcome, durationMs, retries);
      charge(bucketFor(safeLabel), outcome, durationMs, retries);
    },

    /**
     * The whole picture, shaped for a log line or an operator endpoint.
     * Pure - taking a snapshot does not reset anything, so two snapshots can be
     * diffed to get the rate over the interval between them.
     */
    snapshot: function () {
      const routes = {};
      for (const [label, bucket] of byLabel) {
        routes[label] = summarise(bucket);
      }
      return {
        started_at: new Date(startedAt).toISOString(),
        uptime_ms: now() - startedAt,
        sample_window: SAMPLE_WINDOW,
        // Non-zero means the breakdown below is incomplete and someone is
        // passing high-cardinality labels. Surfaced, never swallowed.
        label_overflows: labelOverflows,
        labels_tracked: byLabel.size,
        overall: summarise(overall),
        routes: routes,
      };
    },
  };
}

module.exports = {
  createPerfMetrics,
  OUTCOMES,
  SAMPLE_WINDOW,
  MAX_LABELS,
  OTHER_LABEL,
  // Exported for its own test. The percentile definition is the part of this
  // file most likely to be quietly wrong, and a wrong p95 is worse than none -
  // it is a number an operator will trust.
  __percentile: percentile,
};
