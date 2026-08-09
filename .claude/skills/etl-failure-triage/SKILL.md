---
name: etl-failure-triage
description: Use when the user asks why an ETL or ELT pipeline, scheduled load, SQL job, data refresh, or ingestion process failed or produced suspicious output. Reviews logs and run metadata, ranks likely causes, cites evidence, and recommends the next safe diagnostic steps. Do NOT use to fix or modify pipeline code, to rerun a job, or to design/build a pipeline — this Skill diagnoses, it does not remediate.
---

# ETL Failure Triage

Diagnose why a pipeline, load, job, or ingestion run failed or produced suspicious output — without touching code and without rerunning anything.

## When this Skill applies

Trigger on requests to:
- Explain why an ETL/ELT pipeline, scheduled load, SQL job, data refresh, or ingestion process failed
- Review a failure log, error output, or stack trace from a pipeline run
- Investigate suspicious/unexpected output from a data job (not necessarily a hard failure)

Do **not** trigger on requests to:
- Fix, patch, or modify pipeline code (that's implementation work, not triage)
- Rerun or retry a job
- Design or build a new pipeline
- Validate a dataset's quality with no failure/error context (use `data-quality-gate` for that)

If no log, run output, or failure description is available, ask for one before proceeding — this Skill cannot diagnose from a bare "it broke" with no evidence.

## Inputs

1. **Log, run output, or failure description** — required. If none is supplied, ask for it before proceeding.
2. **Run metadata** — optional but preferred (job name, start/end time, row counts, retry count, upstream/downstream dependencies). Read it when supplied; note in the output when it wasn't.

## Procedure

1. Read the log/failure description and the run metadata (if supplied) in full before drawing any conclusion.
2. Separate **facts** (directly observed in the log/metadata — timestamps, error strings, row counts, exit codes) from **hypotheses** (inferred explanations for those facts). Never present a hypothesis as a fact.
3. Check the log against the known failure signatures in `references/common-failures.md` — read that file now if you have not already loaded it this session; it maps common error patterns (schema mismatch, type conversion failure, retry exhaustion, connection/timeout errors, permission errors) to their typical root causes and the diagnostic step that confirms or rules out each one.
4. Rank candidate causes by how well the evidence in the log/metadata supports them — most-supported first. Every ranked cause must cite the specific line, error string, or metadata field that supports it.
5. For each ranked cause, name the next diagnostic step that would confirm or rule it out. Diagnostic steps are read-only (inspect a schema, check a source system, compare row counts, review a config value) — never "rerun the job" or "patch the code."

## Output format

Return exactly these five sections, in order:

1. **Incident Summary** — one or two sentences: what job, what time, what it was supposed to do, what happened instead.
2. **Evidence** — bullet list of facts only, each with its source (log line, metadata field). No interpretation here.
3. **Ranked Causes** — numbered list, most likely first. Each entry: the hypothesis, the evidence it's grounded in, and a confidence qualifier (e.g. "strongly supported," "plausible," "speculative").
4. **Next Tests** — one concrete, read-only diagnostic step per ranked cause, ordered to match.
5. **Escalation Recommendation** — whether this needs human/owner escalation now (per this repo's Escalation Protocol) or can continue as a solo diagnostic loop, and why.

## Constraints

- Do not change pipeline code.
- Do not rerun jobs.
- Do not claim a root cause without evidence — if the log doesn't support a single definitive cause, say so and present it as a ranked list of plausible causes instead.
- Never fabricate log content, metadata, or evidence not actually present in the supplied inputs.
