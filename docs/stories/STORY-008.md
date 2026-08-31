# STORY-008 — Support group travel bookings

As a group organizer, I want to book travel for multiple people, so that I can manage a group trip efficiently.

**Release:** r2 · Quotation and Group Travel (weeks 3–3)
**Owner:** Travel Advisor
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-010** (Functional, must) — The system must handle group travel bookings with shared itinerary information.

## How to build it

Implement group booking functionality with shared itinerary and CRM logging.

## Failure paths you must handle

- Incomplete group details
- Payment issues
- Booking confirmation failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a group booking is initiated, when details are complete, then the system confirms the booking for all members.
- [ ] Given a group booking is incomplete, when submitted, then the system prompts for missing information.
- [ ] Trust: The system logs all group booking transactions.

When every box above is ticked, stop and show the demo.
