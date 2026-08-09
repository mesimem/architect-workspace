# ETL Failure Triage — `orders_nightly_load`

**Sources reviewed:** `skill-lab/orders-pipeline-failure.log`, `skill-lab/pipeline-run-metadata.md`
**Pipeline/code modified:** No. **Job rerun:** No.

## 1. Incident Summary

The scheduled `orders_nightly_load` job (daily, 02:00 UTC, correlation ID `f3a9c2e1-6b0d-4e2a-9c1f-7d5b8a90e001`) ran on 2026-08-03 and failed. It was supposed to extract, transform, and load all 143 rows from the CRM export into the `orders` table; instead it quarantined 4 rows during the region-mapping transform step and the job as a whole failed a zero-tolerance dead-letter-queue (DLQ) threshold check.

## 2. Evidence

- `job_start` at `2026-08-03T02:00:00.104Z`; `job_end` at `+5596ms`, `outcome: failure` (log lines 1, 13).
- `extract_source_orders` succeeded: 143 rows extracted from `crm_export_2026-08-03.csv` (log line 2).
- `schema_validate_orders` logged a `warn`/`partial` result: column `region` had an "unexpected_enum_value" of `"Central"` against the expected enum `["North","South","East","West"]`, affecting 4 rows — `ORD-1017, ORD-1018, ORD-1019, ORD-1023` (log line 3).
- `transform_region_mapping` failed 3 times (attempts 1–3) with an identical `MappingError`: *"No mapping entry for region value 'Central' in region_code_map"*, against `order_id: ORD-1017`, `lookup_table_version: 2026-06-11` (log lines 4, 6, 8).
- `transform_retry_exhausted`: `attempts: 3`, `identical_error_each_attempt: true` (log line 9).
- `dead_letter_write`: 4 rows quarantined (`ORD-1017, ORD-1018, ORD-1019, ORD-1023`), reason `unmapped_region_value_Central` (log line 10).
- `load_orders_table`: `rows_expected: 143`, `rows_loaded: 139`, `rows_quarantined: 4` (log line 11).
- `job_summary`: `error_class: ContractViolation`, reason `quarantine_threshold_exceeded`, `dlq_threshold: 0` vs `rows_quarantined: 4` (log line 12).
- Metadata: `region_code_map` last updated **2026-06-11**, unchanged as of this run (metadata "Known upstream context").
- Metadata: last 5 scheduled runs (2026-07-30 through 2026-08-02) all succeeded with 0 quarantined rows, and "No prior run in this window has quarantined any rows or seen a `region` value outside `North, South, East, West`."
- Metadata: `crm_export_sftp` is owned by the Sales Systems team; "No change notice for the 2026-08-03 export was received on the Data Platform side as of this run."
- Metadata: `orders_dlq` currently holds only the 4 rows from this run; no prior unresolved DLQ backlog.

## 3. Ranked Causes

1. **Upstream CRM export began emitting a new region value (`"Central"`) that the `region_code_map` lookup table does not contain, and the mapping table is stale relative to the source's current value set.**
   Evidence: identical `MappingError` naming `region value 'Central'` on all 3 attempts (lines 4/6/8); `region_code_map` version dated `2026-06-11` with no update since (metadata); 5 prior consecutive runs saw only `North/South/East/West` and zero quarantines (metadata run history).
   Confidence: **strongly supported.**

2. **The failure is deterministic, not transient — retrying did not and could not resolve it.**
   Evidence: `transform_retry_exhausted` explicitly logs `identical_error_each_attempt: true` (line 9); per the retry-exhaustion failure signature, an unchanging error across attempts points to bad data/config rather than a network blip. This is a consequence of cause 1, not an independent root cause.
   Confidence: **strongly supported** (rules out connection/timeout or rate-limit hypotheses — no timeout/connection-refused/429 signatures appear anywhere in the log).

3. **A cross-team communication gap: Sales Systems (owner of `crm_export_sftp`) introduced or started passing through a new `"Central"` region value without notifying Data Platform (owner of the mapping table and this job).**
   Evidence: metadata explicitly states no change notice was received for the 2026-08-03 export (metadata "Known upstream context").
   Confidence: **plausible** — supported by the metadata's own note, but the log itself cannot confirm *why* Sales Systems' export changed (e.g., new business region vs. a data-entry/free-text error upstream of the pipeline).

## 4. Next Tests

1. For cause 1: Read-only diff of the distinct `region` values present in `crm_export_2026-08-03.csv` against the current entries in `region_code_map` to confirm `"Central"` is genuinely absent (not a case/whitespace mismatch masquerading as missing).
2. For cause 2: No further test needed beyond what's observed — the identical error across all 3 attempts already rules out a transient/retryable condition; no additional retry or job rerun should be attempted.
3. For cause 3: Check the CRM export's change log or contact Sales Systems (read-only inquiry) to determine whether `"Central"` represents a genuine new business region, a renamed region, or an upstream data-entry anomaly — this determines what `region_code_map` should map it to, which is a data/business decision outside this triage's scope.

## 5. Escalation Recommendation

**Escalate to the job owner (Data Platform on-call) rather than resolve autonomously.** The log shows the job's own alerting already fired (`alert_routed_to: admin_notification_emails`, line 12), consistent with this repo's escalation protocol. The read-only diagnostic steps above (Next Tests 1–2) can continue without further authorization, but the actual fix — deciding what business region `"Central"` should map to and updating `region_code_map` — is a data/business decision, not an implementation-level ambiguity, and is explicitly out of scope for this triage Skill. It also directly affects the `orders` table that feeds the executive dashboard, so it should not be resolved silently. No fabricated owner, ETA, or financial figure is provided here, per the incident-workflow constraints.
