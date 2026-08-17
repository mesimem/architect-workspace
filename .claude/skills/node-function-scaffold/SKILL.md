---
name: node-function-scaffold
description: Use when the user wants a new small, pure JavaScript utility function added to this repo's src/weekN/ folders, following the established addNumbers pattern — e.g. "add a function that reverses a string," "scaffold a subtractNumbers function for week 3," "create a utility like addNumbers but for X." Creates both the function file and its assert-based test file in the repo's existing style, then runs the test to confirm it passes. Do NOT use for editing or refactoring an existing function (edit it directly), for backend/frontend service code under CLAUDE.md's Node/Express or React conventions, or for anything that would require an external dependency.
allowed-tools: Read, Glob, Write, Bash(node tests/*)
---

# Node Function Scaffold

Add a new pure-function module and its test to `src/week<N>/` and `tests/`, matching the conventions established by `addNumbers.js` exactly — not a generic Node.js scaffold, this repo's specific one.

## When this Skill applies

Trigger on requests to add a small, self-contained utility function to this exercise repo's `src/week<N>/` structure.

Do **not** trigger on:
- Modifying a function that already exists (that's a direct edit, not a scaffold)
- Anything destined for `backend/` or `frontend/` — those follow the Node+Express / React + TypeScript conventions in the root `CLAUDE.md`, which is a different contract entirely
- Functions that need an external package — this repo's `src/` has zero dependencies today, and adding one is a deliberate decision outside this skill's scope

## Inputs

1. **Function name** — required, `camelCase`, matches both the source filename and the exported symbol.
2. **Week folder** — which `src/week<N>/` it belongs in. If the user doesn't say, use Glob to find existing `src/week*` folders and use the highest-numbered one; ask only if none exist yet.
3. **Behavior** — what the function does and its parameters, from the user's request.

## Procedure

1. **Check for collisions.** Glob `src/week*/<name>.js` and `tests/<name>.test.js`. If either exists, stop and tell the user — this skill creates new files, it does not overwrite.
2. **Load the convention.** Read `reference/conventions.md` in this skill's directory if it hasn't been read yet this session. It documents the exact export style, test style, and assertion density this repo uses — don't improvise a different shape (no Jest, no ES modules, no framework).
3. **Fill the templates.** Use `templates/function.template.js` and `templates/test.template.js` in this skill's directory as the starting shape. Replace the placeholders with real logic and at least three `assert.strictEqual` cases: one happy path, one boundary/edge case, and one case that would catch a sign or off-by-one error — mirroring the density in `tests/addNumbers.test.js`.
4. **Write both files** with the Write tool: `src/week<N>/<name>.js` and `tests/<name>.test.js`.
5. **Run the test** with `node tests/<name>.test.js`. If it throws an `AssertionError`, fix the source file (rewrite it with Write — this skill doesn't hold an Edit permission) and rerun until it prints `<name>: all tests passed` with exit code 0.
6. **Report** both file paths and the passing test output. Do not mark anything done in `PROGRESS.md` from inside this skill — hand off to `progress-log-entry` for that, since logging is a separate concern with its own gate.

## Constraints

- Never overwrite an existing function or test file — collisions are a stop condition, not a merge.
- Never add a dependency, `import`/`export` syntax, or a test framework to make the scaffold "nicer." Match what's already there.
- This skill's tool access is intentionally narrow: it can read and glob to check conventions and avoid collisions, write the two new files, and run only `node tests/...` to verify them. It cannot edit unrelated files, run arbitrary shell commands, or touch git — scaffolding a function is not a reason to hold broader access.
