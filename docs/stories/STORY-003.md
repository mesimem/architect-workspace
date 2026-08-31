# STORY-003 — Flag uncertain requests for advisor review

As a travel advisor, I want uncertain customer requests flagged, so that I can review and assist them.

**Release:** r0 · Initial MVP (weeks 1–1)
**Owner:** Travel Advisor
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-005** (Safety, must) — The system must flag uncertain customer requests for travel advisor review.

## How to build it

Implement request processing logic to identify and flag unclear requests for review.

## Failure paths you must handle

- Unclear request not flagged
- Flagged request not logged
- Advisor notification failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a customer makes an unclear request, when the system processes it, then it flags the request for advisor review.
- [x] Given a customer provides complete information, when the system processes it, then it does not flag the request.
- [x] Trust: The system logs all flagged requests for audit.

When every box above is ticked, stop and show the demo.
