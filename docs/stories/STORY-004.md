# STORY-004 — Enable integration with accounting software for transaction logging

As a travel advisor, I want the system to integrate with accounting software, so that all transactions are logged and auditable.

**Release:** r0 · Initial MVP (weeks 1–1)
**Owner:** Development Team
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-004** (Constraint, must) — The system must integrate with accounting software for financial tracking.
- **REQ-017** (Safety, must) — The system must maintain audit logs for all transactions and changes.

## How to build it

Ensure integration with the specified accounting software API for transaction logging and audit trail creation.

## Failure paths you must handle

- API connection failure
- Incorrect transaction data format
- Unauthorized access attempt

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a completed transaction, when it is processed, then it should be logged in the accounting software.
- [x] Given a failed transaction, when it is attempted, then it should not be logged in the accounting software.
- [x] Trust: Given any transaction, when it is processed, then an audit log entry must be created.

When every box above is ticked, stop and show the demo.
