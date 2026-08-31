# STORY-013 — Create customized trip proposals for travel advisors

As a travel advisor, I want to create customized trip proposals within 30 minutes, so that I can efficiently serve my clients.

**Release:** r2 · Quotation and Group Travel (weeks 3–3)
**Owner:** Development Team
**Blocked by:** STORY-008

## The requirement this satisfies

- **REQ-003** (Functional, must) — The system must enable travel advisors to create customized trip proposals within 30 minutes.

## How to build it

Develop a user interface for travel advisors to input trip details and generate proposals quickly.

## Failure paths you must handle

- Proposal generation timeout
- Incorrect trip details
- System crash during proposal creation

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a new trip request, when a travel advisor creates a proposal, then it should be completed within 30 minutes.
- [ ] Given a trip proposal, when it exceeds 30 minutes, then the advisor should be notified of the delay.
- [ ] Trust: Given any trip proposal, when it is created, then an audit log entry must be created.

When every box above is ticked, stop and show the demo.
