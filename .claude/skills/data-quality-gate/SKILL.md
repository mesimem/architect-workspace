---
name: data-quality-gate
description: Use when the user asks to validate a dataset, CSV, ETL output, query result, or dashboard/report source for correctness or publish-readiness — e.g. "validate this data before it goes to the dashboard," "is this dataset safe to publish," "run a quality check on this ETL output." Checks the data against a quality contract and returns PASS, WARN, or FAIL with evidence and a PUBLISH or BLOCK recommendation. Do NOT use for writing or reviewing SQL, calculating a metric, or designing a dashboard's layout/visuals — only invoke when the ask is specifically to validate/check data quality or publish-readiness, not merely to produce or present data.
---

# Data Quality Gate

Validate a dataset before it is published, without ever modifying the source data.

## When this Skill applies

Trigger on requests to:
- Validate a dataset, CSV, ETL output, or query result before it is used or published
- Check data quality (schema, freshness, duplicates, nulls, numeric validity, volume)
- Assess publish-readiness / go-no-go for a dashboard or report data source

Do **not** trigger on requests that merely touch data or dashboards without asking for a quality/validation check, including:
- Writing, fixing, or explaining SQL
- Calculating or defining a metric
- Designing a dashboard's layout, chart types, or visuals
- Building or modifying a report/dashboard itself

If a request is one of those and doesn't separately ask to validate or check the data, don't invoke this Skill. When ambiguous, the presence of words like "validate," "quality check," "safe to publish," or "publish-ready" pointing at a dataset is the deciding signal — not the mere presence of "dashboard," "SQL," or "metric" in the request.

## Inputs

1. **Dataset path** — required. If the user has not given one, ask for it before proceeding.
2. **Quality contract** — optional but preferred. Look for a file named `quality-contract.md` (or similarly named) in the same directory as the dataset, or use one the user points to. If no contract is supplied or found, fall back to reasonable default checks (see `references/quality-checks.md`) and note in the output that no contract was supplied.

## Procedure

1. Read the dataset. Do not write to it, rename it, sort it, or otherwise alter it in any way — this skill is read-only with respect to the source file.
2. Read the quality contract, if present, and extract its rules (uniqueness keys, required fields, freshness threshold, expected row count, numeric constraints, etc.).
3. Run the checks defined in `references/quality-checks.md` — read that file now if you have not already loaded it this session; it defines exactly what each check covers, its default threshold, and the PASS/WARN/FAIL criteria. Use contract-defined thresholds where available, otherwise the defaults documented there.
4. For each check, record: what was checked, the evidence (counts, row references, sample values), and a status of PASS, WARN, or FAIL.

## Output format

Present results as a single table:

| Check | Evidence | Status | Recommended Action |
|---|---|---|---|
| ... | ... | PASS / WARN / FAIL | ... |

After the table, state:

1. **Overall result: PASS, WARN, or FAIL** — FAIL if any check failed; WARN if no failures but at least one warning; PASS only if every check passed.
2. **Recommendation: PUBLISH or BLOCK** — BLOCK if overall result is FAIL; BLOCK if overall result is WARN and any warning touches a correctness-critical field (keys, required fields, numeric validity); otherwise PUBLISH.

## Constraints

- Never modify, move, or delete the source dataset.
- Never fabricate evidence — every Status must trace back to something actually observed in the data.
- Keep the report concise and procedural; do not editorialize beyond the table and the two closing lines.
