# Data Quality Report — `skill-lab/orders.csv`

**Validated against:** `skill-lab/quality-contract.md`
**Rows evaluated:** 12 (11 distinct `order_id` values)
**Source data modified:** No (read-only check)

| Check | Evidence | Status | Recommended Action |
|---|---|---|---|
| Schema | All 8 expected columns present (`order_id, customer_name, region, product, quantity, revenue, order_date, load_timestamp`). `quantity`/`revenue` parse as numeric; `order_date`/`load_timestamp` parse as valid datetimes for every row. | PASS | None |
| Freshness (< 24h) | Most recent `load_timestamp` is `2026-08-03T09:20:00Z` (row `ORD-1004`, second occurrence). Row `ORD-1007` (Harbor Point Inc) has `load_timestamp = 2026-07-31T10:00:00Z` — roughly 71 hours old, well past the 24-hour threshold, mixed in among otherwise-fresh rows. | FAIL | Quarantine/investigate `ORD-1007`; do not treat max-timestamp freshness as representative of the whole file. |
| Expected volume (≥10 rows) | 12 rows present. | PASS | None |
| Key uniqueness (`order_id`) | `ORD-1004` appears twice (rows 4 and 11) with **conflicting** values: quantity 20 vs 21, revenue 450.00 vs 460.00, order_date 2026-08-02 vs 2026-08-03, load_timestamp 06:30 vs 09:20 UTC. | FAIL | Resolve which `ORD-1004` record is authoritative before publish; treat as a conflict, not a harmless repeat. |
| Duplicates (full-row) | No two rows are fully identical (the `ORD-1004` pair differs in quantity/revenue/date/timestamp, so it is a key conflict, not a duplicate). | PASS | None |
| Required fields (`region`) | Row 5 (`ORD-1005`, Redline Logistics) has a blank `region`. | FAIL | Backfill or reject the row before publish. |
| Nulls (all columns) | `region`: 1/12 blank (8.3%). All other columns: 0 nulls/blanks across 12 rows. | WARN | Monitor `region` null rate; currently isolated to one row. |
| Numeric rules (`revenue` > 0) | Row 7 (`ORD-1006`, Silverline Foods) has `revenue = -75.00`. | FAIL | Reject or correct row before publish; negative revenue is a hard contract violation. |

## Overall result: **FAIL**

Four checks failed: freshness, key uniqueness, required fields, and numeric validity.

## Recommendation: **BLOCK**

Publication must be blocked until the stale row, the conflicting `ORD-1004` records, the missing `region` value, and the negative `revenue` value are resolved.

---
*Per the incident workflow, because this result is FAIL/unsafe, the pipeline failure log and run metadata were investigated next — see `etl-triage-report.md`.*
