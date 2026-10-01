# Scalability

How this platform serves multiple advisors and thousands of customers, what its
measured limits are, and where the next one is.

Satisfies **REQ-018** (non-functional, must) via **STORY-016**.

---

## The short version

One instance bounds the work it will accept, reports honestly when it is full,
and publishes its own performance numbers. A load balancer in front reads that
report and moves traffic. Nothing in the application tries to be a load
balancer.

| Concern | Mechanism | Where |
|---|---|---|
| Too much work at once | Bounded concurrency with a bounded wait queue; refuse past that | `services/observability/loadGovernor.js` |
| Knowing whether we are coping | Rolling latency percentiles, success/failure/shed/abort rates | `services/observability/perfMetrics.js` |
| Telling the balancer | `GET /api/health` → 200 healthy, 503 drain me | `http/routes/healthRoutes.js` |
| Telling an operator | `GET /api/admin/metrics`, `ops.metrics.read` only | `http/routes/healthRoutes.js` |
| Slow clients | Tightened `requestTimeout` / `headersTimeout` / `keepAliveTimeout` | `http/opsPipeline.js` |
| Writing it down | `perf_snapshot` JSON line on an interval | `http/opsPipeline.js` |

---

## The load-balancer contract

This is the whole of what the application promises an upstream balancer, and it
is deliberately small.

**Probe `GET /api/health`.** No credential required — a balancer, a container
healthcheck and an uptime monitor all poll before any of them could hold a
token.

- **`200`** with `{"status":"healthy"}` — send traffic.
- **`503`** with `{"status":"degraded"}` and a `Retry-After` — this instance is
  at its concurrency limit. Drain it; its peers can take the load.

A `503` here means *full*, not *broken*. The instance is still serving, it
answers the probe immediately, and it returns to `200` on its own as work
drains. A balancer that pulls it out will put it back without anyone
intervening.

Three properties make this work, and each one is load-bearing:

1. **The probe is exempt from load shedding.** If the probe were refused along
   with everything else, a balancer could not distinguish "at capacity" from
   "dead" — and those call for opposite responses. Worse, the instance would
   never be returned to service, because the probe that would report its
   recovery is the one being refused. That is a self-inflicted outage. The
   exemption is safe because the handler reads two counters and cannot queue,
   block, or touch the disk; a startup assertion enforces that only a **public
   GET** may ever claim it.
2. **The probe body carries no capacity information.** Only `status` and
   `uptime_ms`. Limits, queue depth and peak load would amount to a published
   capacity map — exactly how much traffic it takes to tip the instance over.
   Those numbers live behind `ops.metrics.read`.
3. **Reporting `503` costs this instance traffic, and it reports it anyway.**
   An instance that always claims to be healthy makes balancing impossible.

**Deployment notes.** Keep `keepAliveTimeout` (5s) *below* the balancer's idle
timeout, or the balancer will reuse a connection this process has just closed
and report a 502 that is really a race. Each instance reports only its own
numbers; summing across the fleet is the log aggregator's job, which is what
keeps the figures correct behind a balancer rather than double-counted.

---

## Configuration

All from the environment, per 12-factor. An **unusable concurrency value
refuses to boot** rather than degrading to unbounded — "no limit" looks fine
right up until the collapse these limits exist to prevent.

| Variable | Default | Meaning |
|---|---|---|
| `COLABERRY_MAX_INFLIGHT` | `64` | Requests executing at once |
| `COLABERRY_MAX_QUEUE_DEPTH` | `256` | How many may wait for a slot (`0` = refuse immediately when full) |
| `COLABERRY_QUEUE_TIMEOUT_MS` | `2000` | How long a request may wait before we give up on its behalf |
| `COLABERRY_RETRY_AFTER_SECONDS` | `2` | What a shed client is told |
| `COLABERRY_METRICS_INTERVAL_MS` | `60000` | `perf_snapshot` cadence (`0` disables) |

The metrics interval is the one exception: a bad value falls back to the default
instead of throwing. Taking the system down to protect the cadence of its own
dashboard would be the wrong trade.

---

## Why refusing work is the correct behaviour

Accepting everything is not generosity, it is the failure mode:

> every request is admitted, so each gets a slice of an oversubscribed CPU, so
> every request gets slower, so clients time out and **retry**, which adds
> load, which makes it slower still — until the process thrashes or is
> OOM-killed.

At the point of collapse the success rate is near zero, when it could have been
high for the subset the box could actually serve. A shed request is a bad
second; a collapse is a bad hour. `Retry-After` on every refusal is what stops
the retries arriving together and re-creating the overload.

`abort_rate` is the metric to alert on. A client that gave up is counted as
neither a success nor a server failure, and a rising abort rate is the leading
indicator of the loop above.

---

## Measured limits

### 1. The store is the real ceiling

`services/shared/jsonFileStore.js` rewrites the **entire file on every write**.
Measured on a CRM lead row (~210 bytes serialised), inserting one row at a time:

| rows | final file | per write | write amplification | total bytes written |
|---|---|---|---|---|
| 100 | 20.4 KB | 1.21 ms | 50.4× | 1.00 MB |
| 500 | 103.2 KB | 1.50 ms | 249.9× | 25.18 MB |
| 1,000 | 206.7 KB | 2.12 ms | 499.8× | 100.89 MB |

Amplification tracks **N/2** exactly — the whole-file-rewrite signature.

**Documented ceiling: 10,000 rows per store.** There, each write rewrites
~2.1 MB and spends roughly 15–20 ms in *synchronous* disk I/O, which blocks the
event loop and therefore every other request in the process. Filling to that
ceiling one row at a time writes ~10 GB.

This is a **review trigger, not an enforced limit** — silently refusing a write
would be a worse failure than a slow one. Crossing it means moving that store
to Postgres, which is a database-engine change and a governance decision under
`CLAUDE.md`, not something a story does on the way past. The number is asserted
in `jsonFileStore.scalability.test.js` so it cannot quietly go stale, and it is
measured in **bytes rather than milliseconds** so the curve is reproducible on
any machine instead of being a coin flip on a loaded CI box.

Until then the governor is the containment: it caps how many requests can be
awaiting work at once, so the store is never hit by unbounded concurrency.

### 2. The concurrency bound governs *awaiting* work

Worth understanding before reading the metrics, because it is surprising:
`peak_in_flight` is currently **1** under 200 simultaneous requests, and that is
correct.

Every handler today is synchronous once admitted — it reads an in-memory store
and returns, never awaiting real I/O. On a single-threaded event loop a request
therefore runs start to finish without yielding to the next queued connection.
The concurrency is real at the socket level and serialised at the work level
**by Node, not by us**.

The consequence: the bound starts to bite the day a handler waits on a
database, a supplier API, or a queue — which is exactly when it is needed, and
exactly what "thousands of customers" implies. Until then the event loop is the
real serialiser and the bound is the ceiling that stops awaited work piling up
without limit.

### 3. The accept queue is upstream of everything

Firing 250 simultaneous connections at a local instance produced 18
`ECONNREFUSED` out of 2,000 — and an identical control run against a **bare**
`node:http` server produced the same 1982/18 split. Those connections are
refused by the OS accept queue before any server process sees them. It is a
kernel and balancer concern, not an application one, and the answer is more
instances behind the balancer rather than a change in this process.

The test suite distinguishes the two cases deliberately: `ECONNREFUSED` is
tolerated and reported, while a dropped *accepted* connection
(`ECONNRESET`, socket hang up) fails the build — from a client's side that is
indistinguishable from a crash.

---

## What is not handled

Stated so nobody assumes otherwise:

- **Per-caller fairness.** One noisy client can occupy the slots. The fix is
  per-IP rate limiting at nginx, which the HTTP layer already records as not its
  job.
- **CPU-bound handlers.** The bound is on concurrency, not on work. A handler
  that blocks the event loop for a second stops everything regardless, and no
  admission policy can help.
- **Cross-process aggregation.** Each instance reports its own numbers.
- **Readiness versus liveness as separate probes.** Matters for rolling
  deploys; not what REQ-018 asks for.
- **Multi-process / multi-node sharing of a data directory.** The store has no
  file locking, so two processes sharing `COLABERRY_DATA_DIR` can lose a write.
  Horizontal scale therefore waits on the same database move as the ceiling
  above.
