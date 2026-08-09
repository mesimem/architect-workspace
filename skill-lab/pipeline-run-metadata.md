# Pipeline Run Metadata — orders_nightly_load

Run metadata for the failure captured in `orders-pipeline-failure.log`. Feeds the same `orders` table that supplies the executive revenue dashboard (see `skill-lab/orders.csv`, `skill-lab/quality-contract.md`).

## Job

| Field | Value |
|---|---|
| Job name | `orders_nightly_load` |
| Schedule | `0 2 * * *` (daily, 02:00 UTC) |
| Source | `crm_export_sftp` → `crm_export_2026-08-03.csv` |
| Target | `orders` table (Postgres) |
| Owner | Data Platform (on-call rotation) |
| Correlation ID (this run) | `f3a9c2e1-6b0d-4e2a-9c1f-7d5b8a90e001` |

## This run — 2026-08-03T02:00:00Z

| Metric | Value |
|---|---|
| Status | **FAILED** |
| Duration | 5.6s |
| Rows extracted | 143 |
| Rows loaded | 139 |
| Rows quarantined (DLQ) | 4 |
| DLQ threshold (fail job if exceeded) | 0 |
| Retry attempts on failed transform step | 3 (max configured) |
| Retry outcome | Exhausted — identical `MappingError` on all 3 attempts |
| Lookup table used | `region_code_map`, version `2026-06-11` |
| Quarantined order IDs | `ORD-1017`, `ORD-1018`, `ORD-1019`, `ORD-1023` |
| Quarantine reason (as logged) | `unmapped_region_value_Central` |

## Recent run history (last 5 scheduled runs)

| Run date (UTC) | Status | Rows extracted | Rows loaded | Rows quarantined |
|---|---|---|---|---|
| 2026-08-03 | FAILED | 143 | 139 | 4 |
| 2026-08-02 | SUCCESS | 118 | 118 | 0 |
| 2026-08-01 | SUCCESS | 126 | 126 | 0 |
| 2026-07-31 | SUCCESS | 131 | 131 | 0 |
| 2026-07-30 | SUCCESS | 109 | 109 | 0 |

No prior run in this window has quarantined any rows or seen a `region` value outside `North`, `South`, `East`, `West`.

## Known upstream context

- `region_code_map` was last updated **2026-06-11**. No update has been made since, including today.
- The CRM export (`crm_export_sftp`) is owned by the Sales Systems team, not Data Platform. No change notice for the 2026-08-03 export was received on the Data Platform side as of this run.
- `orders_dlq` (dead-letter table) currently holds the 4 rows from this run only; no prior unresolved DLQ entries.

## Dependencies

- Upstream: `crm_export_sftp` (Sales Systems team)
- Downstream: `orders` table → executive revenue dashboard (see `skill-lab/quality-contract.md` for the downstream quality contract this feed must satisfy)
