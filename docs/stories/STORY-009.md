# STORY-009 — AI suggests trip ideas to customers

As a customer, I want AI to suggest trip ideas, so that I can explore travel options easily.

**Release:** r3 · AI Assistance and Supplier Management (weeks 4–4)
**Owner:** AI Developer
**Blocked by:** STORY-007

## The requirement this satisfies

- **REQ-011** (Functional, should) — The system must support AI capabilities to assist customers in exploring destinations and generating trip ideas.

## How to build it

Develop AI module to process customer preferences and suggest trips.

## Failure paths you must handle

- No suggestions generated
- Irrelevant suggestions
- AI processing error

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a customer provides preferences, when AI processes them, then it suggests relevant trips.
- [ ] Given a customer provides no preferences, when AI processes, then it suggests popular trips.
- [ ] Trust: The system logs all AI suggestions for review.

When every box above is ticked, stop and show the demo.
