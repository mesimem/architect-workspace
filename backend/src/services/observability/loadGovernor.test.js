// STORY-016: the admission controller, and specifically the ways a bound stops
// being a bound.
//
// The happy path here is almost not worth testing - a counter that increments
// is hard to get wrong. What IS easy to get wrong, and what the system cannot
// survive, is a cap that erodes: a slot that is freed but never handed out, a
// release that frees two, a queue that reports a backlog of requests that have
// already given up. Each of those looks fine in a sequential test and shows up
// in production as throughput that mysteriously falls below capacity, or a
// process that dies at twice the limit it was configured with.
//
// TIME IS FAKED HERE, ON PURPOSE. The queue timeout is the heart of this
// module, and testing it with real timers means sleeping and hoping - which is
// flaky on a loaded machine and slow everywhere. The harness below lets a test
// fire a specific pending timer and assert exactly what happens next.

"use strict";

const assert = require("assert");
const test = require("node:test");

const {
  createLoadGovernor,
  loadGovernorConfigFromEnv,
  LoadGovernorConfigError,
  SHED_QUEUE_FULL,
  SHED_QUEUE_TIMEOUT,
} = require("./loadGovernor");

// A controllable setTimeout. Timers fire only when a test says so, in the
// order they were registered.
function createTimerHarness() {
  let nextId = 0;
  const pending = new Map();

  return {
    setTimer: function (fn) {
      const id = (nextId += 1);
      pending.set(id, fn);
      // Mimics a real Timeout closely enough for the unref() call in the
      // governor, which would otherwise throw on a plain object.
      return { id: id, unref: function () { return this; } };
    },
    clearTimer: function (handle) {
      if (handle) {
        pending.delete(handle.id);
      }
    },
    // Fires the oldest pending timer - i.e. the waiter that has been in the
    // queue longest, which is the one a real timeout would hit first.
    fireOldest: function () {
      const [id, fn] = pending.entries().next().value;
      pending.delete(id);
      fn();
    },
    pendingCount: function () {
      return pending.size;
    },
  };
}

function governorForTest({ maxInFlight = 1, maxQueueDepth = 4, queueTimeoutMs = 1_000 } = {}) {
  const timers = createTimerHarness();
  let clock = 0;
  const governor = createLoadGovernor({
    maxInFlight,
    maxQueueDepth,
    queueTimeoutMs,
    now: function () {
      return clock;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return {
    governor,
    timers,
    advance: function (ms) {
      clock += ms;
    },
  };
}

// Lets the microtask queue drain, so a promise resolved by release() has
// actually delivered before the assertion reads its result.
function flush() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

// --- the happy path -------------------------------------------------------

test("admits up to the cap without any waiting", async function () {
  const { governor } = governorForTest({ maxInFlight: 3 });

  for (let i = 0; i < 3; i += 1) {
    const ticket = await governor.acquire();
    assert.strictEqual(ticket.admitted, true);
    assert.strictEqual(ticket.waitedMs, 0, "below the cap nothing should queue");
  }

  const state = governor.state();
  assert.strictEqual(state.in_flight, 3);
  assert.strictEqual(state.saturated, true, "at the cap, say so");
  assert.strictEqual(state.shed_total, 0);
});

test("a request over the cap waits, then is admitted when a slot frees", async function () {
  const { governor, advance } = governorForTest({ maxInFlight: 1, maxQueueDepth: 4 });

  const first = await governor.acquire();
  const queued = governor.acquire();

  assert.strictEqual(governor.state().queue_depth, 1);

  advance(40);
  first.release();
  const ticket = await queued;

  assert.strictEqual(ticket.admitted, true);
  assert.strictEqual(ticket.waitedMs, 40, "the wait is measured, not guessed");
  assert.strictEqual(governor.state().queue_depth, 0);
  assert.strictEqual(governor.state().in_flight, 1);
});

test("queued requests are served oldest first", async function () {
  const { governor } = governorForTest({ maxInFlight: 1, maxQueueDepth: 4 });
  const order = [];

  const held = await governor.acquire();
  const a = governor.acquire().then(function (t) { order.push("a"); return t; });
  const b = governor.acquire().then(function (t) { order.push("b"); return t; });
  const c = governor.acquire().then(function (t) { order.push("c"); return t; });

  held.release();
  (await a).release();
  (await b).release();
  await c;

  assert.deepStrictEqual(order, ["a", "b", "c"], "FIFO: predictable beats flattering");
});

// --- failure path: overload ----------------------------------------------

test("beyond the queue depth, a request is shed immediately and cheaply", async function () {
  // THE SURGE CASE. Capacity 1, room for 2 to wait, and 50 arrive at once.
  // Every one of them gets an answer; none of them hangs; the process is fine.
  const { governor } = governorForTest({ maxInFlight: 1, maxQueueDepth: 2 });

  const held = await governor.acquire();
  governor.acquire(); // queued
  governor.acquire(); // queued, queue now full

  const results = await Promise.all(
    Array.from({ length: 50 }, function () {
      return governor.acquire();
    })
  );

  assert.strictEqual(results.length, 50);
  for (const result of results) {
    assert.strictEqual(result.admitted, false);
    assert.strictEqual(result.reason, SHED_QUEUE_FULL);
    assert.strictEqual(result.retryAfterSeconds, 2, "a shed client is told when to come back");
    assert.strictEqual(result.waitedMs, 0, "refusal must not cost a wait");
  }

  const state = governor.state();
  assert.strictEqual(state.in_flight, 1, "the cap held through the surge");
  assert.strictEqual(state.shed_queue_full, 50);
  assert.strictEqual(state.queue_depth, 2, "the bounded queue stayed bounded");

  held.release();
});

test("shedding never rejects - refusal is an operating state, not an exception", async function () {
  const { governor } = governorForTest({ maxInFlight: 1, maxQueueDepth: 0 });
  await governor.acquire();

  // If acquire() rejected, this would throw rather than resolve.
  const result = await governor.acquire();
  assert.strictEqual(result.admitted, false);
  assert.strictEqual(result.reason, SHED_QUEUE_FULL);
});

test("a queue depth of zero refuses the instant capacity is gone", async function () {
  const { governor, timers } = governorForTest({ maxInFlight: 2, maxQueueDepth: 0 });

  await governor.acquire();
  await governor.acquire();
  const shedResult = await governor.acquire();

  assert.strictEqual(shedResult.reason, SHED_QUEUE_FULL);
  assert.strictEqual(timers.pendingCount(), 0, "nothing queued means no timer was armed");
});

// --- failure path: waiting too long (network latency, slow upstream) ------

test("a waiter that exceeds the queue timeout is shed with its own reason", async function () {
  const { governor, timers, advance } = governorForTest({
    maxInFlight: 1,
    maxQueueDepth: 4,
    queueTimeoutMs: 500,
  });

  await governor.acquire();
  const queued = governor.acquire();

  advance(500);
  timers.fireOldest();
  const result = await queued;

  assert.strictEqual(result.admitted, false);
  assert.strictEqual(
    result.reason,
    SHED_QUEUE_TIMEOUT,
    "distinguished from queue_full: this one tells an operator the box is slow, not just busy"
  );
  assert.strictEqual(result.waitedMs, 500);
  assert.strictEqual(governor.state().shed_queue_timeout, 1);
});

test("a timed-out waiter does not take the freed slot with it", async function () {
  // THE SLOT LEAK. If admitNextWaiter used `if` instead of `while`, the freed
  // slot would be handed to the waiter that already gave up - granted to
  // nobody. in_flight would sit below the cap forever and throughput would
  // fall below capacity with nothing in the logs to explain it. This is the
  // single most valuable test in this file.
  const { governor, timers, advance } = governorForTest({
    maxInFlight: 1,
    maxQueueDepth: 4,
    queueTimeoutMs: 100,
  });

  const held = await governor.acquire();
  const givesUp = governor.acquire();
  const stillWaiting = governor.acquire();

  advance(100);
  timers.fireOldest(); // only the FIRST waiter times out
  assert.strictEqual((await givesUp).reason, SHED_QUEUE_TIMEOUT);

  held.release();
  await flush();

  const ticket = await stillWaiting;
  assert.strictEqual(ticket.admitted, true, "the live waiter got the slot");
  assert.strictEqual(governor.state().in_flight, 1, "capacity is fully used, not leaked");
});

test("queue_depth reports live waiters, not ones that already gave up", async function () {
  // An operator reading a backlog of 3 when 2 of them have gone home will
  // scale up the wrong thing.
  const { governor, timers, advance } = governorForTest({
    maxInFlight: 1,
    maxQueueDepth: 4,
    queueTimeoutMs: 100,
  });

  await governor.acquire();
  const a = governor.acquire();
  const b = governor.acquire();
  assert.strictEqual(governor.state().queue_depth, 2);

  advance(100);
  timers.fireOldest();
  await a;

  assert.strictEqual(governor.state().queue_depth, 1, "the dead waiter is not a backlog");
  void b;
});

// --- failure path: a caller that releases badly ---------------------------

test("release is idempotent - a double release cannot erode the cap", async function () {
  // CLAUDE.md's idempotency rule applied to a counter. Two releases for one
  // admission would drift in_flight below the true number of running
  // requests, and the bound would quietly stop bounding - under exactly the
  // error conditions (a retry, a doubled finally) where it matters most.
  const { governor } = governorForTest({ maxInFlight: 1, maxQueueDepth: 4 });

  const ticket = await governor.acquire();
  assert.strictEqual(ticket.release(), true, "the first release does the work");
  assert.strictEqual(ticket.release(), false, "the second is a no-op, and says so");
  assert.strictEqual(ticket.release(), false);

  assert.strictEqual(governor.state().in_flight, 0, "never negative");

  // The proof that the cap survived: one in, one queued. Had in_flight drifted
  // to -2, three requests would be admitted against a cap of one.
  await governor.acquire();
  governor.acquire();
  const state = governor.state();
  assert.strictEqual(state.in_flight, 1);
  assert.strictEqual(state.queue_depth, 1);
  assert.strictEqual(state.saturated, true);
});

test("peak in flight is retained after the load passes", async function () {
  // A snapshot taken after a spike has to still show the spike, or capacity
  // planning is done blind.
  const { governor } = governorForTest({ maxInFlight: 3, maxQueueDepth: 4 });

  const tickets = [await governor.acquire(), await governor.acquire(), await governor.acquire()];
  for (const ticket of tickets) {
    ticket.release();
  }

  const state = governor.state();
  assert.strictEqual(state.in_flight, 0);
  assert.strictEqual(state.peak_in_flight, 3);
  assert.strictEqual(state.admitted_total, 3);
});

// --- failure path: bad configuration -------------------------------------

test("an unusable limit refuses to construct rather than running unbounded", function () {
  // Degrading to "no limit" is the one outcome that must be impossible: it
  // looks fine right up to the collapse this module exists to prevent.
  assert.throws(function () {
    createLoadGovernor({ maxInFlight: 0 });
  }, LoadGovernorConfigError);

  assert.throws(function () {
    createLoadGovernor({ maxInFlight: 2.5 });
  }, LoadGovernorConfigError);

  assert.throws(function () {
    createLoadGovernor({ maxQueueDepth: -1 });
  }, LoadGovernorConfigError);
});

test("environment config is validated, and a typo stops the boot", function () {
  const saved = process.env.COLABERRY_MAX_INFLIGHT;
  try {
    process.env.COLABERRY_MAX_INFLIGHT = "lots";
    assert.throws(function () {
      loadGovernorConfigFromEnv();
    }, LoadGovernorConfigError);

    process.env.COLABERRY_MAX_INFLIGHT = "0";
    assert.throws(function () {
      loadGovernorConfigFromEnv();
    }, LoadGovernorConfigError);

    process.env.COLABERRY_MAX_INFLIGHT = "8";
    assert.strictEqual(loadGovernorConfigFromEnv().maxInFlight, 8);

    delete process.env.COLABERRY_MAX_INFLIGHT;
    assert.strictEqual(loadGovernorConfigFromEnv().maxInFlight, 64, "documented default");
  } finally {
    if (saved === undefined) {
      delete process.env.COLABERRY_MAX_INFLIGHT;
    } else {
      process.env.COLABERRY_MAX_INFLIGHT = saved;
    }
  }
});

test("the error message names the variable and the way out", function () {
  // An operator reading this at 3am should not have to open the source.
  const saved = process.env.COLABERRY_QUEUE_TIMEOUT_MS;
  try {
    process.env.COLABERRY_QUEUE_TIMEOUT_MS = "-5";
    assert.throws(
      function () {
        loadGovernorConfigFromEnv();
      },
      function (error) {
        assert.match(error.message, /COLABERRY_QUEUE_TIMEOUT_MS/);
        assert.match(error.message, /Unset it to use the default/);
        return true;
      }
    );
  } finally {
    if (saved === undefined) {
      delete process.env.COLABERRY_QUEUE_TIMEOUT_MS;
    } else {
      process.env.COLABERRY_QUEUE_TIMEOUT_MS = saved;
    }
  }
});
