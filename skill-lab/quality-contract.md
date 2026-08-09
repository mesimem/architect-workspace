# Quality Contract — orders.csv

Rules that `skill-lab/orders.csv` (or any dataset with this shape) must satisfy before publication.

| Field | Rule |
|---|---|
| `order_id` | Must be unique across all rows. No two rows may share the same `order_id`. |
| `region` | Required. Must not be null or blank for any row. |
| `revenue` | Must be greater than zero. Negative or zero values are invalid. |
| `load_timestamp` | Must be less than 24 hours old at time of check. |

## Volume

- Expected row count: **at least 10 rows**. Fewer than 10 rows is a volume failure.
