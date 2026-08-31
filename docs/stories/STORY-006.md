# STORY-006 — Implement role-based permissions

As an admin, I want role-based permissions, so that users have appropriate access levels.

**Release:** r1 · Customer Portal and Security (weeks 2–2)
**Owner:** System Administrator
**Blocked by:** STORY-001

## The requirement this satisfies

- **REQ-008** (Safety, must) — The system must support secure authentication and role-based permissions.

## How to build it

Implement role-based access control for different user roles.

## Failure paths you must handle

- Unauthorized access
- Permission escalation
- Role assignment error

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a user logs in, when they have admin rights, then they access admin features.
- [ ] Given a user logs in, when they have customer rights, then they access customer features only.
- [ ] Trust: The system logs all access attempts and changes in permissions.

When every box above is ticked, stop and show the demo.
