---
description: Run the real gates, stage on green, and draft a PR description
argument-hint: "[pr-title]"
allowed-tools:
  - Bash(npm test:*)
  - Bash(npm run typecheck:*)
  - Bash(git diff:*)
  - Bash(git add:*)
---

# /ship — Prepare a change for PR

Validate the working tree against this project's real gates, stage what passed, and
draft a PR description. **This command cannot commit and cannot push.** `git commit`
and `git push` are absent from `allowed-tools` above, so the irreversible, outward-facing
step stays a human decision. Staging is reversible with `git restore --staged`; a push is
not, and `commit-guard.sh` vetoes the force-push needed to retract one.

---

## Step 1: Run the tests — this step is allowed to say no

```
npm test
```

Runs `node --test "backend/**/*.test.js" "tests/**/*.test.js"` — 17 assert-based files
across `backend/src/**` and `tests/`. No dependency install is needed; the suite uses
only node's built-in runner.

**If any test fails:** STOP. Do not format, do not stage, do not draft anything.
Report, in this order:

1. The name of each failing test file, exactly as node prints it.
2. The assertion message and the expected-versus-actual values for each failure.
3. The `ℹ pass` / `ℹ fail` counts from the summary block.

Then stop and say plainly that the change is not ready. Do not offer a fix in the same
breath unless asked — the useful output of a red gate is the evidence, not a patch.

**Why:** a test suite that is consulted but not obeyed is decoration. Step 1 has veto power.

## Step 2: Typecheck — the second real gate

```
npm run typecheck
```

Four separate mypy invocations, one per directory. They are separate deliberately:
`mcp/booking-desk`, `mcp/destination-catalog` and `mcp/trip-quotes` each contain a
`server.py`, and hyphenated directory names cannot be Python packages, so a single
combined invocation exits 2 on `Duplicate module named "server"` without checking
anything at all.

**If mypy reports an error:** STOP, exactly as in step 1. Quote the file, line and error
code verbatim.

**Note on formatting:** there is no format step in this command because **this project
has no formatter**. No `.prettierrc`, no `eslint.config.*`, no `[tool.black]` or
`[tool.ruff]` in any `pyproject.toml`, and none of prettier, black, ruff or autopep8 is
installed. Do not invent one, and do not run `npx prettier --write` — it would fail on a
missing package, and on success it would rewrite the whole repository. If a formatter is
ever added, it belongs here as step 3 with its real command.

## Step 3: Read the changes, then stage them

Only after both gates are green.

First read what actually changed:

```
git diff
```

The diff is your **only** source here — the `Read` tool is deliberately not in
`allowed-tools`, so work from the hunks, not from opening files. Read them properly:
understand what the code now does and why. You are about to describe this change to a
reviewer, and you cannot do that from filenames. If the diff is genuinely too large to
reason about, say so and ask for the change to be split rather than guessing at a summary.

Then stage **explicit paths only**:

```
git add <path> <path> ...
```

**Never `git add .` or `git add -A`.** Two reasons, both live in this repo. First, other
Claude Code sessions run against the same working tree and their unstaged work sits
beside yours — `mcp-server/src/server.py` and `scripts/score_prompt.py` have carried
in-flight edits from other sessions for days. Staging them commits work you did not do
and cannot describe. Second, `CLAUDE.md` requires committing only the files you changed,
for exactly that reason.

If you are unsure whether a modified file is yours, leave it unstaged and say so.

## Step 4: Draft the PR description

Read the staged diff:

```
git diff --cached
```

Then write the description. **Title:** `$ARGUMENTS` — whatever was typed after `/ship`.

```
## Summary
- [One bullet per logical change: what the code now does, not what you did to it]
- [Name the file only when it clarifies the change]

## Test Evidence
- [The real summary line from step 1, quoted verbatim — e.g. `ℹ tests 17  ℹ pass 17  ℹ fail 0`]
- [The real mypy line from step 2, quoted verbatim — e.g. `Success: no issues found in 3 source files`]

## Risk
- [One or two sentences: what could go wrong, and either why the diff mitigates it
   or why the risk is acceptable. If the change has a genuine unmitigated risk, say
   so — a Risk section that always reads "low" is not being read.]
```

Add a **Files** section listing paths if the diff spans more than one subsystem.

### Rules for Test Evidence

- **Quote real output.** Paste the line the runner actually printed. Never write
  "all tests pass" as a substitute, and never reconstruct a plausible-looking summary
  line from memory.
- **If a gate was skipped, say it was skipped.** Do not report a skipped gate as green.
- **Counts must match what ran.** If the suite printed 17, the evidence says 17.

### Finally

Print the drafted description and stop. Then tell the user, in one line, that nothing has
been committed or pushed and that both remain theirs to run.

---

## Example

User types: `/ship ci: add GitHub Actions workflow and declare verification commands`

```
## Summary
- .github/workflows/ci.yml: CI now runs on every branch and PR — a node job for the
  assert-based suite and a python job for the mypy gate.
- package.json: the repo declares `test`, `typecheck` and `verify`, so its own
  verification is discoverable instead of folklore.
- .gitignore: tmp/ and __pycache__/ are excluded, so a wide stage cannot sweep in
  101 scratch files.

## Test Evidence
- `ℹ tests 17  ℹ pass 17  ℹ fail 0` (npm test, exit 0, node v24.18.0)
- `Success: no issues found in 3 source files` (npm run typecheck, booking-desk)

## Risk
- The workflow is unverified on GitHub's runners until it runs there once; it was
  validated only structurally and locally. Blast radius is a red badge, not a
  broken build — CI adds a signal where there was none, and cannot regress
  anything that was previously passing.

## Files
- .github/workflows/ci.yml, package.json, .gitignore, PROGRESS.md
```
