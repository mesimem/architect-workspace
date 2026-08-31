# STORY-010 — Manage supplier information

As a travel advisor, I want to manage supplier information, so that I can maintain accurate records.

**Release:** r3 · AI Assistance and Supplier Management (weeks 4–4)
**Owner:** Travel Advisor
**Blocked by:** STORY-007

## The requirement this satisfies

- **REQ-012** (Functional, must) — The system must track supplier information including contracts and rates.

## How to build it

Develop supplier management module for adding and updating supplier details.

## Failure paths you must handle

- Supplier not added
- Data mismatch
- Update failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a supplier is added, when details are saved, then it appears in the supplier list.
- [ ] Given a supplier is updated, when changes are saved, then the system reflects the updates.
- [ ] Trust: The system logs all supplier data changes.

When every box above is ticked, stop and show the demo.
