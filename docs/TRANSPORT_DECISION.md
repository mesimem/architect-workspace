# Transport Decision Record — MCP Server

**Date:** 2026-09-02
**Status:** Accepted
**Decided by:** Paul Sane (paulsane@yahoo.com)

This record captures a transport and state-model decision for the project's MCP
server, the answers it was based on, and the one condition that reopens it. The
answers below are the decider's own, collected as a structured questionnaire;
where a phrase reads like a menu option, that is because it was one. Anything
here can be replaced with the decider's exact wording.

---

## 1. The answers this rests on

| # | Question | Answer |
|---|---|---|
| 1 | Who calls this server, and from where? | Team members, each running their own copy on their own machine. No shared instance. |
| 2 | How many callers at once, realistically? | One client per instance, but that client may have several requests in flight at once. |
| 3 | More than one machine, now or within a year? | Not now, but a shared host is considered likely within twelve months. |
| 4 | Does anything have to survive between requests? | Yes, but only within one session. In-memory is acceptable; a restart may lose it. |
| 5 | Worst case if unavailable for an hour? | **Revised.** Initially given as "money or data is lost", then withdrawn as too strong. Settled answer: an annoyance that gets worked around. |

### Note on answer 5

Answer 5 was withdrawn because it contradicted answer 4. From the state's point
of view an outage and a restart are the same event: if losing in-memory state on
restart is acceptable, then an hour of downtime cannot cost money or data — it
costs an hour. If an hour of downtime *does* cost money or data, then in-memory
state is a defect rather than a design.

The mechanism that turns the first into the second is an in-memory idempotency
store: a retry arriving after a restart finds no record of the original attempt
and re-runs the side effect, which is the classic double-charge. That specific
hazard is what the state model in section 3 exists to close.

---

## 2. Transport chosen

**stdio.** The client spawns the server as a child process and speaks JSON-RPC
over stdin/stdout.

Consistency against the answers above:

- **Answer 1** — process-per-client is exactly the "each on their own machine"
  shape. Nothing is shared, so nothing needs isolating.
- **Answer 2** — one client with overlapping requests is well within what a
  single stdio pipe handles; concurrent requests are distinguished by JSON-RPC
  id, not by connection.
- **Answer 4** — state scoped to a process that lives and dies with its client
  is the state model, rather than something enforced on top of it.
- **Answer 5 (revised)** — stdio has essentially no availability story: the
  server exits with its client. That is acceptable only because downtime is
  cheap, which is what the revised answer says.
- **Answer 3 — the one point of strain.** See section 6.

---

## 3. State model chosen

**In-memory, plus a durable idempotency ledger.** Session state lives in the
process and dies with it. Separately, any side-effecting operation records its
idempotency key somewhere that survives a restart, so a retry after a crash
cannot double-execute.

### Recorded tension, not smoothed over

This is stricter than answer 4 requires, and it sits awkwardly beside the
withdrawal of answer 5. A durable ledger only earns its keep if there is a side
effect whose double-execution costs something — which is closer to the original
answer 5 than to the version that replaced it.

The reconciliation this record adopts: **nothing durable is at stake precisely
because retries cannot double-execute.** The ledger is the reason answer 5 can
stay withdrawn, not evidence that it should not have been. Choosing more safety
than the stated requirement is a conservative call, not an inconsistent one.

The consequence worth being explicit about: the ledger is the **only** durable
thing in the design. If it is ever allowed to become in-memory "for now", the
withdrawal of answer 5 stops being true and this record is void.

---

## 4. Rationale

> **The cheapest thing that fits today.** stdio matches the current shape
> exactly and costs nothing to run. Paying for remote capability a year early is
> a worse trade than migrating once, later.

---

## 5. Option rejected

**Streamable HTTP bound to loopback (127.0.0.1).**

Rejected because it buys remote-readiness that is not needed yet, and charges
for it immediately: an HTTP listener on every teammate's machine is reachable by
any other process on that machine, so it needs an authentication story from day
one. That is a real security surface maintained for roughly a year of no
benefit.

Its genuine advantage was acknowledged and judged not worth the price: loopback
HTTP becomes remote-capable by changing a bind address, whereas stdio cannot
become remote-capable at all. The bet is that one deliberate migration later is
cheaper than a year of carrying auth for a listener nobody calls.

Also considered and set aside:

- **Streamable HTTP, network-exposed** — pays the full shared-host cost (auth,
  TLS, origin validation, session routing) twelve months before a shared host
  exists to justify it.
- **HTTP+SSE** — superseded by Streamable HTTP and deprecated in the spec.
  Adopting it means signing up for a migration already known to be required.

---

## 6. Revisit condition

**Revisit the moment any caller is not on the same machine as the server** —
stdio cannot serve it, and there is no bind address to change.

This is the live risk in the whole record. Answer 3 puts a shared host inside
twelve months, and stdio does not survive that move: it is a transport
migration, not a configuration edit. That cost is knowingly deferred, not
overlooked.
