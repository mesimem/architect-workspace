---
description: Read-only review of the staged diff for correctness, security and CLAUDE.md compliance
allowed-tools:
  - Bash(git diff:*)
  - Read
  - Grep
  - Glob
---

# /review — Read-only review of the staged diff

Review what is **staged** for correctness, security, and compliance with this project's
`CLAUDE.md`. Report findings. Change nothing.

## You do not edit. At all.

**Do not edit, write, create, delete, move, stage, unstage, commit, push, or reformat any
file.** Not even a one-character fix. Not even a fix you are certain about. Not even when
the change would be smaller than the sentence describing it.

`Edit`, `Write`, `git add`, `git commit` and `git push` are absent from `allowed-tools`
above, so those attempts will be refused by the harness. The refusal is the backstop, not
the plan — **do not attempt them**, because a denied tool call in the middle of a review
wastes the turn and produces a permission prompt instead of a finding.

Three specific things not to do, because they are the tempting ones:

- **Never describe a fix in the past tense.** Write "`config.py:12` should read the key
  from the environment", never "removed the hardcoded key". A reader skimming past-tense
  prose will believe the repository changed. It did not, and that false assurance is worse
  than no review at all.
- **Never apply a fix and then report it.** There is no such thing as a fix small enough.
- **Do not route around this.** `CLAUDE.md` tells you elsewhere to proceed autonomously on
  reversible low-blast-radius changes and not to ask permission for implementation detail.
  **That standing order does not apply inside this command.** A review that edits its own
  subject is no longer a review, because the diff it reports on is no longer the diff that
  was staged.

Your entire output is the findings list and the verdict line.

---

## Step 1: Read the staged diff

```
git diff --cached
```

**If nothing is staged:** say exactly that, do not review the unstaged working tree
instead, and stop. Emit `REVIEW CLEAN` only if there was genuinely nothing to review, and
say which of the two situations produced it.

Use `Read` on the surrounding file when a hunk cannot be judged from its context alone —
a diff shows you the change, not whether the function it lives in still makes sense. Use
`Grep` and `Glob` to check whether a pattern in the diff repeats elsewhere in the repo, and
to confirm a suspicious string is not already present in tracked files.

## Step 2: Scan for secrets first, before anything else

This pass runs before correctness and before style, and its findings are reported first
regardless of what else you find.

Look for, in the added lines of the diff:

- API keys, tokens, bearer values, passwords, connection strings, private keys
  (`-----BEGIN`), `.pem` / `.p12` contents, session cookies, webhook signing secrets.
- High-entropy string literals assigned to anything named like a credential:
  `key`, `secret`, `token`, `password`, `passwd`, `credential`, `auth`, `apikey`, `pat`.
- A credential in a **URL or query string** — `?api_key=`, `://user:pass@`. `CLAUDE.md`
  is explicit that credentials go in headers only.
- A credential, bearer token, or full idempotency key reaching a **log line** at any level.
- PII in logs: policyholder or customer names, addresses, VINs, payout tokens, email
  addresses, phone numbers.
- A committed `.env`, or a real value in a `.env.example`, a test fixture, or a comment
  "showing an example".

**Every one of these is `[CRITICAL]`, is listed first, and forces
`REVIEW HAS FINDINGS`** — there is no severity judgement to make and no threshold below
which a committed credential is acceptable.

For any secret found, the suggested fix is always both halves: **rotate the credential
first, because git history is permanent and it is already compromised**, then move the
value to the environment or the secret manager. A fix that only deletes the line leaves a
live credential in the history.

## Step 3: Review for correctness and security

Judge the diff on its own terms — what the code now does, what happens when it fails.

- **Failure paths.** Does an added external call carry an explicit timeout? Is every retry
  capped and jittered, never unbounded? Is there an empty `catch`, a swallowed exception,
  or a success response returned for work that did not happen?
- **Idempotency.** Does an added write carry an idempotency key that is *derived* rather
  than random, persisted *before* the side effect? Is duplicate suppression enforced by a
  database constraint rather than a check-then-act read, which races?
- **Error handling.** Is each caught exception tagged with a stable `error_class`? Generic
  `Error` is not a classification.
- **Input validation.** Is input from outside the trust boundary validated against a
  schema before use? Is anything untrusted interpolated into SQL, a shell command, a regex,
  or HTML?
- **Authorisation.** Does a new route check the session *and* the role *and* that the
  resource belongs to the caller? Does it confuse a service identity with a user identity?
- **Correctness.** Off-by-one and boundary conditions, null versus absent versus zero,
  unit mismatches on anything monetary, time-zone handling on date-only fields,
  floating-point arithmetic on money.
- **Tests.** Does a new behaviour ship with a happy-path *and* at least one failure-path
  test? Does a write test assert the exact count of the side effect, or only the status?

## Step 4: Review for CLAUDE.md compliance

Check the diff against this project's stated rules. Read `CLAUDE.md` if you need the exact
wording — quote the rule you are applying so the author can argue with it.

- **`PROGRESS.md` gate.** If the diff touches `/backend`, `/frontend`, `/scripts`,
  `/nginx` or `/directives`, it must also touch `PROGRESS.md`. A missing entry is
  `[HIGH]`. If an entry is present but marked `[x]` with no verification evidence on the
  same line, that is also `[HIGH]` — `CLAUDE.md` forbids marking complete on intent.
- **Concurrent-instance safety.** Does the diff include files that look like another
  session's in-flight work? Does it edit or re-check a `PROGRESS.md` entry carrying a
  different Session ID? Both are `[HIGH]`.
- **Scratch space.** Anything under `tmp/` is `[MEDIUM]` — `CLAUDE.md` says it is never
  committed.
- **Size limits.** Files over 500 lines or functions over 100 are `[MEDIUM]`; note the
  grandfathering rule, which says an oversize file must be split by the *next* change that
  touches it.
- **Typing.** `any` without a written justification comment is `[MEDIUM]`. Untyped inputs
  or ambiguous outputs on a public surface are `[HIGH]`.
- **Structured logging.** Unstructured `console.log` on a production path, or a log line
  missing `correlation_id`, is `[MEDIUM]`.
- **Config in code.** A hardcoded hostname, port, path, or environment-specific value is
  `[MEDIUM]`; if it is a credential it is `[CRITICAL]` and belongs in step 2.
- **Governance surfaces.** A change to `CLAUDE.md`, `.claude/settings.json`,
  `.claude/hooks/`, `.claude/commands/`, `.claudeignore` or `/system` is `[INFO]`, noting
  that `CLAUDE.md` assigns these to the DRI (`ali@colaberry.com`) and asks for review
  before merge. Not a defect — a routing note.

## Step 5: Output

Findings only. No preamble, no summary of what the diff does, no praise.

**Format — one line per finding, in this exact shape:**

```
[SEVERITY] path/to/file.ext:LINE - the issue - the suggested fix
```

**Ordering:** every `[CRITICAL]` secret finding first, then remaining `[CRITICAL]`, then
`[HIGH]`, `[MEDIUM]`, `[LOW]`, `[INFO]`. Within a severity, group by file.

**Severities:**

| Severity | Meaning |
|---|---|
| `[CRITICAL]` | A committed secret or credential, or a defect that loses data, duplicates an irreversible side effect, or exposes a security hole. Blocks merge. |
| `[HIGH]` | A real defect on a reachable path, a missing failure path, or a stated `CLAUDE.md` hard gate unmet. Blocks merge. |
| `[MEDIUM]` | A convention or robustness violation that will cost someone later. Should be fixed, does not block. |
| `[LOW]` | Nit, clarity, naming. |
| `[INFO]` | Not a defect. Routing, governance, or context the author should know. |

Cite the **line number in the file as it now stands**, not the diff hunk offset. If a
finding is about an absence — a missing test, a missing `PROGRESS.md` entry — cite the
file where the thing should be and say so plainly.

State uncertainty rather than inflating confidence: if you cannot tell from the diff
whether something is a defect, say what you would need to see. A speculative
`[HIGH]` trains the author to ignore the severities.

**Final line, exactly one of these, on its own line, nothing after it:**

```
REVIEW CLEAN
```

```
REVIEW HAS FINDINGS
```

`REVIEW CLEAN` requires zero `[CRITICAL]`, `[HIGH]`, `[MEDIUM]` and `[LOW]` findings.
`[INFO]` alone still permits `REVIEW CLEAN`. Any secret finding always means
`REVIEW HAS FINDINGS`.

---

## Example output

```
[CRITICAL] backend/src/services/payments/payRailClient.js:34 - Live API key committed as a string literal, and interpolated into the request URL where it will reach access logs and proxy logs - Rotate the key now, it is compromised by being in git history; then read it from process.env and send it in an Authorization header, never a query string
[HIGH] backend/src/services/payments/payRailClient.js:41 - fetch() has no timeout, so a hung gateway holds the worker until the process restarts - Pass an AbortSignal with an explicit timeout derived from the observed p99
[HIGH] backend/src/services/payments/payRailClient.js:52 - Retry on ETIMEDOUT for a payment write with no idempotency key, which will double-charge when a response is lost - Derive a key from sha256(claimId:type:amountCents), persist it before the call, and reconcile by reading back on timeout rather than re-sending
[HIGH] PROGRESS.md:1 - Diff touches backend/ but PROGRESS.md is unchanged, which CLAUDE.md defines as a hard gate - Append an entry with a Session ID and verification evidence on the same line as the [x]
[MEDIUM] backend/src/services/payments/payRailClient.js:58 - console.log of the raw error body, which echoes the masked account number - Emit a structured JSON line with error_class and correlation_id, and no response body
[INFO] .claude/settings.json:1 - DRI-owned surface per CLAUDE.md; wants review by ali@colaberry.com before merge to main

REVIEW HAS FINDINGS
```
