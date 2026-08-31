# STORY-011 — Process customer payments and track balances

As a customer, I want to make payments and track my balance, so that I can manage my travel expenses.

**Release:** r4 · Payments and Analytics (weeks 5–6)
**Owner:** Finance Manager
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-013** (Functional, must) — The system must allow customers to make payments and track their remaining balances.

## How to build it

Implement payment processing and balance tracking with integration to accounting software.

## Failure paths you must handle

- Payment failure
- Balance not updated
- Transaction not logged

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a payment is made, when processed, then the system updates the balance.
- [ ] Given a payment fails, when retried, then the system processes it again or shows an error.
- [ ] Trust: The system logs all payment transactions.

When every box above is ticked, stop and show the demo.
