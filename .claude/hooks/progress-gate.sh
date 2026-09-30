#!/usr/bin/env bash
# PreToolUse guard for Bash calls: enforce CLAUDE.md's PROGRESS.md hard gate.
#
# CLAUDE.md, "PROGRESS.md update rule (HARD GATE, ENFORCED NOW)", rule 3:
#   "Every commit that touches /backend, /frontend, /scripts, /nginx, or
#    /directives must also touch PROGRESS.md. If it doesn't, the change is
#    incomplete."
#
#   exit 0 -> allow the tool call
#   exit 2 -> veto it; stderr is the reason Claude is shown
#
# Invisible for everything that is not a git commit, for the same reason as
# commit-guard.sh: a hook that fires when it should not gets commented out,
# and then it protects nothing.
#
# FAIL OPEN on an unreadable payload -- a malformed envelope must not brick the
# session. FAIL CLOSED on a gated commit with no PROGRESS.md entry, which is
# the whole point.
#
# Override: SKIP_PROGRESS_GATE=1, for the documented catch-up case where
# CLAUDE.md permits a single end-of-session entry covering earlier work.

set -uo pipefail

payload=$(cat)

# Newline -> "; " BEFORE collapsing whitespace: a multi-line command is several
# commands, and flattening newlines into spaces is what let an earlier guard in
# this repo be bypassed by `VAR=x\ngit commit`.
cmd=$(node -e '
  let raw = "";
  try { raw = JSON.parse(process.argv[1])?.tool_input?.command ?? ""; } catch {}
  process.stdout.write(
    String(raw).replace(/[\r\n]+/g, "; ").replace(/\s+/g, " ").trim()
  );
' "$payload" 2>/dev/null) || exit 0

[ -z "$cmd" ] && exit 0

# Same matcher as commit-guard.sh: tolerate leading VAR=value assignments and
# accept ")" as a separator. Ignores `git commit-tree` and quoted mentions.
sep='[;&|)]'
assign='([A-Za-z_][A-Za-z0-9_]*=[^ ]* )*'
commit_re="(^|${sep} )${assign}git ([^;&|]* )?commit( |\$)"
[[ $cmd =~ $commit_re ]] || exit 0

if [ "${SKIP_PROGRESS_GATE:-}" = "1" ]; then
  echo "progress-gate: SKIPPED via SKIP_PROGRESS_GATE=1 -- no PROGRESS.md entry was required." >&2
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root" || exit 0

# What is actually staged. Not the working tree -- the index is what commits.
staged=$(git diff --cached --name-only 2>/dev/null) || exit 0
[ -z "$staged" ] && exit 0   # nothing staged; git will refuse on its own

# The five gated paths, verbatim from CLAUDE.md. Note that only backend/ and
# scripts/ currently exist in this repo; the other three are kept because the
# rule names them and a folder can reappear.
gated=$(printf '%s\n' "$staged" | grep -E '^(backend|frontend|scripts|nginx|directives)/' || true)
[ -z "$gated" ] && exit 0

if printf '%s\n' "$staged" | grep -qx 'PROGRESS.md'; then
  exit 0
fi

count=$(printf '%s\n' "$gated" | wc -l | tr -d ' ')
first=$(printf '%s\n' "$gated" | head -1)
echo "progress-gate: BLOCKED -- ${count} staged file(s) under a gated path (e.g. ${first}) but PROGRESS.md is not staged. CLAUDE.md makes this a hard gate: append an entry with a Session ID and verification evidence on the same line as the [x], then stage PROGRESS.md. Override with SKIP_PROGRESS_GATE=1 only for the documented catch-up case." >&2
exit 2
