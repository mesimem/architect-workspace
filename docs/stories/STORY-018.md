# STORY-018 — STORY-018: Centralize all bookings and manage their statuses

As an operations manager, I want to centralize all bookings and manage their statuses, so that I can efficiently oversee operations.

**Release:** r3 · AI Assistance and Supplier Management (weeks 4–4)
**Owner:** Travel Advisor
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-020** (Functional, should) — The system must let an operations manager centralize all bookings and manage their statuses.

## How to build it

Implement exactly what the acceptance lines describe for this story, and nothing that belongs to another one.

## Failure paths you must handle


## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a new booking is created, when the manager views the booking dashboard, then the system displays the booking with its current status.
- [ ] Given a booking status is updated, when the manager saves the changes, then the system reflects the updated status in the dashboard.
- [ ] Trust: The system logs all booking status changes in the audit trail.

When every box above is ticked, stop and show the demo.
