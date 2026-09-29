// gate.js — reads policy.json and decides whether an action may proceed.
//
// The rules are data, not code. policy.json is re-read on every evaluation, so
// changing what is permitted does not require a deploy — which is the point:
// the people who own the risk can read and argue about the rules without
// reading JavaScript.
//
// Fail closed. An action no rule speaks to is denied, so the policy is a list
// of what is permitted rather than a list of the harms someone imagined.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = join(HERE, 'policy.json');
const DECISIONS_PATH = join(HERE, 'data', 'decisions.jsonl');

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

// Used to render the fact that lost, e.g. "amount 2400 exceeds 500".
const PHRASES = {
  eq: 'is',
  neq: 'is not',
  gt: 'exceeds',
  gte: 'is at least',
  lt: 'is below',
  lte: 'is at most',
};

function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
}

// Dotted paths so a future rule can reach into context, e.g. "context.rowCount".
function read(action, field) {
  return field.split('.').reduce((v, k) => (v == null ? undefined : v[k]), action);
}

function holds(action, condition) {
  const actual = read(action, condition.field);
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'gt':
      return actual > condition.value;
    case 'gte':
      return actual >= condition.value;
    case 'lt':
      return actual < condition.value;
    case 'lte':
      return actual <= condition.value;
    default:
      throw new Error(
        `policy.json rule uses an unknown operator "${condition.op}"`
      );
  }
}

function fact(action, condition) {
  const actual = JSON.stringify(read(action, condition.field) ?? null);
  const limit = JSON.stringify(condition.value);
  return `${condition.field} ${actual} ${PHRASES[condition.op]} ${limit}`;
}

function decide(action, policy) {
  for (const rule of policy.rules) {
    if (!holds(action, rule.appliesTo)) continue;

    // A limit that cannot be compared is a limit that cannot be cleared.
    // Without this, a refund with a null amount would slip through as allowed,
    // because `null > 500` is false.
    const actual = read(action, rule.deny.field);
    if (
      NUMERIC_OPS.has(rule.deny.op) &&
      (typeof actual !== 'number' || Number.isNaN(actual))
    ) {
      return {
        verdict: 'deny',
        ruleId: rule.id,
        reason: `${rule.id}: ${rule.deny.field} ${JSON.stringify(
          actual ?? null
        )} cannot be compared against ${JSON.stringify(rule.deny.value)}`,
      };
    }

    if (holds(action, rule.deny)) {
      return {
        verdict: 'deny',
        ruleId: rule.id,
        reason: `${rule.id}: ${fact(action, rule.deny)}`,
      };
    }

    return {
      verdict: 'allow',
      ruleId: rule.id,
      reason: `${rule.id}: ${rule.allowReason}`,
    };
  }

  const fallback = policy.default;
  return {
    verdict: fallback.verdict,
    ruleId: fallback.ruleId,
    reason: fallback.reason,
  };
}

// A denial is a decision somebody will question later, so it is recorded
// exactly as carefully as an approval. Recording happens inside evaluate:
// there is no way to get a verdict without leaving a record of it.
function record(action, decision) {
  const entry = {
    actionId: action.actionId,
    actionType: action.actionType,
    amount: action.amount,
    verdict: decision.verdict,
    ruleId: decision.ruleId,
    reason: decision.reason,
    at: new Date().toISOString(),
  };

  mkdirSync(dirname(DECISIONS_PATH), { recursive: true });
  appendFileSync(DECISIONS_PATH, `${JSON.stringify(entry)}\n`, 'utf8');

  return entry;
}

export function evaluate(action) {
  const decision = decide(action, loadPolicy());
  record(action, decision);
  return decision;
}
