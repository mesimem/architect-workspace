#!/usr/bin/env bash
# Test matrix for catastrophic-guard.sh. Run it with:  bash .claude/hooks/catastrophic-guard.test.sh
#
# WHY THIS FILE EXISTS. This repo has already shipped a security control that
# "sat in the repo looking installed while protecting nothing" (see the
# CC-20260915-h4r8 entry in PROGRESS.md, a settings.json key that did not exist
# in the schema). A guard with no test is indistinguishable from a guard with a
# typo, because both exit 0 on the happy path. Every rule in the guard gets a
# must-BLOCK case and a near-miss must-ALLOW case here.
#
# THE CASES LIVE IN THIS FILE, NOT IN A BASH COMMAND, and that is not a style
# choice - the guard inspects the command string of every Bash call, so a probe
# that quotes its own dangerous cases inline gets vetoed by the very hook it is
# trying to test. Writing them here means the command that runs the test is
# just `bash .claude/hooks/catastrophic-guard.test.sh`, which contains nothing
# the guard objects to.
#
# NOT wired into `npm test`: that runs node --test over *.test.js, and this is
# bash testing a bash hook. Run it by hand after touching the guard.

# The guard sits next to this file. Resolved from $0 rather than from a working
# directory, so the test runs correctly from anywhere.
GUARD="$(cd "$(dirname "$0")" && pwd)/catastrophic-guard.sh"
[ -f "$GUARD" ] || { echo "cannot find $GUARD"; exit 1; }

fail=0

probe() {
  expected=$1
  command=$2
  payload=$(node -e 'process.stdout.write(JSON.stringify({tool_input:{command:process.argv[1]}}))' "$command")
  printf '%s' "$payload" | bash "$GUARD" >/dev/null 2>&1
  code=$?
  if [ "$code" -eq 2 ]; then actual=BLOCK; else actual=allow; fi
  if [ "$actual" = "$expected" ]; then mark="ok  "; else mark="FAIL"; fail=$((fail + 1)); fi
  printf '%s  %-6s %s\n' "$mark" "$actual" "$command"
}

echo "--- must BLOCK ---"
probe BLOCK 'git push --mirror'
probe BLOCK 'git push origin --delete feature-x'
probe BLOCK 'git push origin -d feature-x'
probe BLOCK 'git push --delete origin feature-x'
probe BLOCK 'git push origin :old-branch'
probe BLOCK 'cd x && git push origin --delete y'
probe BLOCK 'git push --force origin main'
probe BLOCK 'git push -f origin main'

echo "--- must ALLOW ---"
probe allow 'git push origin mcp-observability'
probe allow 'git push'
probe allow 'git push --dry-run origin main'
probe allow 'git push --force-with-lease origin main'
probe allow 'git push -u origin feature'
probe allow 'git push origin HEAD'
probe allow 'echo "never delete a remote branch"'
probe allow 'npm test'
probe allow 'git commit -m x'

# The rm-root rule predates the push rules and had no test of its own. Its
# near-misses matter more than its hits: a guard that also blocks `rm -rf
# ./build` gets switched off by the first person it inconveniences.
echo "--- rm root: must BLOCK ---"
probe BLOCK 'rm -rf /'
probe BLOCK 'rm -rf /*'
probe BLOCK 'cd x && rm -rf / --no-preserve-root'
probe BLOCK 'sudo rm -rf /'

echo "--- rm root: must ALLOW ---"
probe allow 'rm -rf /tmp/scratch'
probe allow 'rm -rf ./build'
probe allow 'rm -rf node_modules'
probe allow 'rm tmp/probe.sh'

echo
if [ "$fail" -eq 0 ]; then
  echo "catastrophic-guard: all cases correct"
else
  echo "catastrophic-guard: $fail FAILING"
  exit 1
fi
