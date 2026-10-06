# STORY-017 — STORY-017: Combine multiple travel products into one package

As a travel advisor, I want to combine multiple travel products into one package, so that I can offer comprehensive travel solutions.

**Release:** r3 · AI Assistance and Supplier Management (weeks 4–4)
**Owner:** Travel Advisor
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-019** (Functional, should) — The system must let a travel advisor combine multiple travel products into one package.

## How to build it

Implement exactly what the acceptance lines describe for this story, and nothing that belongs to another one.

## Failure paths you must handle


## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given an advisor selects multiple travel products, when they create a package, then the system combines them into a single offering.
- [x] Given an advisor tries to combine incompatible products, when they attempt to save, then the system displays an error message.
- [x] Trust: The system logs all package creation and modification details in the audit trail.

When every box above is ticked, stop and show the demo.
