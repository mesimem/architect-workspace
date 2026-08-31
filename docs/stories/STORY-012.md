# STORY-012 — Provide analytics on revenue and bookings

As a manager, I want analytics on revenue and bookings, so that I can make informed business decisions.

**Release:** r4 · Payments and Analytics (weeks 5–6)
**Owner:** Business Analyst
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-015** (Functional, should) — The system must provide analytics on revenue, bookings, and customer data.

## How to build it

Develop analytics dashboard for revenue and booking data visualization.

## Failure paths you must handle

- Data mismatch
- Analytics not generated
- Dashboard error

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given data is available, when analytics are generated, then they display revenue and booking trends.
- [ ] Given data is incomplete, when analytics are generated, then the system highlights missing data.
- [ ] Trust: The system logs all analytics generation activities.

When every box above is ticked, stop and show the demo.
