# ETL Failure Triage Report — `orders_nightly_load`

**Run:** 2026-08-03T02:00:00Z · **Correlation ID:** `f3a9c2e1-6b0d-4e2a-9c1f-7d5b8a90e001`
**Sources reviewed:** `skill-lab/orders-pipeline-failure.log`, `skill-lab/pipeline-run-metadata.md`

---

## 1. Incident Summary

The `orders_nightly_load` job (scheduled daily at 02:00 UTC, pulling `crm_export_2026-08-03.csv` from `crm_export_sftp` into the Postgres `orders` table) ran for 5.6 seconds and was marked **FAILED**. It extracted 143 rows and loaded 139; the remaining 4 rows (`ORD-1017`, `ORD-1018`, `ORD-1019`, `ORD-1023`) were quarantined to the `orders_dlq` dead-letter table because their `region` value, `"Central"`, has no entry in the `region_code_map` lookup table. The job's own contract treats any non-zero quarantine count as a hard failure (`dlq_threshold: 0`), so the run was flagged `ContractViolation` and failed even though 139/143 rows loaded successfully.

## 2. Evidence

- Schema validation step logged a `warn`-level `unexpected_enum_value`: column `region`, observed value `"Central"`, expected enum `["North","South","East","West"]`, affecting 4 rows (`ORD-1017`, `ORD-1018`, `ORD-1019`, `ORD-1023`) — log line 3.
- Transform step `transform_region_mapping` failed 3 times (attempts 1–3) with identical `error_class: "MappingError"` and message `"No mapping entry for region value 'Central' in region_code_map"` for `ORD-1017` — log lines 4, 6, 8.
- `transform_retry_exhausted` explicitly notes `"identical_error_each_attempt": true` after 3/3 max retries — log line 9.
- 4 rows were written to `orders_dlq` with reason `"unmapped_region_value_Central"` — log line 10.
- Load step completed with `outcome: "partial"`: 143 rows expected, 139 loaded, 4 quarantined — log line 11.
- Job summary: `outcome: "failure"`, `error_class: "ContractViolation"`, `reason: "quarantine_threshold_exceeded"`, `dlq_threshold: 0`, `rows_quarantined: 4` — log line 12.
- Metadata: `region_code_map` lookup table was last updated **2026-06-11**, with no update since (including the day of this run) — metadata line 46.
- Metadata: the CRM export is owned by the Sales Systems team, not Data Platform, and no change notice for the 2026-08-03 export was received on the Data Platform side — metadata line 47.
- Metadata: run history for the prior 5 scheduled runs (2026-07-30 through 2026-08-02) shows 0 rows quarantined and no `region` value outside the four known enum values in that window — metadata lines 36–42.
- Metadata: `orders_dlq` holds only the 4 rows from this run; no prior unresolved DLQ backlog — metadata line 48.
- Metadata: downstream consumer of the `orders` table is the executive revenue dashboard, per the quality contract referenced in `skill-lab/quality-contract.md` — metadata line 53.

## 3. Ranked Causes

1. **A new, legitimate `region` value (`"Central"`) started arriving from the CRM source, and the `region_code_map` lookup table is stale relative to it — strongly supported.**
   Evidence: the mapping table's last update (2026-06-11) predates this run and hasn't changed since (metadata line 46); the error is a lookup miss, not a malformed/garbage value (log line 4); the same value fails identically across all 3 attempts (log line 9), which per the retry-exhaustion failure signature indicates a deterministic data/config gap rather than a transient issue; and no prior run in the last 5 days saw this value (metadata line 42), consistent with a source-side change introduced specifically for this run's export file.

2. **The Sales Systems team changed the CRM export's region taxonomy (e.g. added a "Central" territory) without notifying Data Platform — plausible.**
   Evidence: metadata explicitly states the CRM export is owned by Sales Systems and "no change notice for the 2026-08-03 export was received on the Data Platform side" (metadata line 47). This would explain *why* the mapping table went stale (cause 1) rather than being a competing explanation — it's the likely upstream trigger behind cause 1, but is listed separately because it names a different responsible party and requires different confirmation.

3. **Data entry error at the CRM source producing a one-off bad value rather than a genuine new region — speculative.**
   Evidence: nothing in the log or metadata confirms or rules this out; `"Central"` looks like a plausible legitimate US census-style region name (alongside North/South/East/West), which weighs against this being a typo, but this can't be confirmed from the evidence available. Listed for completeness only.

Note on scope: the retry-exhaustion and quarantine-threshold-exceeded behaviors seen in the log are not separate root causes — they are the pipeline's designed response to cause 1/2. The `dlq_threshold: 0` contract setting is working as intended (it caught and surfaced bad data rather than silently loading it), not a defect to investigate.

## 4. Next Tests

1. **For cause 1 (stale mapping table):** Inspect the current `region_code_map` lookup table (read-only query or file review) to confirm it genuinely has no entry for `"Central"`, and check its change history to verify 2026-06-11 is indeed the last update — do not add the missing mapping as part of this diagnostic step.
2. **For cause 2 (upstream taxonomy change):** Review a sample of raw rows in `crm_export_2026-08-03.csv` (and ideally compare against `crm_export_sftp` files from the prior 5 successful runs) to see whether `"Central"` appears only in today's file or was already present but previously filtered/mapped differently; separately, check whether Sales Systems has any change log, release note, or ticket referencing a CRM region/territory update around 2026-08-03.
3. **For cause 3 (data entry error):** Check how many distinct order records carry `region = "Central"` in the source file and whether they share other CRM attributes (e.g. same sales rep, same territory ID, same entry batch) — a cluster of 4 orders sharing a common origin would weigh against a random typo and further support cause 1/2.

## 5. Escalation Recommendation

**Recommend escalation-adjacent notification, not a full governance escalation.** This is not a strategic/architecture decision, security issue, or production infrastructure change — it's a routine data-contract failure that the pipeline's own alerting already routed to `admin_notification_emails` (log line 12), which is the correct automated path per this repo's observability design. However, because the likely root cause traces to a cross-team dependency (Sales Systems changing the CRM export without notifying Data Platform — cause 2), the on-call owner should loop in Sales Systems to confirm/deny a taxonomy change, since Data Platform cannot resolve that ambiguity from the pipeline side alone. This can continue as a solo diagnostic loop (Next Tests above) up to that confirmation step; no `/tmp/escalation.json` write is warranted unless the Sales Systems check reveals a compliance/data-integrity issue beyond a missing enum mapping.
