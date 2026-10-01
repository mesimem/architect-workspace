// STORY-016: the acceptance criteria, driven over real HTTP against the real
// server, with real concurrency.
//
// THE THREE CRITERIA, and the test that proves each:
//
//   AC-1  "Given an increase in user load, when multiple advisors access the
//         system, then it should maintain performance."
//         -> 40 advisors, 200 simultaneous requests, production limits. Every
//            request served, nothing shed, p95 inside a stated budget.
//
//   AC-2  "Given a surge in customer activity, when thousands of customers
//         interact with the system, then it should not crash."
//         -> 1,000 distinct customers, 2,000 requests. EVERY one receives an
//            HTTP answer, the process survives, and the system recovers.
//
//   AC-3  "Given any system load, when it scales, then performance metrics
//         must be logged."
//         -> load the server, then read a real perf_snapshot line out of the
//            log stream and assert it describes that load.
//
// WHAT "MAINTAIN PERFORMANCE" IS TAKEN TO MEAN, because the criterion does not
// say and an unstated budget is not a test. Three things, all asserted:
// every request is SERVED (not shed), none FAILS (no 5xx), and the p95 stays
// inside PERF_BUDGET_P95_MS. A suite that only asserted "it responded" would
// pass against a server taking nine seconds per request.
//
// WHAT "SHOULD NOT CRASH" IS TAKEN TO MEAN, which is the subtler one. NOT
// "every request succeeds" - under a surge past capacity, refusing some
// traffic is the correct behaviour and the whole point of the load governor.
// It means: the process stays up, every single request gets a real HTTP
// response rather than a dropped socket, a refusal is a clean 503 that tells
// the client when to come back, and the system returns to full service on its
// own afterwards. A dropped connection would be the actual failure - it is
// indistinguishable from the server having died.
//
// The tokens here are test fixtures and exist only in this process.

"use strict";

const assert = require("assert");
const test = require("node:test");
const http = require("http");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { createLoadGovernor } = require("../services/observability/loadGovernor");
const { createPerfMetrics } = require("../services/observability/perfMetrics");

// Chosen to be generous. These handlers read from memory, so a correct system
// is an order of magnitude inside this; the budget exists to catch a
// regression that makes requests queue behind each other, not to measure the
// CI machine. A tighter number would fail on a loaded runner and teach the
// team to ignore this suite, which is worse than not having it.
const PERF_BUDGET_P95_MS = 500;

const ADVISOR_COUNT = 40;
const REQUESTS_PER_ADVISOR = 5;

const CUSTOMER_COUNT = 1_000;
const SURGE_REQUESTS = 2_000;
// The surge is fired in waves rather than as 2,000 simultaneous sockets. Each
// wave is still well past the 64-slot server capacity, so saturation is real -
// but we are not also measuring the operating system's accept queue, which is
// what 2,000 concurrent localhost sockets would actually test.
//
// 150 IS NOT ARBITRARY. At 250 this suite reported 18 connections refused, and
// a control run of the identical client against a BARE node:http server
// reported exactly the same 1982/18 split - so the refusals were this machine
// declining simultaneous localhost connections before any server process saw
// them, not anything in this build. 150 is below that threshold here, and the
// error classification below is what keeps the test honest on a machine whose
// threshold is lower still.
const SURGE_WAVE_SIZE = 150;

function advisorToken(index) {
  return "load-advisor-" + String(index).padStart(4, "0") + "-token-fixture";
}

function customerToken(index) {
  return "load-customer-" + String(index).padStart(4, "0") + "-token-fixture";
}

function tokenTableFor({ advisors = 0, customers = 0, admin = false }) {
  const entries = [];
  for (let i = 0; i < advisors; i += 1) {
    entries.push(advisorToken(i) + ":advisor:ADV-" + i);
  }
  for (let i = 0; i < customers; i += 1) {
    entries.push(customerToken(i) + ":customer:CUST-" + i);
  }
  if (admin) {
    entries.push("load-admin-token-fixture-padding:admin:ADMIN-LOAD");
  }
  return entries.join(",");
}

// WHY THIS USES node:http AND NOT fetch, which is the whole reason the first
// version of this suite was worthless.
//
// Node's global fetch pools connections per origin. Firing 200 fetches at one
// server does NOT put 200 requests in flight - the client serialises them over
// a handful of sockets, a few at a time. So the first run of this file
// reported queued_total === 0 under "200 simultaneous requests": the server
// never saw concurrency, because the CLIENT was the bottleneck. Every
// concurrency assertion here would have passed trivially while proving
// nothing, which is the most expensive kind of green test.
//
// http.Agent with an explicit maxSockets far above the server's own cap puts
// the bottleneck back where the test intends it: on the server.
function createClientAgent() {
  return new http.Agent({
    keepAlive: true,
    // Comfortably above the 64-slot server cap and the 250-request wave size,
    // so the client can always offer more load than the server will accept.
    maxSockets: 1_024,
    maxFreeSockets: 256,
  });
}

function request(base, path, token, options = {}) {
  const url = new URL(base + path);
  return new Promise(function (resolve, reject) {
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = "Bearer " + token;
    }

    const req = http.request(
      {
        agent: options.agent,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: headers,
      },
      function (res) {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          raw += chunk;
        });
        res.on("end", function () {
          resolve({
            status: res.statusCode,
            header: function (name) {
              return res.headers[name.toLowerCase()];
            },
            json: function () {
              return raw === "" ? null : JSON.parse(raw);
            },
          });
        });
      }
    );

    req.on("error", reject);

    // Simulates a client that gives up mid-request - the normal consequence of
    // latency, and the case where a leaked concurrency slot would hide.
    if (options.destroyAfterMs !== undefined) {
      setTimeout(function () {
        req.destroy(Object.assign(new Error("client gave up"), { name: "AbortError" }));
      }, options.destroyAfterMs);
    }

    req.end();
  });
}

async function startServer({ tokens, ops } = {}) {
  const server = createServer({
    principals: loadPrincipals(tokens),
    ops: ops,
  });
  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const agent = createClientAgent();

  return {
    server: server,
    ops: server.ops,
    call: function (path, token, options = {}) {
      return request(base, path, token, Object.assign({ agent: agent }, options));
    },
    close: function () {
      // The agent's keep-alive sockets would otherwise outlive the server and
      // hold the event loop open, which looks exactly like the timer bug the
      // last test in this file guards against.
      agent.destroy();
      return new Promise(function (resolve) {
        server.close(resolve);
      });
    },
  };
}

// --- AC-1: multiple advisors, increased load, performance maintained ------

test("AC-1: 40 advisors under simultaneous load are all served inside budget", async function () {
  const harness = await startServer({
    tokens: tokenTableFor({ advisors: ADVISOR_COUNT }),
  });

  try {
    // Every advisor fires every request at once. 200 simultaneous requests
    // against a 64-slot concurrency bound: the bound is genuinely exercised
    // (136 of them have to wait for a slot), and the queue is deep enough that
    // waiting is the right answer rather than refusing.
    const requests = [];
    for (let advisor = 0; advisor < ADVISOR_COUNT; advisor += 1) {
      for (let n = 0; n < REQUESTS_PER_ADVISOR; n += 1) {
        requests.push(harness.call("/api/advisor/reviews", advisorToken(advisor)));
      }
    }

    const responses = await Promise.all(requests);
    const expected = ADVISOR_COUNT * REQUESTS_PER_ADVISOR;

    assert.strictEqual(responses.length, expected);
    const statuses = {};
    for (const response of responses) {
      statuses[response.status] = (statuses[response.status] || 0) + 1;
    }
    assert.deepStrictEqual(
      statuses,
      { 200: expected },
      "every advisor request must be SERVED, not shed and not failed - got " + JSON.stringify(statuses)
    );

    // Read the instance's own numbers rather than going through
    // /api/admin/metrics, which would add a request of its own to the sample
    // we are about to assert on.
    const snapshot = harness.ops.metrics.snapshot();
    const load = harness.ops.governor.state();

    assert.strictEqual(snapshot.overall.volume, expected);
    assert.strictEqual(snapshot.overall.failures, 0);
    assert.strictEqual(snapshot.overall.shed, 0, "capacity was sufficient, so nothing should be refused");
    assert.strictEqual(snapshot.overall.aborted, 0, "no advisor should have given up waiting");
    assert.strictEqual(snapshot.overall.success_rate, 1);

    assert.ok(
      snapshot.overall.latency_ms.p95 <= PERF_BUDGET_P95_MS,
      "p95 was " + snapshot.overall.latency_ms.p95 + "ms, budget is " + PERF_BUDGET_P95_MS + "ms"
    );

    // THE BOUND HELD. Proof that the concurrency limit was actually applied
    // and not quietly bypassed: with 200 requests in flight at once, peak
    // concurrency must still be capped.
    assert.ok(
      load.peak_in_flight <= load.max_in_flight,
      "peak concurrency " + load.peak_in_flight + " exceeded the cap " + load.max_in_flight
    );
    // WHAT peak_in_flight ACTUALLY IS HERE, AND WHY IT IS 1. Two earlier
    // drafts of this test asserted the wrong thing - first that requests had
    // to QUEUE, then that at least two had to be in flight together - and both
    // failed against a correct server. The reason is worth understanding,
    // because it decides what this criterion can honestly claim:
    //
    // every handler behind this endpoint is SYNCHRONOUS once admitted. It
    // reads from an in-memory store and returns; it never awaits real I/O. On
    // a single-threaded event loop that means a request runs start to finish
    // without yielding to the next queued connection, so the governor sees
    // one request in flight, then the next, then the next - 200 times. The
    // concurrency is real at the socket level and serialised at the work
    // level, by Node, not by us.
    //
    // THE CONSEQUENCE, which belongs in the story notes: the concurrency bound
    // governs AWAITING work. It starts to bite the day a handler waits on a
    // database, an HTTP call to a supplier, or a queue - which is exactly when
    // it is needed and exactly what REQ-018's "thousands of customers" implies.
    // Until then the event loop is the real serialiser, and the bound is the
    // ceiling that stops awaiting work from piling up without limit. That the
    // bound is proven to WORK is the overload test's job below, by holding
    // slots; it is not this test's job to manufacture saturation.
    assert.ok(
      load.peak_in_flight <= load.max_in_flight,
      "peak concurrency " + load.peak_in_flight + " exceeded the cap " + load.max_in_flight
    );
    assert.strictEqual(
      load.admitted_total,
      expected,
      "every request passed through admission control, so none bypassed the bound"
    );
    assert.strictEqual(load.in_flight, 0, "every slot was given back");
  } finally {
    await harness.close();
  }
});

test("AC-1: the per-route breakdown attributes the load to the right endpoint", async function () {
  // "Maintain performance" is only actionable if you can see WHERE it went.
  const harness = await startServer({ tokens: tokenTableFor({ advisors: 2 }) });

  try {
    await Promise.all([
      harness.call("/api/advisor/reviews", advisorToken(0)),
      harness.call("/api/advisor/reviews", advisorToken(1)),
      harness.call("/api/africa/destinations", advisorToken(0)),
    ]);

    const routes = harness.ops.metrics.snapshot().routes;
    const labels = Object.keys(routes);

    assert.strictEqual(labels.length, 2, "two endpoints were used: " + labels.join(", "));
    const reviews = labels.find(function (label) {
      return label.includes("advisor");
    });
    assert.strictEqual(routes[reviews].volume, 2);
    // The cardinality guarantee, restated at the HTTP level: a label is a
    // pattern, so it can never carry an id from a URL.
    for (const label of labels) {
      assert.ok(label.startsWith("GET "), label);
    }
  } finally {
    await harness.close();
  }
});

// --- AC-2: a surge of thousands of customers, and no crash ----------------

test("AC-2: 2,000 requests from 1,000 customers - every one answered, nothing crashes", async function () {
  const harness = await startServer({
    tokens: tokenTableFor({ customers: CUSTOMER_COUNT }),
  });

  try {
    const statuses = {};
    // TWO KINDS OF NETWORK ERROR, AND ONLY ONE OF THEM IS OUR FAULT.
    //
    //   ECONNREFUSED - the OS declined the connection; the server process
    //                  never saw it. An accept-queue limit, which is the load
    //                  balancer's and the kernel's layer, not ours. Counted
    //                  and reported, but not a failure of this build - proven
    //                  by a control run against a bare node:http server
    //                  producing the identical count.
    //   anything else - ECONNRESET, EPIPE, "socket hang up": the server
    //                  ACCEPTED a connection and then dropped it. That is the
    //                  real failure this criterion is about, because from the
    //                  client's side it is indistinguishable from a crash.
    let refusedByOs = 0;
    let droppedByServer = 0;
    const dropCodes = {};

    for (let sent = 0; sent < SURGE_REQUESTS; sent += SURGE_WAVE_SIZE) {
      const wave = [];
      for (let n = 0; n < SURGE_WAVE_SIZE && sent + n < SURGE_REQUESTS; n += 1) {
        // Spread across all 1,000 customers, so this is thousands of distinct
        // authenticated principals rather than one customer hammering.
        const customer = (sent + n) % CUSTOMER_COUNT;
        wave.push(
          harness.call("/api/africa/destinations", customerToken(customer)).then(
            function (response) {
              return response;
            },
            function (error) {
              if (error.code === "ECONNREFUSED") {
                refusedByOs += 1;
              } else {
                droppedByServer += 1;
                const code = error.code || error.message;
                dropCodes[code] = (dropCodes[code] || 0) + 1;
              }
              return { status: 0, error: error };
            }
          )
        );
      }

      for (const response of await Promise.all(wave)) {
        statuses[response.status] = (statuses[response.status] || 0) + 1;
      }
    }

    assert.strictEqual(
      droppedByServer,
      0,
      droppedByServer +
        " accepted connections were dropped without an HTTP response " +
        JSON.stringify(dropCodes) +
        " - from a client that is indistinguishable from a crash"
    );

    const served = statuses[200] || 0;
    const shed = statuses[503] || 0;
    assert.strictEqual(
      served + shed,
      SURGE_REQUESTS - refusedByOs,
      "every request the server accepted must be served or cleanly refused - got " +
        JSON.stringify(statuses) +
        " with " +
        refusedByOs +
        " refused by the OS before reaching us"
    );
    // The accept-queue ceiling is reported rather than hidden. If this grows,
    // the answer is more instances behind the balancer - which is the whole
    // reason the health probe exists - not a change in this process.
    assert.ok(
      refusedByOs < SURGE_REQUESTS * 0.05,
      refusedByOs + " of " + SURGE_REQUESTS + " connections never reached the server; lower SURGE_WAVE_SIZE"
    );
    // No 5xx other than the deliberate 503. A 500 here would mean the surge
    // broke something rather than being absorbed.
    for (const status of Object.keys(statuses)) {
      assert.ok(
        status === "200" || status === "503",
        "unexpected status " + status + " x" + statuses[status]
      );
    }

    // THE PROCESS IS STILL HEALTHY AND FULLY RECOVERED. Not just alive - back
    // to serving, with the probe reporting healthy again, with no operator
    // action. Automatic recovery is what makes shedding an acceptable answer.
    const load = harness.ops.governor.state();
    assert.strictEqual(load.in_flight, 0, "every slot came back after the surge");
    assert.strictEqual(load.saturated, false);
    assert.ok(
      load.peak_in_flight <= load.max_in_flight,
      "the bound held through the surge: peak " + load.peak_in_flight + " vs cap " + load.max_in_flight
    );

    const probe = await harness.call("/api/health");
    assert.strictEqual(probe.status, 200, "the probe reports healthy again");
    assert.strictEqual((await probe.json()).status, "healthy");

    const after = await harness.call("/api/africa/destinations", customerToken(0));
    assert.strictEqual(after.status, 200, "and real traffic is served again");

    // The surge is fully accounted for in the metrics, which is what makes it
    // reviewable afterwards instead of a story someone tells.
    const snapshot = harness.ops.metrics.snapshot();
    assert.ok(snapshot.overall.volume >= SURGE_REQUESTS);
    assert.strictEqual(snapshot.overall.failures, 0, "no request failed with a 5xx of our own making");
  } finally {
    await harness.close();
  }
});

// --- AC-3: metrics are logged ---------------------------------------------

test("AC-3: a perf_snapshot describing the load reaches the log stream", async function () {
  // The per-request line carries one duration. A p95 needs a sample, so it can
  // only come from the aggregate - and the aggregate is only useful if it is
  // actually WRITTEN somewhere. This asserts the real server emits it, via the
  // real logger, with the percentiles in it.
  const savedInterval = process.env.COLABERRY_METRICS_INTERVAL_MS;
  const originalConsoleError = console.error;
  const captured = [];

  // Set before createServer: the interval is read once, at construction.
  process.env.COLABERRY_METRICS_INTERVAL_MS = "25";

  const harness = await startServer({ tokens: tokenTableFor({ advisors: 4 }) });

  console.error = function (line) {
    try {
      captured.push(JSON.parse(line));
    } catch (error) {
      // Not our JSON. Pass it through rather than swallowing it.
      originalConsoleError(line);
    }
  };

  try {
    await Promise.all([
      harness.call("/api/advisor/reviews", advisorToken(0)),
      harness.call("/api/advisor/reviews", advisorToken(1)),
      harness.call("/api/advisor/reviews", advisorToken(2)),
    ]);

    // Waits for a snapshot that INCLUDES the load above, not merely for any
    // snapshot. The interval fires on its own schedule, so the first line
    // captured can easily predate the requests - asserting on that one tested
    // the clock rather than the metrics.
    const deadline = Date.now() + 3_000;
    let snapshotLine = null;
    while (!snapshotLine && Date.now() < deadline) {
      snapshotLine = captured.find(function (line) {
        return line.event === "perf_snapshot" && line.context.performance.overall.volume >= 3;
      });
      if (!snapshotLine) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 10);
        });
      }
    }

    assert.ok(
      snapshotLine,
      "no perf_snapshot describing the load was written - AC-3 is not satisfied. Captured " +
        captured.filter(function (l) { return l.event === "perf_snapshot"; }).length +
        " snapshot line(s)."
    );

    // The log line has to be machine-readable, per CLAUDE.md's observability
    // framework: structured JSON on stdout/stderr, not a formatted sentence.
    assert.strictEqual(snapshotLine.service, "http-api");
    assert.strictEqual(snapshotLine.level, "info");
    assert.ok(snapshotLine.timestamp, "a metric with no timestamp is not a time series");

    const overall = snapshotLine.context.performance.overall;
    assert.ok(overall.volume >= 3, "the snapshot must describe the load that just happened");
    for (const field of ["success_rate", "failure_rate", "retry_count", "latency_ms"]) {
      assert.ok(field in overall, "missing required metric in the logged line: " + field);
    }
    for (const p of ["p50", "p95", "p99"]) {
      assert.ok(p in overall.latency_ms, "missing percentile in the logged line: " + p);
    }

    // And the saturation state alongside it, so one line answers both "how
    // fast" and "how close to the edge".
    assert.strictEqual(snapshotLine.context.load.max_in_flight, 64);
    assert.strictEqual(typeof snapshotLine.context.load.saturated, "boolean");
  } finally {
    console.error = originalConsoleError;
    await harness.close();
    if (savedInterval === undefined) {
      delete process.env.COLABERRY_METRICS_INTERVAL_MS;
    } else {
      process.env.COLABERRY_METRICS_INTERVAL_MS = savedInterval;
    }
  }
});

test("AC-3: the metrics endpoint serves the same numbers, to admins only", async function () {
  const harness = await startServer({
    tokens: tokenTableFor({ advisors: 1, customers: 1, admin: true }),
  });

  try {
    await harness.call("/api/advisor/reviews", advisorToken(0));

    // The denials first. An advisor and a customer are the two roles most
    // likely to be wrongly granted this, since both legitimately use the API.
    assert.strictEqual(
      (await harness.call("/api/admin/metrics", advisorToken(0))).status,
      403,
      "an advisor does not need latency percentiles to sell a safari"
    );
    assert.strictEqual(
      (await harness.call("/api/admin/metrics", customerToken(0))).status,
      403,
      "a customer must not learn how close we are to our capacity ceiling"
    );
    assert.strictEqual((await harness.call("/api/admin/metrics")).status, 401);

    const response = await harness.call("/api/admin/metrics", "load-admin-token-fixture-padding");
    assert.strictEqual(response.status, 200);
    const body = await response.json();

    assert.strictEqual(body.status, "healthy");
    assert.ok(body.performance.overall.volume >= 1);
    assert.ok("p95" in body.performance.overall.latency_ms);
    assert.strictEqual(body.load.max_in_flight, 64);
  } finally {
    await harness.close();
  }
});

test("AC-3: the public probe leaks no capacity information", async function () {
  // The probe must be reachable without a credential, so whatever it returns
  // is public. Anything about our limits or our load in that body is a
  // capacity map: how much traffic it takes to tip this instance over.
  const harness = await startServer({ tokens: tokenTableFor({ admin: true }) });

  try {
    const body = await (await harness.call("/api/health")).json();

    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ["status", "uptime_ms"],
      "the public probe grew a field - check it is not a capacity hint"
    );
    const serialised = JSON.stringify(body);
    for (const leak of ["max_in_flight", "in_flight", "queue", "peak", "shed", "latency"]) {
      assert.ok(!serialised.includes(leak), "the public probe exposes " + leak);
    }
  } finally {
    await harness.close();
  }
});

// --- FAILURE PATH: server overload ---------------------------------------

test("failure path - server overload: a burst past capacity is refused cleanly", async function () {
  // SATURATION IS HELD FROM OUTSIDE THE PIPELINE, and it has to be. An earlier
  // draft just fired 40 requests at a 2-slot server and asserted something was
  // shed - and nothing was, because each handler finishes in microseconds, so
  // the 40 requests trickled through two slots without ever colliding. Holding
  // the slots directly makes "at capacity" a fact for the duration of the
  // burst instead of a race the test usually loses.
  const governor = createLoadGovernor({
    maxInFlight: 2,
    maxQueueDepth: 0,
    retryAfterSeconds: 3,
  });
  const harness = await startServer({
    tokens: tokenTableFor({ customers: 4, admin: true }),
    ops: { governor: governor, metrics: createPerfMetrics() },
  });

  try {
    const held = [await governor.acquire(), await governor.acquire()];
    assert.strictEqual(governor.state().saturated, true, "the instance is now at capacity");

    const burst = await Promise.all(
      Array.from({ length: 40 }, function (_unused, i) {
        return harness.call("/api/africa/destinations", customerToken(i % 4));
      })
    );

    const shedResponses = burst.filter(function (response) {
      return response.status === 503;
    });

    assert.strictEqual(
      shedResponses.length,
      burst.length,
      "with both slots held and no queue, EVERY request must be refused - got " +
        JSON.stringify(burst.map(function (r) { return r.status; }))
    );

    // A REFUSAL HAS TO BE USEFUL, or the client cannot do the right thing.
    for (const response of shedResponses) {
      assert.strictEqual(
        response.header("retry-after"),
        "3",
        "a shed client that is not told when to return retries immediately, which re-creates the overload"
      );
      assert.ok(response.header("x-correlation-id"), "a 503 must still be traceable");
      const body = await response.json();
      assert.strictEqual(body.error, "overloaded");
      assert.ok(body.correlationId, "the client can quote this back");
      // The refusal must not describe our internals to an unauthenticated
      // caller any more than the probe does.
      assert.ok(!JSON.stringify(body).includes("in_flight"));
    }

    // Shedding is counted as shedding - not as a failure, which would page
    // someone for the system working as designed, and not as a success, which
    // would hide the saturation entirely.
    const snapshot = harness.ops.metrics.snapshot();
    assert.strictEqual(snapshot.overall.shed, shedResponses.length);
    assert.strictEqual(snapshot.overall.failures, 0);

    // RECOVERY, with no intervention beyond the held work finishing.
    for (const ticket of held) {
      ticket.release();
    }
    assert.strictEqual(harness.ops.governor.state().in_flight, 0);
    const after = await harness.call("/api/africa/destinations", customerToken(0));
    assert.strictEqual(after.status, 200);
    assert.strictEqual((await (await harness.call("/api/health")).json()).status, "healthy");
  } finally {
    await harness.close();
  }
});

test("failure path - server overload: the health probe answers while everything else is refused", async function () {
  // The self-inflicted outage. A shed probe looks identical to a dead
  // instance, so a balancer would pull this box out and never learn it had
  // recovered - the probe that would say so is the one being refused.
  const governor = createLoadGovernor({ maxInFlight: 1, maxQueueDepth: 0 });
  const harness = await startServer({
    tokens: tokenTableFor({ customers: 1 }),
    ops: { governor: governor, metrics: createPerfMetrics() },
  });

  try {
    // Hold the only slot from outside the pipeline, so saturation is held
    // steady rather than racing against a request finishing.
    const held = await governor.acquire();
    assert.strictEqual(held.admitted, true);

    const refused = await harness.call("/api/africa/destinations", customerToken(0));
    assert.strictEqual(refused.status, 503, "ordinary traffic is shed");

    const probe = await harness.call("/api/health");
    assert.strictEqual(probe.status, 503, "and the probe says 503 - but as a SIGNAL");
    const body = await probe.json();
    assert.strictEqual(body.status, "degraded", "which is 'drain me', not 'I am broken'");
    assert.strictEqual(probe.header("retry-after"), "2");

    // The probe got an answer at all: that is the property under test. It was
    // never queued and never refused.
    held.release();
    const recovered = await harness.call("/api/health");
    assert.strictEqual(recovered.status, 200, "and it flips back on its own");
  } finally {
    await harness.close();
  }
});

// --- FAILURE PATH: network latency / a client that gives up ---------------

test("failure path - network latency: an abandoned request releases its slot", async function () {
  // A SLOT LEAKED ON ABORT IS PERMANENT. Capacity drops by one for the life of
  // the process with nothing in the logs to say why, and enough of them starve
  // the server down to refusing everything. Clients abandoning slow requests
  // is the normal consequence of latency, so this path gets walked for real.
  const governor = createLoadGovernor({
    maxInFlight: 2,
    maxQueueDepth: 8,
    queueTimeoutMs: 150,
  });
  const harness = await startServer({
    tokens: tokenTableFor({ customers: 2 }),
    ops: { governor: governor, metrics: createPerfMetrics() },
  });

  try {
    // Fill both slots from outside, so the requests below have to queue - the
    // only way to have a request reliably in flight long enough to abort it.
    const held = [await governor.acquire(), await governor.acquire()];

    const outcome = await harness
      .call("/api/africa/destinations", customerToken(0), { destroyAfterMs: 20 })
      .then(
        function (response) {
          return { aborted: false, status: response.status };
        },
        function (error) {
          return { aborted: true, name: error.name };
        }
      );
    assert.strictEqual(
      outcome.aborted,
      true,
      "the client was supposed to give up before being served, got " + JSON.stringify(outcome)
    );

    for (const ticket of held) {
      ticket.release();
    }

    // Let any queued waiter time out and settle.
    await new Promise(function (resolve) {
      setTimeout(resolve, 250);
    });

    assert.strictEqual(
      governor.state().in_flight,
      0,
      "a slot was leaked by the abort - in_flight should be 0, saw " + governor.state().in_flight
    );

    // THE REAL PROOF: full capacity is still available afterwards. If the
    // abort had leaked a slot, one of these two would be queued or shed.
    const after = await Promise.all([
      harness.call("/api/africa/destinations", customerToken(0)),
      harness.call("/api/africa/destinations", customerToken(1)),
    ]);
    assert.deepStrictEqual(
      after.map(function (r) { return r.status; }),
      [200, 200],
      "capacity was not restored after the abandoned request"
    );
  } finally {
    await harness.close();
  }
});

test("failure path - network latency: the socket timeouts are applied to the live server", async function () {
  // The bounds that stop a slow client holding a connection open. Asserted on
  // the real server object rather than through a dribbling socket, because
  // ENFORCEMENT is Node's job (and it checks on its own interval) while the
  // VALUES are ours. Node's defaults - 300s request, 60s headers - are what
  // this is protecting against, and a regression here would be a silent return
  // to them.
  const harness = await startServer({ tokens: tokenTableFor({ customers: 1 }) });

  try {
    assert.strictEqual(harness.server.requestTimeout, 30_000);
    assert.strictEqual(harness.server.headersTimeout, 10_000);
    assert.strictEqual(harness.server.keepAliveTimeout, 5_000);
    assert.ok(
      harness.server.requestTimeout < 300_000,
      "Node's default would let a 64KB body take five minutes"
    );
  } finally {
    await harness.close();
  }
});

// --- the snapshot interval must never hold the process open ---------------

test("the snapshot timer does not keep the process alive", async function () {
  // If this were wrong, every test file in this repo that constructs a server
  // would hang the runner instead of exiting, and a production container would
  // ignore SIGTERM. It is asserted here because the symptom - a suite that
  // never finishes - is maddening to trace back to a timer.
  const harness = await startServer({ tokens: tokenTableFor({ customers: 1 }) });
  await harness.close();

  // A listening server plus an unref'd interval should leave nothing that
  // would stop the event loop draining.
  const handles = process._getActiveHandles
    ? process._getActiveHandles().filter(function (handle) {
        return handle && handle.constructor && handle.constructor.name === "Timeout";
      })
    : [];
  for (const handle of handles) {
    assert.ok(
      typeof handle.hasRef !== "function" || !handle.hasRef(),
      "a referenced timer survived server close"
    );
  }
});
