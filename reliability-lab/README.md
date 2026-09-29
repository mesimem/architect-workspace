# reliability-lab

An order desk that confirms orders through an outside AI vendor — plus a fake vendor you can make fail on command. Zero dependencies, nothing to install.

Run it: `node src/desk.js confirm 1001` (from this folder).

The desk asks the vendor for a message and appends one JSON line to `data/sent.log` — that line is the side effect a customer would notice.

The call is wrapped `breaker(retry(withTimeout(...)))`: a 2 s deadline per attempt, up to 3 attempts with gaps doubling from 500 ms plus jitter, and a circuit breaker that opens after 3 consecutive failed operations, fails instantly with `BreakerOpen` for a 10 s cooldown, then lets one probe through. Breaker state persists in `data/breaker.json` across runs.

When the vendor is unreachable (`UpstreamUnavailable`, `BreakerOpen`) the desk sends a plain template instead, marked `"fallback": true`. It never falls back on `BadResponse` — a wrong message must not be sent under any name; those orders are parked in `data/dead-letter.jsonl`. `node src/desk.js replay` re-runs every parked order and removes the ones that succeed.

The send itself runs under `runOnce("order:<id>", ...)`, keyed on the order and backed by `data/keys.json`: the key is claimed before the append, so a second arrival for the same order returns the stored line and reports `"duplicate": true` instead of sending again. Re-check it with `npm test` (runs `check-idempotency.js` — a plain script, no framework).

A quality gate scores the message out of 100 (+40 the order id as a whole token, +30 no banned phrases, +30 length 20–300) and refuses anything under 70 with `QualityGateRejected` — those orders are dead-lettered with the score and what they lost points for, never sent, never fallen back. The gate sits inside `runOnce`, so a duplicate is returned before it runs. Every run carries a correlation id on each log line, on the `sent.log` line and on any dead-letter row, and ends with a one-line JSON `receipt:`. `node src/desk.js score "<message>" <orderId>` shows the breakdown for any text.

Set the vendor's behaviour with `VENDOR_MODE`, default `ok`: `ok` (fast, correct), `slow` (10 s, then correct), `down` (500 error), `garbage` (fast, confidently wrong).

PowerShell: `$env:VENDOR_MODE='down'; node src/desk.js confirm 1001`  ·  bash: `VENDOR_MODE=down node src/desk.js confirm 1001`

`data/` is git-ignored: run output is not source.
