# STORY-019 — STORY-019: Run email campaigns to customer segments

As a sales manager, I want to send email campaigns to segments of customers, so that I can market trips to the right people.

**Release:** r4 · Payments and Analytics (weeks 5–6)
**Owner:** Travel Advisor
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-021** (Functional, should) — The system must let a sales manager send email campaigns to segments of customers.

## How to build it

Implement exactly what the acceptance lines describe for this story, and nothing that belongs to another one.

## Failure paths you must handle


## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given customers with booking history, when a sales manager defines a segment, then the system lists the customers who match it.
- [ ] Given a campaign is sent to a segment, when a customer has opted out or a send fails, then the system skips that customer and reports why.
- [ ] Trust: The system logs every campaign send in the audit trail, and re-sending a campaign never emails the same customer twice.

When every box above is ticked, stop and show the demo.
