# STORY-007 — Generate professional quotes for customers

As a travel advisor, I want to generate professional quotes, so that customers receive clear and detailed pricing.

**Release:** r2 · Quotation and Group Travel (weeks 3–3)
**Owner:** Travel Advisor
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-009** (Functional, must) — The system must generate professional quotes and itineraries for customers.

## How to build it

Develop quote generation system with customer-friendly output and internal logging.

## Failure paths you must handle

- Incorrect pricing
- Quote not saved
- Customer view error

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a quote is generated, when a customer views it, then it displays without internal costs.
- [ ] Given a quote is modified, when it is saved, then the system updates the customer view.
- [ ] Trust: The system logs all quote generations and modifications.

When every box above is ticked, stop and show the demo.
