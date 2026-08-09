# Executive Dashboard Incident Brief — Orders Dashboard Publish

**Date:** 2026-08-03
**Subject:** Orders dashboard scheduled publish — data safety check

## Decision: BLOCK

The orders dataset backing this dashboard fails validation against its quality contract and must not be published in its current state.

## What happened

The nightly `orders_nightly_load` pipeline run on 2026-08-03 failed. A new region value (`"Central"`) appeared in the CRM source export that has no entry in the pipeline's region lookup table (last updated 2026-06-11). The mapping step failed on 4 orders, retried 3 times with an identical error each time, and those 4 rows were quarantined. The job as a whole failed because any quarantined row breaches its zero-tolerance threshold.

Independently, a direct check of the dataset itself found:
- One order (`ORD-1004`) loaded twice with **conflicting** quantity, revenue, and date values.
- One order (`ORD-1005`) missing its `region` value.
- One order (`ORD-1006`) with **negative revenue** (-$75.00).
- One order (`ORD-1007`) loaded from data over 71 hours old, mixed in with otherwise same-day data.

## Why this blocks publish

Any one of the conflicting-record, missing-required-field, or negative-revenue issues would corrupt figures shown on an executive dashboard (order counts, regional totals, revenue sums). Publishing now risks presenting incorrect and internally inconsistent numbers as authoritative.

## What is NOT yet known

- **Financial impact** of the affected records has not been calculated and is not stated here.
- **Owner/assignee** for the fix has not been confirmed beyond the pipeline's documented owner (Data Platform, on-call rotation).
- **Resolution ETA** has not been provided by any team and is not estimated here.

These are intentionally left open rather than assumed.

## Recommended next business action

Hold the dashboard publish. Route this brief and the attached triage findings to the Data Platform on-call owner to (1) confirm what business region `"Central"` should map to and update the lookup table accordingly, and (2) resolve the four dataset-level issues (duplicate/conflicting `ORD-1004` record, missing region on `ORD-1005`, negative revenue on `ORD-1006`, stale row `ORD-1007`) before the next publish attempt.

## Supporting detail

See `data-quality-report.md` (dataset validation, PASS/WARN/FAIL by rule) and `etl-triage-report.md` (pipeline failure root-cause ranking and evidence) in this same folder.
