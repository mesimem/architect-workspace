#!/usr/bin/env node
/**
 * routine.ts — unattended single-task run via the Claude Agent SDK.
 *
 * Runs the same task previously issued by hand with `claude -p`, on the same
 * scoped tool leash. Designed to be launched by a scheduler (cron, Task
 * Scheduler, CI) with no human present.
 *
 * Run:      node routine.ts          (Node >= 22.6 strips types natively;
 *                                     verified on v24.18.0, no tsconfig needed)
 * Install:  npm i @anthropic-ai/claude-agent-sdk
 *
 * Contract with the scheduler — the exit code is the whole API:
 *   0   task completed, result logged
 *   1   the agent reported is_error. TRANSIENT-OR-NOT IS THE SCHEDULER'S CALL.
 *       This script never retries; see the note on idempotency at the bottom.
 *   3   the stream ended without ever yielding a "result" message
 *  78   configuration fault (EX_CONFIG): no API key. Retrying will not help.
 *
 * Secrets: the key is read from the environment by the SDK. This file never
 * hardcodes it, never reads its value, and never logs it — only whether it is
 * present. Tool *inputs* are deliberately not logged either, because they can
 * carry file contents.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

// --- the task -----------------------------------------------------------
// Swap this string to repoint the routine. Everything else is machinery.
const TASK = `Fix one mypy union-attr error. In mcp/destination-catalog/server.py the progress \
notification is guarded by 'if progress_token is not None:' but the next statement calls \
'await ctx.report_progress(...)', and ctx is typed 'Context | None', so the guard does not \
prove ctx is non-None. Change that condition to also require ctx, i.e. \
'if progress_token is not None and ctx is not None:'. Change nothing else. \
Then run 'npm run typecheck' and confirm destination-catalog reports no issues. \
Then stage ONLY mcp/destination-catalog/server.py and commit with the message \
'fix(destination-catalog): guard ctx before report_progress'. \
Do not stage or commit any other file - other sessions have uncommitted work in this tree. \
If typecheck still fails, stop and report instead of making further edits. \
If the change is already present and there is nothing to commit, say so and stop \
without creating an empty commit.`;

// --- the leash ----------------------------------------------------------
// Identical to the hand-run invocation. Note that `git add` is an EXACT match
// with no ":*" wildcard, which makes `git add -A` and `git add .`
// unrepresentable rather than merely discouraged — three other sessions keep
// uncommitted work in this tree and it exists nowhere but the working copy.
const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Bash(npm run typecheck:*)",
  "Bash(git add mcp/destination-catalog/server.py)",
  "Bash(git commit:*)",
] as const;

const MAX_TURNS = 25;

// --- structured logging -------------------------------------------------
// One JSON object per line, to stdout. No prose, no multi-line payloads: a
// scheduler's log collector should be able to parse every line it receives.
type LogFields = Record<string, unknown>;

function log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: "routine",
      event,
      ...fields,
    }) + "\n",
  );
}

// --- main ---------------------------------------------------------------
async function main(): Promise<number> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();

  // Presence only. The value is never read into a variable and never logged.
  if (!process.env.ANTHROPIC_API_KEY) {
    log("error", "routine.config_invalid", {
      correlation_id: correlationId,
      outcome: "failure",
      error_class: "ConfigError",
      reason: "ANTHROPIC_API_KEY is not set in the environment",
    });
    return 78; // EX_CONFIG — a retry cannot fix this
  }

  log("info", "routine.started", {
    correlation_id: correlationId,
    max_turns: MAX_TURNS,
    allowed_tools: ALLOWED_TOOLS,
    permission_mode: "acceptEdits",
    api_key_present: true, // never the value
  });

  let sawResult = false;
  let exitCode = 3; // no result message seen, until proven otherwise

  try {
    for await (const message of query({
      prompt: TASK,
      options: {
        permissionMode: "acceptEdits",
        allowedTools: [...ALLOWED_TOOLS],
        maxTurns: MAX_TURNS,
      },
    })) {
      // Observability without leakage: log that a tool ran, never its input.
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            log("info", "routine.tool_use", {
              correlation_id: correlationId,
              tool: block.name, // name only — inputs can contain file contents
            });
          }
        }
      }

      if (message.type !== "result") continue;
      sawResult = true;

      if (message.is_error) {
        log("error", "routine.failed", {
          correlation_id: correlationId,
          outcome: "failure",
          error_class: "AgentError",
          subtype: message.subtype,
          turns: message.num_turns,
          max_turns: MAX_TURNS,
          hit_turn_cap: message.num_turns >= MAX_TURNS,
          cost_usd: message.total_cost_usd,
          duration_ms: Date.now() - startedAt,
          session_id: message.session_id,
        });
        // Deliberately no retry. Whether this is worth another attempt is the
        // scheduler's decision, and it has context this process does not:
        // how many times it has already fired, and whether the tree is clean.
        exitCode = 1;
        break;
      }

      log("info", "routine.succeeded", {
        correlation_id: correlationId,
        outcome: "success",
        turns: message.num_turns,
        max_turns: MAX_TURNS,
        cost_usd: message.total_cost_usd,
        duration_ms: Date.now() - startedAt,
        session_id: message.session_id,
        result: "result" in message ? message.result : null,
      });
      exitCode = 0;
      break;
    }
  } catch (err) {
    // Never swallow. Log the class and message; no stack to stdout, because a
    // stack can echo arguments.
    log("error", "routine.threw", {
      correlation_id: correlationId,
      outcome: "failure",
      error_class: err instanceof Error ? err.constructor.name : "UnknownError",
      message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    });
    return 1;
  }

  if (!sawResult) {
    log("error", "routine.no_result", {
      correlation_id: correlationId,
      outcome: "failure",
      error_class: "NoResultMessage",
      reason: "stream ended without a result message",
      duration_ms: Date.now() - startedAt,
    });
  }

  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log("error", "routine.fatal", {
      outcome: "failure",
      error_class: err instanceof Error ? err.constructor.name : "UnknownError",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  },
);
