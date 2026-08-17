---
name: progress-log-entry
description: Use when a code, config, prompt, or directive change in this repo (touching backend/, frontend/, scripts/, nginx/, or directives/) is complete and needs to be logged, per CLAUDE.md's PROGRESS.md hard gate — e.g. finishing an implementation task, landing a bug fix, or editing a directive. Writes a correctly formatted PROGRESS.md entry with session ID, verification evidence, and files touched. Do NOT use for Mandrill sends, Basecamp ticket creation, ad-hoc data pulls, memory file writes, or dry-run/discovery scripts that don't ship code — CLAUDE.md explicitly excludes those from PROGRESS.md.
---

# Progress Log Entry

Append a compliant `PROGRESS.md` entry for a completed change, without disturbing other sessions' entries.

## When this Skill applies

Trigger on:
- Finishing any change that touches `backend/`, `frontend/`, `scripts/`, `nginx/`, or `directives/`
- The moment right before a change would be called "done" in any sense

Do **not** trigger on:
- Emails sent, Basecamp tickets created, or other actions with no shipped code
- Discovery/dry-run script output that isn't landing in the repo
- Memory file additions
- Deploy commands for code that's already tracked in an existing entry

## Inputs

1. **Session ID** — required. Must already be minted this session in the format `CC-<YYYYMMDD>-<4 alphanumerics>`. If none exists yet, mint one per CLAUDE.md's Session Start Protocol before proceeding — do not fabricate one here.
2. **Task name** — the checklist item this entry belongs under.
3. **What changed** — one line, plain language.
4. **Verification evidence** — required. A concrete artifact: a test name and result, a deploy URL, `tsc --noEmit` passing, or an explicit user confirmation. "Should work" or "looks correct" is not evidence.
5. **Files touched** — explicit list, not a directory glob.
6. **Notes** — only if there's a blocker, deviation, or non-obvious decision worth flagging.

## Procedure

1. Confirm `PROGRESS.md` exists at the repo root. If it doesn't, create it before doing anything else.
2. **Re-read the tail of `PROGRESS.md` immediately before writing** — another session may have appended since it was last read. Never anchor the edit on stale content.
3. Confirm verification evidence is concrete (per Inputs above). If it isn't, the entry isn't ready — go get real evidence before logging.
4. Append the entry after the current last line, under the relevant task heading, in the format below.
5. Never edit, reformat, or "clean up" an entry that carries a different Session ID.

## Output format

```markdown
- [x] <task name>
  - Date: YYYY-MM-DD
  - Session: CC-<YYYYMMDD>-<id>
  - What changed: <one line>
  - Verification: <test name | deploy URL | "user confirmed" | "TypeScript passes">
  - Notes: <only if blocker, deviation, or non-obvious decision>
```

## Constraints

- Never mark an entry `[x]` without verification evidence on the same line.
- Only ever touch entries carrying your own Session ID.
- If the change spans multiple unrelated tasks, write one entry per task rather than merging them into a single vague line.
