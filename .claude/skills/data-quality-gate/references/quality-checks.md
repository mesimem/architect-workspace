# Quality Checks Reference

Detailed definition of every check `data-quality-gate` runs, its default threshold, and the PASS/WARN/FAIL criteria. Read this file when running the Skill's Procedure step 3.

## Checks

- **Schema** — confirm expected columns are present and correctly typed (e.g. numeric fields parse as numbers, timestamp fields parse as valid datetimes).
- **Freshness** — compare the most recent load/timestamp column against the contract's max-age threshold. Default: 24 hours. Evaluate freshness **per row** where a per-row load timestamp exists, not just against the single most recent row — a dataset can have a fresh max timestamp while still carrying stale rows mixed in.
- **Expected volume** — compare row count against the contract's minimum/expected row count. Default: flag if fewer than 10 rows.
- **Key uniqueness** — confirm the contract's designated key column(s) contain no duplicate values. If two rows share a key but differ in other fields, treat this as a key-uniqueness violation even though the rows are not fully identical (see Duplicates below) — conflicting records under one key are a correctness risk, not a harmless repeat.
- **Duplicates** — check for fully duplicated rows (every column identical) in addition to key-level duplicates. This is a distinct check from key uniqueness: a fully duplicated row is a repeat with no informational conflict, whereas a key collision with differing data is a conflict that needs resolution.
- **Required fields** — confirm contract-designated required fields are non-empty for every row.
- **Nulls** — report null/blank rates per column, flagging any required field with nulls. This check is broader than "required fields": it reports on every column, not only the ones marked required, so a rising null rate in a non-required column is visible before it becomes a problem.
- **Numeric rules** — apply contract-defined numeric constraints (e.g. a field must be greater than zero) and report violating rows with their actual values.

## Status assignment

Assign per-check status using this logic:

- **FAIL** — contract rule violated in a way that would corrupt or mislead downstream consumers (e.g. duplicate keys, missing required fields, values violating a hard numeric rule).
- **WARN** — rule violated but non-blocking or borderline (e.g. freshness slightly over threshold, row count slightly under expected, minor null rate in a non-required field).
- **PASS** — rule satisfied.

## No contract supplied

If no quality contract is found or provided, run every check above using its stated default threshold, and say explicitly in the report that no contract was supplied and defaults were used. Do not silently skip checks for lack of a contract.
