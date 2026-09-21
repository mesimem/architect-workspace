#!/usr/bin/env bash
# PreToolUse guard for Bash calls: no commit without a green test suite.
#
#   exit 0 -> allow the tool call
#   exit 2 -> veto it; stderr is the reason Claude is shown
#
# Scope is deliberately narrow: this hook is INVISIBLE for every command that
# is not a git commit. It does not police force-push or rm; that is
# catastrophic-guard.sh, which is registered alongside this one.
#
# Two failure philosophies, on purpose, and they differ:
#   - Cannot read the payload      -> FAIL OPEN. A malformed envelope must not
#                                     brick the session.
#   - Is a commit, tests cannot run -> FAIL CLOSED. A gate that passes when it
#                                     could not actually check is the vacuous
#                                     gate this repo already shipped once: the
#                                     old /ship mypy step exited 2 before
#                                     checking a line and looked like a pass.
#                                     Use SKIP_COMMIT_GUARD=1 to override.

set -uo pipefail

payload=$(cat)

# Extract .tool_input.command, then normalise in two steps:
#   1. newline -> ";"  A multi-line command is several commands. Collapsing
#      newlines into spaces first is what let `VAR=x\ngit commit` slip past
#      this guard: the "git" ended up preceded by ")" instead of a separator.
#   2. collapse remaining whitespace, so the pattern below only has to reason
#      about single spaces.
# node, because jq is not installed here.
cmd=$(node -e '
  let raw = "";
  try { raw = JSON.parse(process.argv[1])?.tool_input?.command ?? ""; } catch {}
  process.stdout.write(
    String(raw).replace(/[\r\n]+/g, "; ").replace(/\s+/g, " ").trim()
  );
' "$payload" 2>/dev/null) || exit 0

# --- 1. not a git commit: be invisible ---------------------------------------
[ -z "$cmd" ] && exit 0

# Anchored to command position so a mention is less likely to trip it.
#   Matches: git commit            git commit -m x        git -c k=v commit
#            cd x && git commit    true; git commit       FOO=1 git commit
#            VAR=$(x)\ngit commit  (newline became a separator above)
#   Ignores: git commit-tree       (trailing space-or-end is required)
#            echo "git commit"     (preceded by a quote, not a separator)
#            npm test, git diff, git add, anything else
#
# KNOWN RESIDUAL, and it is a text matcher not a shell parser: a single-line
# assignment whose value contains a space -- VAR=$(date +%s) git commit --
# still slips past, because the assignment prefix below stops at the first
# space. The newline rule above covers the multi-line form, which is the shape
# that actually occurs. Closing the rest needs real shell parsing; the honest
# belt-and-braces is a deny rule in settings.json, which cannot be out-regexed.
sep='[;&|)]'
assign='([A-Za-z_][A-Za-z0-9_]*=[^ ]* )*'
commit_re="(^|${sep} )${assign}git ([^;&|]* )?commit( |\$)"
[[ $cmd =~ $commit_re ]] || exit 0

# --- 2. explicit operator override -------------------------------------------
if [ "${SKIP_COMMIT_GUARD:-}" = "1" ]; then
  echo "commit-guard: SKIPPED via SKIP_COMMIT_GUARD=1 — tests were not run." >&2
  exit 0
fi

# --- 3. it is a commit: run the project's real test command ------------------
# Declared in package.json as:
#   "test": "node --test \"backend/**/*.test.js\" \"tests/**/*.test.js\""
# Invoked through npm so this hook keeps working if that script changes.
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
log="${TMPDIR:-/tmp}/commit-guard-$$.log"

if ! command -v npm >/dev/null 2>&1; then
  echo "commit-guard: BLOCKED — npm not on PATH, so 'npm test' could not run. Fix the environment or set SKIP_COMMIT_GUARD=1." >&2
  exit 2
fi

if ! (cd "$root" && npm test) >"$log" 2>&1; then
  # One line to stderr, as the contract requires. Counts come from node's
  # summary block; the full output stays in the log for diagnosis.
  # Do NOT anchor on the leading glyph: node prefixes its summary with a
  # multi-byte "i" (U+2139), which a byte-mode grep '.' will not match.
  fail=$(grep -Eo 'fail [0-9]+' "$log" | grep -Eo '[0-9]+' | tail -1)
  pass=$(grep -Eo 'pass [0-9]+' "$log" | grep -Eo '[0-9]+' | tail -1)
  first=$(grep -m1 -E '^not ok|✖' "$log" | sed 's/^[^a-zA-Z]*//' | cut -c1-80)
  echo "commit-guard: BLOCKED — npm test failed (${fail:-?} failing, ${pass:-?} passing)${first:+; first failure: $first}. Full output: $log" >&2
  exit 2
fi

# --- 4. green: allow the commit ----------------------------------------------
rm -f "$log"
exit 0
