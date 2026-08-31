# STORY-002 — Create a dedicated African travel section

As a customer, I want to explore African travel options, so that I can plan a specialized trip to Africa.

**Release:** r0 · Initial MVP (weeks 1–1)
**Owner:** Travel Advisor
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-002** (Functional, must) — The system must support a major section dedicated to African travel, including safaris and cultural experiences.

## How to build it

Develop African travel section with safari details and CRM logging for interactions.

## Failure paths you must handle

- Unsupported destination
- Missing safari details
- System timeout

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a customer navigates to the African section, when they select a safari, then detailed safari information is displayed.
- [x] Given a customer selects an unsupported destination, when they try to view details, then the system shows a message to contact an advisor.
- [x] Trust: The system logs customer interactions with the African section.

When every box above is ticked, stop and show the demo.
