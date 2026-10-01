// STORY-016: the two endpoints that make this instance operable under load.
//
//   GET /api/health          public. What a load balancer polls.
//   GET /api/admin/metrics   staff. The full performance picture.
//
// WHY THERE ARE TWO OF THEM, AND WHY THEY RETURN DIFFERENT AMOUNTS. The
// obvious build is one endpoint that returns everything and let the probe read
// the bits it cares about. That would make /api/health - the one route here
// that MUST be reachable without a credential, because a balancer has none -
// publish our concurrency limits, our peak load and our saturation history to
// anyone on the internet. That is a capacity map: it tells someone exactly how
// much traffic it takes to tip this instance over, which is the single most
// useful fact for anyone who wants to.
//
// So the public probe answers the only question a balancer actually asks -
// "should I send you traffic?" - in a status code, with almost nothing in the
// body. The numbers live behind OPS_METRICS_READ.
//
// THE PROBE'S STATUS CODE IS THE LOAD-BALANCING MECHANISM. This is the whole
// of how balancing works from the application's side:
//
//   200  healthy. Send traffic.
//   503  saturated. Drain me; my peers can take this.
//
// nginx, a cloud load balancer and Docker's own healthcheck all read exactly
// that, which is why the signal is a status code rather than a field someone
// has to configure a JSON path for. And reporting 503 honestly COSTS this
// instance traffic, which is the point - an instance that always claims to be
// healthy makes balancing impossible, because the balancer has no way to tell
// a box at its limit from one sitting idle.
//
// WHY `degraded` IS NOT `dead`. A saturated instance is still serving: it is
// at its concurrency limit, not broken. It answers the probe immediately (see
// alwaysAdmit below), and it flips back to 200 on its own as work drains. No
// operator action, no restart. A balancer that pulls it out will put it back.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? The probe cannot meaningfully fail - it
//     reads two in-memory counters and does no I/O, which is deliberate. A
//     health check that touches the database reports the database's health, not
//     the instance's, and takes the whole fleet out of service together the
//     moment the database hiccups. If the process is alive enough to run this
//     handler, the answer is honest.
//  2. Will it retry? No. The balancer polls on its own schedule; retrying
//     inside a probe would hide exactly the latency it exists to detect.
//  3. Recovery path? Automatic, as above. There is nothing to recover.
//  4. Handled: saturation, a probe arriving while the instance is shedding
//     everything else, an absent ops context. NOT handled: dependency health
//     (see 1 - on purpose), and readiness-vs-liveness as separate probes, which
//     matters for rolling deploys and is not what REQ-018 asks for.

"use strict";

const { PERMISSIONS } = require("../../services/authz/permissions");

const STATUS_HEALTHY = "healthy";
const STATUS_DEGRADED = "degraded";

const healthRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    // PUBLIC, and it has to be. A load balancer, a container runtime's
    // healthcheck and an uptime monitor all poll this before any of them could
    // hold a credential, and issuing one to infrastructure would mean a token
    // in a config file somewhere for a route that returns two fields.
    //
    // What makes that safe is the response: a status word and an uptime. No
    // limits, no counters, no capacity map. See the header.
    public: true,
    // EXEMPT FROM LOAD SHEDDING. The probe must answer while the instance is
    // refusing everything else, or the balancer cannot tell "at capacity" from
    // "dead" - and those call for opposite responses. Being shed looks like
    // being down, so a balancer would pull a recoverable instance out and leave
    // it out, since the probe that would report its recovery is the one being
    // refused. That is a self-inflicted outage.
    //
    // Safe to exempt because the handler is two counter reads and allocates a
    // two-field object. It is not a hole in the bound: nothing here can queue,
    // block or touch the disk.
    alwaysAdmit: true,
    // AND KEPT OUT OF THE AGGREGATE. Its 503 means "drain me", not "I broke",
    // and infrastructure polling is not user traffic - counting either one
    // would make the performance numbers lie in opposite directions. The full
    // reasoning is on `observe` in opsPipeline.js.
    excludeFromMetrics: true,
    handler: async function (context) {
      const state = context.ops.governor.state();
      const saturated = state.saturated;

      return {
        status: saturated ? 503 : 200,
        body: {
          status: saturated ? STATUS_DEGRADED : STATUS_HEALTHY,
          // Enough for an operator to spot a crash-looping container, and
          // nothing a stranger can plan around.
          uptime_ms: context.ops.metrics.snapshot().uptime_ms,
        },
        headers: saturated
          ? {
              // Tells a polite client when to come back. The balancer ignores
              // it and uses its own interval; a retrying script should not.
              "Retry-After": String(state.queue_timeout_ms / 1000),
            }
          : undefined,
      };
    },
  },

  {
    method: "GET",
    pattern: /^\/api\/admin\/metrics$/,
    // The numbers the public probe deliberately withholds. Staff only.
    permission: PERMISSIONS.OPS_METRICS_READ,
    handler: async function (context) {
      const snapshot = context.ops.metrics.snapshot();
      const load = context.ops.governor.state();

      return {
        status: 200,
        body: {
          // Repeated from the probe so one request answers both "is it well?"
          // and "why?". An operator paging through at 3am should not have to
          // correlate two endpoints to find out the box is simply full.
          status: load.saturated ? STATUS_DEGRADED : STATUS_HEALTHY,
          load: load,
          performance: snapshot,
        },
      };
    },
  },
];

module.exports = { healthRoutes, STATUS_HEALTHY, STATUS_DEGRADED };
