---
description: Test, format, and draft a PR for the current change
argument-hint: "[pr-title]"
allowed-tools:
  - Bash
  - Read
---

# /ship — Prepare a change for PR

Validate the current working-tree state, stage files, and draft a PR description.

## Step 1: Validate with type checking

Run mypy on all Python code:

```
python -m mypy mcp/ scripts/
```

**If mypy fails:** Stop. Report the errors and do not continue.

**Why:** Type checking is the first gate. If it fails, the change is not valid. Step 1 is allowed to say no.

## Step 2: Read the changes

Examine the files that have been modified. Understand what they now do and why.

**Files to read:** check `git status` output for modified files. Read each one to understand the intent.

## Step 3: Stage the changes

After validation passes, stage all modified files:

```
git add .
```

## Step 4: Draft the PR description

Read the staged diff:

```
git diff --cached
```

Write a PR title and description with this structure:

**Title:** `$ARGUMENTS` (whatever was typed after `/ship`)

**Body:**
```
## Summary
- [One bullet per logical change]
- [What the code now does, not what was changed]

## Test Evidence
- [Quote the line from mypy showing "0 errors" or similar validation pass]

## Risk
- [One sentence: what could go wrong, and why the diff mitigates it OR why the risk is acceptable]
```

If the diff is large or touches multiple subsystems, add a **Files** section listing them.

---

## Example

User types: `/ship docs: add HTTP endpoint explanation`

Output:

```
## Summary
- mcp-server/README.md: Added HTTP endpoint address and explained "Bad Request" browser behavior
- mcp-server/src/server.py: Implemented HTTP server listening on port 8000
- scripts/score_prompt.py: Updated batch mode handler for scoring multiple prompts

## Test Evidence
- `Found 0 errors in 0 files` (mypy validation passed)

## Risk
- HTTP server is localhost-only (127.0.0.1), not exposed to the network.
  Intentional until a separate network-access story ships.
```
