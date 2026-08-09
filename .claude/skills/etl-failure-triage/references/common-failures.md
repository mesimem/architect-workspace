# Common ETL/ELT Failure Signatures

Patterns to check a failure log against, their typical root causes, and the read-only diagnostic step that confirms or rules out each one. Read this when running the Skill's Procedure step 3.

## Schema mismatch

**Signature:** Errors mentioning an unexpected/missing column, a type coercion failure on a named field, "column not found," "cannot cast," or a row rejected for shape reasons. Often shows up right after an upstream extract step and before a transform/load step.

**Typical root causes:**
- Upstream source added, removed, renamed, or retyped a column without notice
- A nullable field started arriving blank/null when the pipeline assumed always-populated
- Two source systems merged with incompatible schemas for the same logical field (e.g. one system free-texts a field the pipeline expects to be an enum)

**Diagnostic step:** Compare the current source schema (or a sample of recent raw records) against the schema the transform step expects. Do not alter the transform to accommodate the new shape — that's remediation, not diagnosis.

## Failed conversion / mapping step

**Signature:** Errors during a named transform/mapping stage — type conversion exceptions, lookup/mapping table misses, "no mapping found for value X," enum/dimension values falling through to a default or null.

**Typical root causes:**
- A new source value appeared that isn't in the mapping/lookup table (e.g. a new region code, a new product category)
- A conversion function received a value outside its expected domain (e.g. negative number into a function assuming positive, blank string into a numeric parse)
- Mapping table itself is stale relative to the source system's current value set

**Diagnostic step:** Isolate the specific input value(s) that failed the mapping/conversion and check whether they exist in the current mapping/lookup table or reference data. Do not add the missing mapping as part of triage — that's a code/data fix, out of scope for this Skill.

## Retry exhausted without resolving the problem

**Signature:** Multiple attempt/retry log lines with the same or a related error, followed by a final failure after the max-retry count is reached. The error signature is often identical or nearly identical across attempts.

**Typical root causes:**
- The failure is deterministic (bad data, bad config, bad mapping) rather than transient (network blip, momentary lock contention) — retrying a deterministic failure will never succeed
- An upstream dependency is down for longer than the retry window covers
- Retry logic itself has no backoff or lacks jitter, hammering a rate-limited endpoint into repeated 429s

**Diagnostic step:** Compare the error signature across retry attempts. If identical every time, the cause is deterministic — the retry step itself is not informative and the real cause lies in whatever failed on attempt 1 (check schema/mapping causes above first). If the error changes shape across retries (e.g. timeout → 429 → timeout), that points toward an unstable or rate-limited upstream dependency instead.

## Connection / timeout errors

**Signature:** "Connection refused," "connection reset," timeout exceptions, DNS resolution failures.

**Typical root causes:** Upstream service down or unreachable, network/firewall change, credentials expired mid-run, timeout threshold too aggressive for current data volume.

**Diagnostic step:** Check upstream service status/health independently of this pipeline, and confirm whether the timeout threshold is consistent with recent data volume trends.

## Permission / auth errors

**Signature:** 401/403 responses, "access denied," "permission denied," expired token errors.

**Typical root causes:** Rotated credential not propagated to the job's environment, expired API key/token, changed IAM/role policy on the source or destination system.

**Diagnostic step:** Confirm (read-only) whether the credential/token used by the job is current and has not been rotated or revoked since the last successful run.
