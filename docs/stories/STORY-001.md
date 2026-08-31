# STORY-001 — Book a complete trip including flight, hotel, and safari

As a customer, I want to book a complete trip including flight, hotel, and safari, so that I can manage my travel in one place.

**Release:** r0 · Initial MVP (weeks 1–1)
**Owner:** Travel Advisor
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-001** (Functional, must) — The system must allow customers to book flights, hotels, and safaris as part of a single trip.

## How to build it

Implement booking flow for flights, hotels, and safaris. Ensure CRM integration for transaction logging.

## Failure paths you must handle

- Unavailable dates
- Payment failure
- Invalid customer details

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a customer selects a flight, hotel, and safari, when they proceed to checkout, then the system confirms the booking as one trip.
- [ ] Given a customer selects unavailable dates, when they try to book, then the system shows an error message.
- [ ] Trust: The system logs the booking transaction in the CRM.

When every box above is ticked, stop and show the demo.
