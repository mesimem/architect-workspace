// STORY-016: what the system does when more work arrives than it can do.
//
// WHY THIS EXISTS. Node accepts connections as fast as the kernel hands them
// over. Nothing in this repo has ever said no. With forty advisors and a few
// thousand customers on one instance, "accept everything" is not generosity -
// it is the failure mode:
//
//   every request is admitted, so each one gets a slice of a CPU that is now
//   oversubscribed, so every request gets slower, so the client times out and
//   RETRIES, which adds load, which makes it slower still. Latency climbs,
//   memory fills with half-finished work, and the process either thrashes or
//   is OOM-killed. Nobody gets served. That is a queueing collapse, and the
//   defining detail is that it is WORSE than refusing some traffic: at the
//   point of collapse the success rate is near zero, when it could have been
//   high for the subset the box could actually handle.
//
// So this module enforces a bound. A fixed number of requests are in flight; a
// bounded number may wait briefly for a slot; everything beyond that is
// REFUSED IMMEDIATELY and cheaply, with a 503 and a Retry-After. That refusal
// is the second acceptance criterion of this story - under a surge, the system
// does not crash. It sheds. A shed request is a bad second, not a bad hour.
//
// THIS IS ALSO THE HALF OF LOAD BALANCING THAT LIVES IN THE APPLICATION. A load
// balancer can only move traffic off a hot instance if the instance tells the
// truth about being hot. state() is what the health probe reads, so a saturated
// box reports itself degraded and the balancer drains it, while shedding keeps
// it alive long enough to recover rather than dying and dumping its
// connections. Balancing policy stays in the balancer, where it belongs; what
// has to be here is the honest signal and the refusal.
//
// WHY FIFO. A queued request is served oldest-first. LIFO would post a better
// p95 under sustained overload - fresh requests get served and the old ones
// were going to time out anyway - but it starves the unlucky, and it makes
// latency depend on arrival order in a way nobody can reason about during an
// incident. Predictable is worth more than flattering here.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Closed, in the safe direction: if the
//     governor is unsure it REFUSES rather than admits, because admitting past
//     the bound is the thing that collapses the process. A release() that never
//     arrives costs one permanently-held slot, not a crash - see the leak note
//     on release below, which is why release is idempotent and why the server
//     calls it in a finally.
//  2. Will it retry? Not here. The refusal carries Retry-After so the CLIENT
//     retries, which is the only layer that knows whether the request still
//     matters. Retrying inside the governor would add load at the moment we are
//     shedding to shed load.
//  3. Recovery path? Automatic. Slots free as work finishes, queued waiters are
//     admitted in order, and the health probe flips back to healthy so the
//     balancer returns traffic. No operator action, no dead-letter queue -
//     a shed request was never accepted, so there is nothing owed.
//  4. Handled: saturation, a full queue, a waiter that times out while queued,
//     a double release, a release after the server has moved on, and invalid
//     configuration (refuses to boot). NOT handled: per-caller fairness - one
//     noisy client can occupy the slots, and the fix for that is per-IP rate
//     limiting at nginx, which server.js already records as not its job. Also
//     not handled: CPU-bound handlers. The bound is on CONCURRENCY, not on
//     work; a handler that blocks the event loop for a second stops everything
//     regardless, and no admission policy can help.

"use strict";

// Defaults sized for one modest VPS instance. The point of a default is to be
// safe, not optimal: better to shed a little early on a small box than to
// discover the real ceiling by falling off it in production. Tune per
// deployment with the environment variables below.
const DEFAULTS = Object.freeze({
  // Requests executing at once. Handlers here are I/O-light and short, so this
  // is generous; it exists to bound memory and scheduler pressure.
  maxInFlight: 64,
  // How many may WAIT for a slot. Non-zero because real traffic is bursty and
  // a burst that clears in 50ms should be served, not refused. Bounded because
  // an unbounded wait queue is the collapse described above wearing a hat.
  maxQueueDepth: 256,
  // How long a request may wait before we give up on its behalf. Must stay
  // well under a typical client timeout: a wait that outlives the caller is
  // pure waste - we would do the work and nobody would be listening.
  queueTimeoutMs: 2_000,
  // What we tell a shed client to do. Seconds, because that is the unit of the
  // Retry-After header.
  retryAfterSeconds: 2,
});

const SHED_QUEUE_FULL = "queue_full";
const SHED_QUEUE_TIMEOUT = "queue_timeout";

class LoadGovernorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoadGovernorConfigError";
    this.errorClass = "ContractViolation";
  }
}

// Config that cannot be used is a refusal to boot, not a degradation. Same
// rule server.js applies to its route table: a typo in a limit must stop the
// process, because the alternative is silently running with no bound at all -
// which looks fine until the day it does not.
function readLimit(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(String(raw).trim());
  const floor = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < floor) {
    throw new LoadGovernorConfigError(
      name +
        " must be an integer >= " +
        floor +
        " (got " +
        JSON.stringify(raw) +
        "). Unset it to use the default of " +
        fallback +
        "."
    );
  }
  return value;
}

function loadGovernorConfigFromEnv() {
  return {
    maxInFlight: readLimit("COLABERRY_MAX_INFLIGHT", DEFAULTS.maxInFlight),
    // Zero is a legitimate choice: refuse the instant we are full, never queue.
    maxQueueDepth: readLimit("COLABERRY_MAX_QUEUE_DEPTH", DEFAULTS.maxQueueDepth, {
      allowZero: true,
    }),
    queueTimeoutMs: readLimit("COLABERRY_QUEUE_TIMEOUT_MS", DEFAULTS.queueTimeoutMs),
    retryAfterSeconds: readLimit("COLABERRY_RETRY_AFTER_SECONDS", DEFAULTS.retryAfterSeconds),
  };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] Injectable clock, for measuring waits.
 * @param {Function} [options.setTimer] Injectable setTimeout, so the queue
 *   timeout can be tested exactly rather than by sleeping and hoping.
 * @param {Function} [options.clearTimer] Injectable clearTimeout.
 */
function createLoadGovernor(options = {}) {
  const {
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    ...overrides
  } = options;

  const config = Object.assign({}, DEFAULTS, overrides);

  if (!Number.isInteger(config.maxInFlight) || config.maxInFlight < 1) {
    throw new LoadGovernorConfigError("maxInFlight must be an integer >= 1.");
  }
  if (!Number.isInteger(config.maxQueueDepth) || config.maxQueueDepth < 0) {
    throw new LoadGovernorConfigError("maxQueueDepth must be an integer >= 0.");
  }

  let inFlight = 0;
  let peakInFlight = 0;
  let admitted = 0;
  let queuedTotal = 0;
  const shedByReason = { [SHED_QUEUE_FULL]: 0, [SHED_QUEUE_TIMEOUT]: 0 };
  /** @type {Array<{settled: boolean, resolve: Function, timer: any, queuedAt: number}>} */
  const waiting = [];

  function grant(waitedMs) {
    inFlight += 1;
    admitted += 1;
    if (inFlight > peakInFlight) {
      peakInFlight = inFlight;
    }

    // RELEASE IS IDEMPOTENT, and that is a correctness requirement rather than
    // politeness. Two releases for one admission would decrement inFlight
    // twice, so the counter drifts below the real number of running requests
    // and the cap quietly stops being a cap - the bound erodes under exactly
    // the error conditions (a retry, a double finally, a handler that resolves
    // twice) where it matters most. CLAUDE.md's idempotency rule, applied to a
    // counter instead of an email.
    let released = false;
    return {
      admitted: true,
      waitedMs: waitedMs,
      release: function () {
        if (released) {
          return false;
        }
        released = true;
        inFlight -= 1;
        admitNextWaiter();
        return true;
      },
    };
  }

  function admitNextWaiter() {
    // A loop, not an `if`, because the head of the queue may be a waiter whose
    // timeout already fired. Handing the freed slot to a settled waiter would
    // silently lose capacity: the slot is never granted to anyone, inFlight
    // stays below the cap, and throughput drops for no visible reason. Skip
    // the dead ones until a live one is found or the queue empties.
    while (inFlight < config.maxInFlight && waiting.length > 0) {
      const waiter = waiting.shift();
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      clearTimer(waiter.timer);
      waiter.resolve(grant(now() - waiter.queuedAt));
      return;
    }
  }

  function shed(reason, waitedMs) {
    shedByReason[reason] += 1;
    return {
      admitted: false,
      reason: reason,
      retryAfterSeconds: config.retryAfterSeconds,
      waitedMs: waitedMs,
    };
  }

  return {
    /**
     * Ask for a slot. Always resolves - never rejects - with either
     * `{ admitted: true, release() }` or `{ admitted: false, reason }`.
     *
     * Resolving on refusal rather than rejecting is deliberate: being shed is
     * an expected operating state, not an exception, and expressing it as a
     * throw invites a caller to wrap it in a catch that also swallows real
     * bugs.
     */
    acquire: function () {
      if (inFlight < config.maxInFlight) {
        return Promise.resolve(grant(0));
      }

      if (waiting.length >= config.maxQueueDepth) {
        // The cheap refusal. Costs no slot, no timer, no body read - which is
        // the property that lets an instance survive a surge far larger than
        // its capacity instead of being dragged down by the cost of saying no.
        return Promise.resolve(shed(SHED_QUEUE_FULL, 0));
      }

      queuedTotal += 1;
      const queuedAt = now();
      return new Promise(function (resolve) {
        const waiter = { settled: false, resolve: resolve, timer: null, queuedAt: queuedAt };
        waiter.timer = setTimer(function () {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          // Left in `waiting` to be skipped by admitNextWaiter rather than
          // spliced out here: splicing is O(n) per timeout, and under overload
          // timeouts are the common case, so that cost arrives at the worst
          // moment. The queue length check above counts settled entries too,
          // which makes the bound conservative - it sheds slightly early
          // rather than slightly late, and erring toward refusal is the safe
          // direction.
          resolve(shed(SHED_QUEUE_TIMEOUT, now() - queuedAt));
        }, config.queueTimeoutMs);

        // A pending waiter must not hold the process open during a shutdown.
        if (waiter.timer && typeof waiter.timer.unref === "function") {
          waiter.timer.unref();
        }

        waiting.push(waiter);
      });
    },

    /**
     * What the health probe and the metrics endpoint read. `saturated` is the
     * signal a load balancer acts on: true means "drain me, I am at capacity",
     * and it is reported honestly even though reporting it costs this instance
     * traffic. A probe that always says healthy makes balancing impossible.
     */
    state: function () {
      // Settled entries linger in `waiting` (see the timeout note above), so
      // report the live depth - an operator reading queue_depth must not be
      // shown a backlog that has already given up and gone home.
      let liveQueueDepth = 0;
      for (const waiter of waiting) {
        if (!waiter.settled) {
          liveQueueDepth += 1;
        }
      }

      return {
        in_flight: inFlight,
        queue_depth: liveQueueDepth,
        max_in_flight: config.maxInFlight,
        max_queue_depth: config.maxQueueDepth,
        queue_timeout_ms: config.queueTimeoutMs,
        saturated: inFlight >= config.maxInFlight,
        peak_in_flight: peakInFlight,
        admitted_total: admitted,
        queued_total: queuedTotal,
        shed_total: shedByReason[SHED_QUEUE_FULL] + shedByReason[SHED_QUEUE_TIMEOUT],
        shed_queue_full: shedByReason[SHED_QUEUE_FULL],
        shed_queue_timeout: shedByReason[SHED_QUEUE_TIMEOUT],
      };
    },
  };
}

module.exports = {
  createLoadGovernor,
  loadGovernorConfigFromEnv,
  LoadGovernorConfigError,
  DEFAULTS,
  SHED_QUEUE_FULL,
  SHED_QUEUE_TIMEOUT,
};
