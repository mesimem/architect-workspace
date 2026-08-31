# STORY-015 — Support creation of detailed safari products with itineraries and pricing

As a product manager, I want to create detailed safari products with itineraries and pricing, so that I can offer comprehensive travel packages.

**Release:** r2 · Quotation and Group Travel (weeks 3–3)
**Owner:** Development Team
**Blocked by:** STORY-007

## The requirement this satisfies

- **REQ-014** (Functional, must) — The system must support the creation of detailed safari products with itineraries and pricing.

## How to build it

Develop a module for creating and managing safari products with detailed itineraries and pricing.

## Failure paths you must handle

- Incorrect pricing data
- Itinerary conflicts
- Unauthorized product modification

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a new safari product, when it is created, then it should include itineraries and pricing.
- [ ] Given an existing safari product, when its itinerary is updated, then the changes should be reflected immediately.
- [ ] Trust: Given any safari product, when it is created or updated, then an audit log entry must be created.

When every box above is ticked, stop and show the demo.
