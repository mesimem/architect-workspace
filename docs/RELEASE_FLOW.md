# Release flow: getting a finished story into the repo

Written 2026-09-30, after STORY-013 took four rounds of correction to land.
Every rule below exists because something specific went wrong; the evidence is
cited so a future reader can check whether it still applies rather than
trusting it.

## The one fact that governs everything

**The platform reads `main`.** Not your working tree, not your feature branch.

Proof: in `.colaberry/progress.json` on `main`, every verified story cites a
main-branch SHA — STORY-008 is credited to `fe7cd16` (main) and not `9c981d1`,
which is the same content on `mcp-observability`. A story sitting on a branch
shows `state: in_progress, points_awarded: null` no matter how green its CI is.

So "done" means **merged to main**. Pushing a branch is not done.

## The flow

1. **Start from main.** `git fetch origin && git checkout -b story-NNN origin/main`.
   Not from a long-lived dev branch: `main` and `mcp-observability` drifted so
   far apart this session that they had to be reconciled by hand, because
   stories had landed on main under rewritten SHAs while the originals stayed
   on the branch. Branch per story and that cannot accumulate.

2. **Build the story.** Nothing about this document changes how you write code.

3. **Run the real gates before committing.**
   ```
   npm run verify        # npm test && npm run typecheck
   ```
   Not `npm test` alone. The typecheck half is a separate gate in CI and it is
   the half that is easy to forget, because nothing in the JS suite depends on
   it.

4. **Update `.colaberry/progress.json`.** See the ownership table below.

5. **Update `PROGRESS.md`.** Re-read its tail immediately before appending —
   other instances write to the same file — and append after the current last
   line. Stamp your own session id on the entry and never edit another id's.

6. **Commit, with a real trailer.** See the template below.

7. **Push the story branch.** `git push -u origin story-NNN`. `ci.yml` runs on
   every branch, so this is where you find out on hardware you do not control.

8. **Confirm CI is green** before merging. See "Checking CI without `gh`".

9. **Merge to main.** A story branch cut from `origin/main` fast-forwards:
   ```
   git merge-base --is-ancestor origin/main origin/story-NNN   # must succeed
   git push origin story-NNN:main
   ```
   `verify.yml` is `pull_request`-only, so a direct push to main skips it. If
   you want the repo's own merge gate on the record, open a PR instead and let
   `verify.yml` run. `ci.yml` covers the push case and gates main as of
   `1bf3bb3`.

## Commit message template

```
STORY-NNN: what you did, in the imperative

Why it is built this way. The decision that carries the story, and what
would break if it were made the other way.

Verification: N/N npm test, typecheck clean, npm run verify green.

Story: STORY-NNN
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

**`Story:` and `Co-Authored-By:` must be in the SAME paragraph.** A blank line
between them means git parses only the last paragraph as trailers, so `Story:`
becomes ordinary body text. Verify any format change before trusting it:

```
$ printf 'subject\n\nbody\n\nStory: S-1\n\nCo-Authored-By: X <x@y.z>\n' | git interpret-trailers --parse
Co-Authored-By: X <x@y.z>                 <- Story: silently missing

$ printf 'subject\n\nbody\n\nStory: S-1\nCo-Authored-By: X <x@y.z>\n' | git interpret-trailers --parse
Story: S-1
Co-Authored-By: X <x@y.z>                 <- both parsed
```

STORY-007, 008 and 013 were all committed with the broken layout and were
still credited, so the platform evidently also matches the subject line. The
subject is not the documented contract, though, and getting the trailer right
costs one keystroke.

## Who owns what in `.colaberry/`

| Field | Owner | Rule |
|---|---|---|
| `stories[].criteria[].passed` | you | Set to what is actually true. A partly finished story is a real, expected state. |
| `stories[].criteria[].evidence` | you | Name the test file and what it asserts. "Works" is not evidence. |
| `stories[].files_touched`, `tests_added`, `notes` | you | Include test fixtures, not just `*.test.js`. |
| `stories[].verification.*` | **the platform** | Never write these. It sets `state`, `commit_sha`, `points_awarded`. |
| `manifest.json` | **the platform** | Never hand-edit. It holds the hash that decides whether the platform keeps syncing `plan.json`. |
| `plan.json` | **the platform** | Hand-edit it and the platform stops updating it, permanently. |

During a merge, resolve every `.colaberry/` conflict to **main's** copy. The
platform's records there are newer than any branch's, and a *merged*
`manifest.json` is not a copy the platform wrote, so it will stop trusting it.

## Checking CI without `gh`

There is no `gh` CLI and no GitHub token in this environment, so PRs cannot be
opened or merged from here — that part is a human click. CI status is readable
unauthenticated, though:

```
curl -s "https://api.github.com/repos/mesimem/architect-workspace/actions/runs?branch=BRANCH&per_page=5"
```

Read `head_sha`, `name`, `status`, `conclusion`. For per-step detail, fetch
`/actions/runs/<id>/jobs`. The `/logs` endpoint returns 403 without a token, so
job and step *conclusions* are the most that can be confirmed from here — the
literal test count in CI is not readable.

## Two shell traps that produced wrong answers this session

**1. MSYS path conversion mangles `rev:path` arguments.** In Git Bash on
Windows, `git cat-file -p origin/main:.colaberry/progress.json` is rewritten to
`origin\main;.colaberry\progress.json` and fails. Read as "file absent", this
produced a confident, wrong report that main had no `.colaberry/` directory.

```
MSYS_NO_PATHCONV=1 git cat-file -p "origin/main:.colaberry/progress.json"
```

**2. `git ls-files 'tests/**/*.test.js'` skips `tests/addNumbers.test.js`.**
Git's `**` pathspec wants an intermediate directory, so top-level matches are
missed. Compared against an `ls-tree` count on another branch, this invented a
file-count difference that did not exist. For inventories use:

```
git ls-tree -r --name-only REV | grep -E '\.test\.js$'
```

The general lesson: when a check reports something surprising about the repo,
confirm the check itself before reporting the surprise.
