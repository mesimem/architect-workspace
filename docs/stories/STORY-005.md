# STORY-005 — Implement secure customer portal

As a customer, I want a secure portal to manage my trips, so that I can access my travel details safely.

**Release:** r1 · Customer Portal and Security (weeks 2–2)
**Owner:** Customer Support
**Blocked by:** STORY-001

## The requirement this satisfies

- **REQ-007** (Functional, must) — The system must allow customers to view and manage their itineraries through a secure portal.

## How to build it

Develop secure login and portal access for customers to view and manage trips.

## Failure paths you must handle

- Incorrect login
- Session timeout
- Unauthorized access

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a customer logs in, when they enter correct credentials, then they access their portal.
- [ ] Given a customer enters incorrect credentials, when they try to log in, then the system denies access.
- [ ] Trust: The system logs all login attempts for security audit.

When every box above is ticked, stop and show the demo.
