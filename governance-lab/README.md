# governance-lab

An acting agent behind a gate. `agent.js` proposes an action, `gate.js` scores it against
the five risk factors in `policy.json`, and only on an `allow` does `act.js` append a line
to `data/ledger.jsonl`. Every verdict is recorded in `data/decisions.jsonl`.
The gate fails closed: an action no rule speaks to is denied.

Three verdicts. **allow** acts now. **deny** never acts. **escalate** parks the action in
`data/pending/<actionId>.json` with all five factors, the score and a deadline, and acts
only if a named human approves it in time.

Run it: `node act.js` (from this folder). Zero dependencies, nothing to install.
Exit 0 acted, 3 blocked, 4 escalated. Pick the case with `AGENT_MODE` — `normal`
(default), `escalate`, `generous`, `sloppy` or `rogue`. PowerShell:
`$env:AGENT_MODE="rogue"; node act.js`. Bash: `AGENT_MODE=rogue node act.js`.

Decide on what is waiting:

    node govern.js pending
    node govern.js approve <actionId> --by "Your Name"
    node govern.js deny    <actionId> --by "Your Name" --reason "why"

`--by` is required; without a name neither command will proceed. An approval can be
spent exactly once — the second `approve` on the same actionId changes nothing. Pending
items expire after one hour, overridable with `ESCALATION_TTL_SECONDS` (seconds, read
when the item is parked), and **an expired item reads as denied everywhere**: silence is
not consent, so nothing fires just because the queue went unwatched.

Edit `policy.json` to change what is permitted — thresholds, factors and bands are all
data, re-read on every evaluation, so no restart is needed.
