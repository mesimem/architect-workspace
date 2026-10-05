// gate.js — reads policy.json and decides whether an action may proceed.
//
// The rules are data, not code. policy.json is re-read on every evaluation, so
// changing what is permitted does not require a deploy — which is the point:
// the people who own the risk can read and argue about the rules without
// reading JavaScript.
//
// Three verdicts. `allow` acts now. `deny` never acts. `escalate` parks the
// action for a named human and acts only if that human says yes.
//
// Fail closed. An action no rule speaks to is denied, so the policy is a list
// of what is permitted rather than a list of the harms someone imagined.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { append as audit } from './audit.js';
import { compare, read } from './facts.js';
import { assess, ceilingFor } from './risk.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = join(HERE, 'policy.json');

function loadPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
}

// Names the facts that cost points, so a reason is never just a number. A
// verdict an approver cannot trace back to a fact is not reviewable.
function signals(factors) {
  const hits = factors.filter((factor) => factor.points > 0);
  if (hits.length === 0) return 'no risk signals';

  return hits
    .map((f) => `${f.note} (${f.field} ${JSON.stringify(f.value)}, +${f.points})`)
    .join('; ');
}

function placement(verdict, model) {
  const allowCeiling = ceilingFor(model, 'allow');
  const escalateCeiling = ceilingFor(model, 'escalate');

  if (verdict === 'allow') return `within the allow ceiling of ${allowCeiling}`;
  if (verdict === 'escalate') return `above the allow ceiling of ${allowCeiling}`;
  return `above the escalate ceiling of ${escalateCeiling}`;
}

function decide(action, policy) {
  for (const rule of policy.rules) {
    const applies = compare(
      rule.appliesTo.op,
      read(action, rule.appliesTo.field),
      rule.appliesTo.value
    );
    if (!applies) continue;

    const risk = assess(action, rule.risk);

    return {
      verdict: risk.verdict,
      ruleId: rule.id,
      reason: `${rule.id}: risk ${risk.score} ${placement(
        risk.verdict,
        rule.risk
      )} — ${signals(risk.factors)}`,
      risk,
      escalateTo: rule.escalateTo ?? 'a named human',
    };
  }

  const fallback = policy.default;
  return {
    verdict: fallback.verdict,
    ruleId: fallback.ruleId,
    reason: fallback.reason,
    risk: null,
    escalateTo: null,
  };
}

// A denial is a decision somebody will question later, so it is recorded
// exactly as carefully as an approval. Recording happens inside evaluate:
// there is no way to get a verdict without leaving a record of it.
export function evaluate(action) {
  const decision = decide(action, loadPolicy());

  audit({
    event: 'evaluation',
    actionId: action.actionId,
    actionType: action.actionType,
    amount: action.amount,
    verdict: decision.verdict,
    ruleId: decision.ruleId,
    riskScore: decision.risk?.score ?? null,
    reason: decision.reason,
  });

  return decision;
}
