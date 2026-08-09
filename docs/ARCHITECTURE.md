# Architecture Documentation

## Project structure

This repository uses a small, course-appropriate architecture:

- `src/`
  - Primary application source code
  - Contains feature modules and implementation logic
  - Does not contain tests or generated artifacts

- `tests/`
  - Automated verification layer
  - Contains unit, integration, or future E2E tests
  - Does not contain production source code

- `docs/`
  - In-repo documentation that ships with the project
  - Contains architecture notes, README content, and design documentation

- `scripts/`
  - Repo-level operational scripts and automation helpers
  - Contains one-off or reusable project utilities
  - Does not contain application source or formal tests

- `PROGRESS.md`
  - Progress tracking and session evidence
  - Must be updated for every code-related change per root `CLAUDE.md`

## Approved foundation

The approved foundation preserves existing work and adds only the approved structure:

- `scripts/` created for operational automation
- `src/week3/` created as the home for the first Week 3 component

## Verification

- Existing source remains in place
- No protected or legacy folders were touched
- No dependencies were installed
- No product feature code was built

## Next step guidance

For the Week 3 component:

- add implementation code under `src/week3/`
- add tests for that work under `tests/`
- document the feature if needed under `docs/`
- update `PROGRESS.md` with verification evidence for the work
