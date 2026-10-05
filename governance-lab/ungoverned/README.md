# ungoverned

The control case. `agent.js` here is a byte-for-byte copy of the governed agent — same
four situations, same reasoning, no malice. The gate is simply gone: no `policy.json`, no
risk scoring, no escalation, no approval, no decisions log.

`node act.js` proposes an action and carries it out. There is no verdict, so nothing can
be refused, nothing waits for a human, and no side effect carries a name. Every mode
exits 0. Pick the case with `AGENT_MODE` — `normal`, `generous`, `sloppy`, `rogue`
(`escalate` exists too and simply fires).

Everything lands in `ungoverned/data/ledger.jsonl` only, so the governed ledger,
decisions log and pending queue are untouched. The ledger records what happened. It does
not record why, who asked, or on whose authority — and nothing links its lines together,
so a line changed after the fact leaves no trace.
