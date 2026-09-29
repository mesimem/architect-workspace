# governance-lab

An acting agent behind a gate. `agent.js` proposes an action, `gate.js` evaluates it
against the rules in `policy.json`, and only on an `allow` does `act.js` append a line to
`data/ledger.jsonl`. Every verdict, allow or deny, is recorded in `data/decisions.jsonl`.
The gate fails closed: an action no rule speaks to is denied.

Run it: `node act.js` (from this folder). Zero dependencies, nothing to install.
Exit 0 means the action was carried out; exit 3 means the gate blocked it.

Pick the case with `AGENT_MODE` — `normal` (default), `generous`, `sloppy` or `rogue`.
PowerShell: `$env:AGENT_MODE="rogue"; node act.js`. Bash: `AGENT_MODE=rogue node act.js`.
`node agent.js` prints a proposal without submitting it. Edit `policy.json` to change
what is permitted — it is re-read on every evaluation, so no restart is needed.
