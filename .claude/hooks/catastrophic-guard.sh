#!/usr/bin/env bash
# PreToolUse guard for Bash calls.
#   exit 0 -> allow the tool call
#   exit 2 -> veto it; stderr is the reason Claude is shown
#
# Fails open: an unreadable payload allows the call rather than bricking the
# session. This is a tripwire for the two catastrophic cases, not a sandbox.

payload=$(cat)

# Extract .tool_input.command and collapse whitespace so the patterns below
# only have to reason about single spaces. node, because jq is not installed.
cmd=$(node -e '
  let raw = "";
  try { raw = JSON.parse(process.argv[1])?.tool_input?.command ?? ""; } catch {}
  process.stdout.write(String(raw).replace(/\s+/g, " ").trim());
' "$payload")

[ -z "$cmd" ] && exit 0

# --- force push --------------------------------------------------------------
# Blocks:  git push --force / -f          and  foo && git push --force
# Allows:  git push --force-with-lease    (refuses to clobber commits you have
#          not seen, so it is the safe form and must not be caught here)
# Allows:  echo "never git push --force"  (a mention, not an invocation)
force_push='(^|[;&|] )git push [^;&|]*(--force|-f)( |$)'
if [[ $cmd =~ $force_push ]]; then
  echo "Blocked: force push rewrites upstream history. Use --force-with-lease, or push normally." >&2
  exit 2
fi

# --- destructive push forms ---------------------------------------------------
# The blanket `Bash(git push:*)` deny in settings.json was narrowed so ordinary
# branch pushes can happen; these are the forms it used to cover that still must
# not. They live HERE as well as in the deny list because a deny entry is a
# PREFIX match: "Bash(git push --delete:*)" catches `git push --delete x` and
# sails straight past `git push origin --delete x`, which is the form anyone
# would actually type. A regex can see the flag wherever it sits.
#
# Blocks:  git push --mirror          (overwrites every remote ref at once)
#          git push origin --delete x / -d x     (deletes a remote branch)
#          git push origin :x                    (the old deletion refspec)
# Allows:  git push origin my-branch
#          git push --dry-run                    (contains -d, matches nothing)
dangerous_push='(^|[;&|] )git push ([^;&|]* )?(--mirror|--delete|-d)( |$)'
if [[ $cmd =~ $dangerous_push ]]; then
  echo "Blocked: this push form deletes or overwrites remote refs. Push a branch normally." >&2
  exit 2
fi

delete_refspec='(^|[;&|] )git push [^;&|]* :[A-Za-z0-9_/.-]+( |$)'
if [[ $cmd =~ $delete_refspec ]]; then
  echo "Blocked: a colon-prefixed refspec deletes the remote branch. Push a branch normally." >&2
  exit 2
fi

# --- rm against the filesystem root ------------------------------------------
# Blocks:  rm -rf /        rm -rf /*        cd x && rm -rf / --no-preserve-root
# Allows:  rm -rf /tmp/x   rm -rf ./build   rm -rf node_modules
rm_root='(^|[;&|] )(sudo )?rm ([^/]* )?/[*]?( |$)'
if [[ $cmd =~ $rm_root ]]; then
  echo "Blocked: rm targeting the filesystem root (/) would destroy the machine." >&2
  exit 2
fi

exit 0
