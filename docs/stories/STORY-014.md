# STORY-014 — Implement CRM for tracking leads, customers, and booking history

As a sales manager, I want a CRM to track leads, customers, and booking history, so that I can manage relationships effectively.

**Release:** r1 · Customer Portal and Security (weeks 2–2)
**Owner:** Development Team
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-006** (Functional, must) — The system must provide a CRM to track leads, customers, and booking history.

## How to build it

Develop CRM features to manage leads, customers, and booking history with audit logging.

## Failure paths you must handle

- Data entry error
- Lead duplication
- Unauthorized data access

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a new lead, when it is added to the CRM, then it should be visible in the lead list.
- [ ] Given a customer booking, when it is completed, then it should update the customer's booking history.
- [ ] Trust: Given any CRM entry, when it is modified, then an audit log entry must be created.

When every box above is ticked, stop and show the demo.
