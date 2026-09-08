---
name: csv-report-builder
description: Use when the user has a CSV file and wants it validated, statistically summarized, and turned into a shareable Markdown report — e.g. "validate this CSV and build me a report," "summarize this dataset," "check this export for problems and write up the findings." Runs a three-stage pipeline (validate -> compute stats -> render report) via the bundled Python scripts. Do NOT use for live database queries, non-tabular data (JSON/XML/logs), or when the user wants an interactive dashboard rather than a static report — those need different tooling.
allowed-tools: Read, Write, Bash(python3 *)
---

# CSV Report Builder

Turns a raw CSV file into a validated, statistically-summarized Markdown
report. The skill is a three-stage pipeline, one script per stage, each
independently runnable and independently testable. Claude orchestrates the
stages; the scripts do the deterministic work.

## Why it's split into three files

Each stage has a single responsibility and a narrow, typed contract with the
next stage (JSON in, JSON out). This mirrors the project's own composition
rule: one responsibility per module, no stage reaches into another's
internals. It also means a failure in stage 2 (bad stats) never gets masked
by stage 3 (report rendering) — each stage's output is inspectable on its
own.

```
input.csv
   |
   v
[1] scripts/validate_csv.py  -->  validation.json   (structural checks)
   |
   v  (only if valid: true)
[2] scripts/compute_stats.py -->  stats.json         (per-column statistics)
   |
   v
[3] scripts/generate_report.py -> report.md          (final Markdown report)
```

## Files in this skill

| File | Purpose |
|---|---|
| `SKILL.md` | This file. Orchestration logic and the contract between stages. |
| `scripts/validate_csv.py` | Stage 1. Structural validation only: parseable, has a header, consistent column counts, not empty. No statistics, no report formatting. |
| `scripts/compute_stats.py` | Stage 2. Per-column statistics: numeric columns get min/max/mean/median/stdev; text columns get unique-value count and most-common value. No validation, no formatting. |
| `scripts/generate_report.py` | Stage 3. Pure rendering: takes validation + stats JSON and fills in `reference/report_template.md`. No parsing, no math. |
| `reference/report_template.md` | The Markdown skeleton stage 3 fills in. Loaded only when you need to see or change the report's shape. |
| `reference/usage_examples.md` | Example CLI invocations and sample JSON/Markdown output for each stage. Loaded only when you need a concrete example instead of the abstract contract below. |

## How to run the pipeline

All three scripts are stdlib-only Python 3 (no pip installs) and communicate
over stdin/stdout JSON so they can be chained or run individually. Run them
with `Bash(python3 *)` — no other tool is needed for this skill's own logic;
use `Read`/`Write` only to inspect the CSV first or save the final report
somewhere the user asked for.

**Stage 1 — validate:**
```
python3 scripts/validate_csv.py path/to/input.csv
```
Prints a JSON object to stdout: `{"valid": bool, "errors": [...], "row_count": int, "column_count": int, "columns": [...]}`.
If `"valid": false`, stop here and report the `errors` list to the user —
do not proceed to stage 2 on an invalid file.

**Stage 2 — compute stats (only if stage 1 was valid):**
```
python3 scripts/compute_stats.py path/to/input.csv
```
Prints a JSON object: `{"columns": {"<col_name>": {...per-column stats...}}}`.

**Stage 3 — render the report:**
```
python3 scripts/generate_report.py path/to/input.csv --validation validation.json --stats stats.json --out report.md
```
`--validation` and `--stats` accept either a file path or `-` to read the
respective JSON from a temp file you wrote with the prior stage's stdout.
Writes the finished report to the `--out` path and also prints it to stdout.

## Error handling

- Stage 1 failure -> report the specific structural errors to the user and
  stop. Do not guess at a fix; ask what they want done with the malformed
  rows.
- Stage 2/3 failure (e.g. a column that's neither cleanly numeric nor
  text-categorical, like a mixed-type column) -> the script exits non-zero
  with a message on stderr. Surface that message verbatim; do not silently
  skip the offending column.
- Never fabricate statistics or report content if a stage errors — rerun or
  report the failure instead.

## Tool restriction rationale

This skill is scoped to `Read`, `Write`, and `Bash(python3 *)` only. It has
no need for network access, git operations, or arbitrary shell commands, so
those are intentionally excluded from `allowed-tools` — a bug in the report
logic should never be able to reach outside "read a CSV, run local Python,
write a report."
