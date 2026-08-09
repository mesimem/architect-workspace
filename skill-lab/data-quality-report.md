# Data Quality Report — orders.csv

**Dataset:** `skill-lab/orders.csv`
**Contract:** `skill-lab/quality-contract.md`
**Checked at (UTC):** 2026-08-04T00:31:43Z

| Check | Evidence | Status | Recommended Action |
|---|---|---|---|
| Schema | All 8 expected columns present with correct types: `order_id` (str), `customer_name` (str), `region` (str), `product` (str), `quantity` (int), `revenue` (numeric), `order_date` (date), `load_timestamp` (ISO-8601 datetime). | PASS | None. |
| Freshness (`load_timestamp` < 24h old) | 3 of 12 rows exceed the 24h threshold as of check time: `ORD-1003` (2026-08-02T22:10:00Z, ~26.4h old), `ORD-1009` (2026-08-02T23:55:00Z, ~24.6h old), `ORD-1007` (2026-07-31T10:00:00Z, ~86h old — order dated 2026-07-30). | FAIL | Re-extract/reload the stale rows (esp. `ORD-1007`, which is over 3 days old) before publishing; investigate why the load pipeline is carrying rows this old. |
| Expected volume | 12 rows present (contract minimum: 10). | PASS | None. |
| Key uniqueness (`order_id`) | `ORD-1004` appears twice: once with `quantity=20, revenue=450.00, order_date=2026-08-02, load_timestamp=2026-08-03T06:30:00Z`, and again with `quantity=21, revenue=460.00, order_date=2026-08-03, load_timestamp=2026-08-03T09:20:00Z`. Not identical rows — conflicting values under the same key. | FAIL | Determine which `ORD-1004` record is authoritative (looks like an update/correction was appended rather than replacing the original); dedupe by `order_id` keeping the latest `load_timestamp`, or fix upstream to upsert instead of append. |
| Full-row duplicates | No two rows are identical across all fields (the `ORD-1004` pair differs in `quantity`, `revenue`, `order_date`, `load_timestamp`). | PASS | None. |
| Required fields (`region`) | `ORD-1005` (Redline Logistics) has a blank `region` value. | FAIL | Backfill `region` for `ORD-1005` from source system or exclude the row until resolved. |
| Nulls (per column) | `region`: 1/12 blank (8.3%) — `ORD-1005`. All other columns (`order_id`, `customer_name`, `product`, `quantity`, `revenue`, `order_date`, `load_timestamp`): 0/12 blank. | WARN | Same remediation as the `region` required-field failure above; monitor null rate on future loads. |
| Numeric rules (`revenue` > 0) | `ORD-1006` (Silverline Foods) has `revenue = -75.00`. | FAIL | Investigate source of negative revenue (return/refund miscoded as an order?) and correct or exclude before publishing. |

## Overall result: **FAIL**

Three hard contract rules are violated: duplicate `order_id` (`ORD-1004`), a missing required `region` value (`ORD-1005`), and a non-positive `revenue` value (`ORD-1006`). Freshness is also violated for 3 rows, one of which (`ORD-1007`) is nearly 4 days stale.

## Recommendation: **BLOCK**

Do not publish to the executive revenue dashboard until the duplicate key, missing region, negative revenue, and stale rows are corrected or excluded at the source. None of the source data (`orders.csv`) was modified as part of this validation.
