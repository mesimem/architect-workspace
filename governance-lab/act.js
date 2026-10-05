// act.js — carries out a proposed action, but only via the gate.
//
// The side effect for tonight is one JSON line appended to data/ledger.jsonl.
// That line stands in for the money moving, the record disappearing and the
// forty thousand emails leaving.
//
// STRUCTURE: performAction is not exported. Exactly two exports can reach it —
// submit() on an allow, and approve() on a human yes — and both consult a
// decision first, with no argument that can skip it. There is no exported
// function that takes an action and acts on it without a verdict behind it.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { append as audit } from './audit.js';
import { evaluate } from './gate.js';
import { claim, load, park, pendingPath, resolve } from './escalation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, 'data', 'ledger.jsonl');

export class MissingNameError extends Error {
  constructor() {
    super('a decision needs a name — pass --by "<your name>"');
    this.name = 'MissingNameError';
  }
}

// An unsigned approval is not an approval. Whoever said yes has to be on the
// record, because the whole value of the escalation is that a person owns it.
function requireName(by) {
  if (typeof by !== 'string' || by.trim() === '') throw new MissingNameError();
  return by.trim();
}

// Only an approval can be "spent". A denial refused to spend anything, so
// saying so would misdescribe the record to the person reading it.
function spentOutcome(item) {
  return item.status === 'approved' ? 'already-spent' : 'already-resolved';
}

// Module-private. Nothing outside this file holds a reference to it.
function performAction(action) {
  const entry = {
    actionId: action.actionId,
    actionType: action.actionType,
    resource: action.resource,
    amount: action.amount,
    at: new Date().toISOString(),
  };

  // An export and a bulk email are measured in rows and recipients, not dollars.
  if (action.actionType === 'export_and_email') {
    entry.rows = action.context.rowCount;
    entry.recipients = action.context.recipientCount;
  }

  const line = JSON.stringify(entry);
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  appendFileSync(LEDGER_PATH, `${line}\n`, 'utf8');

  return { entry, line, ledgerPath: LEDGER_PATH };
}

// Writes the lapse down once, so the record shows an item that ran out of time
// rather than an item nobody ever came back to.
function recordLapse(item) {
  const resolved = resolve(item.actionId, {
    status: 'denied',
    resolution: {
      decision: 'denied',
      by: 'system (expiry)',
      at: new Date().toISOString(),
      reason: 'expired without a decision — silence is not consent',
    },
  });

  audit({
    event: 'expiry',
    actionId: item.actionId,
    actionType: item.action.actionType,
    amount: item.action.amount,
    verdict: 'deny',
    ruleId: item.ruleId,
    by: 'system (expiry)',
    reason: `escalation expired after ${item.ttlSeconds}s without a decision`,
  });

  return resolved;
}

export function submit(action) {
  const decision = evaluate(action);

  if (decision.verdict === 'escalate') {
    const item = park(action, decision);
    return {
      decision,
      performed: false,
      escalated: true,
      item,
      pendingPath: pendingPath(action.actionId),
    };
  }

  // Anything that is not an explicit allow does not act. A verdict this code
  // does not recognise is treated as a refusal, not as permission.
  if (decision.verdict !== 'allow') {
    return { decision, performed: false };
  }

  return { decision, performed: true, ...performAction(action) };
}

export function approve(actionId, by) {
  const approver = requireName(by);

  const item = load(actionId);
  if (!item) return { ok: false, outcome: 'not-found', actionId };

  // Checked before anything is claimed or written. An expired item is denied,
  // and approve has nothing left to act on.
  if (item.expired) {
    return { ok: false, outcome: 'expired', item: recordLapse(item) };
  }

  if (item.status !== 'pending') {
    return { ok: false, outcome: spentOutcome(item), item };
  }

  // The claim is the once-only guarantee, and it is taken before the side
  // effect rather than after. A crash between claiming and acting leaves the
  // item stuck for a human to look at, which is the safe direction to fail:
  // the alternative is a window where a second approval could also act.
  if (!claim(actionId, { intent: 'approve', by: approver })) {
    const current = load(actionId) ?? item;
    return { ok: false, outcome: spentOutcome(current), item: current };
  }

  const performed = performAction(item.action);
  const at = new Date().toISOString();

  const resolved = resolve(actionId, {
    status: 'approved',
    resolution: {
      decision: 'approved',
      by: approver,
      at,
      reason: `approved by ${approver}`,
      ledger: performed.entry,
    },
  });

  audit({
    event: 'approval',
    at,
    actionId,
    actionType: item.action.actionType,
    amount: item.action.amount,
    verdict: 'allow',
    ruleId: item.ruleId,
    riskScore: item.riskScore,
    by: approver,
    reason: `escalation approved by ${approver}`,
  });

  return { ok: true, outcome: 'approved', item: resolved, ...performed };
}

export function deny(actionId, by, reason) {
  const decider = requireName(by);

  const item = load(actionId);
  if (!item) return { ok: false, outcome: 'not-found', actionId };

  if (item.expired) {
    return { ok: false, outcome: 'expired', item: recordLapse(item) };
  }

  if (item.status !== 'pending') {
    return { ok: false, outcome: 'already-resolved', item };
  }

  // Denials claim too, so the first decision wins and an approval cannot race
  // in behind one.
  if (!claim(actionId, { intent: 'deny', by: decider })) {
    return {
      ok: false,
      outcome: 'already-resolved',
      item: load(actionId) ?? item,
    };
  }

  const at = new Date().toISOString();
  const given = typeof reason === 'string' && reason.trim() !== ''
    ? reason.trim()
    : '(no reason given)';

  const resolved = resolve(actionId, {
    status: 'denied',
    resolution: { decision: 'denied', by: decider, at, reason: given },
  });

  audit({
    event: 'denial',
    at,
    actionId,
    actionType: item.action.actionType,
    amount: item.action.amount,
    verdict: 'deny',
    ruleId: item.ruleId,
    riskScore: item.riskScore,
    by: decider,
    reason: given,
  });

  return { ok: true, outcome: 'denied', item: resolved };
}

// process.argv[1] is undefined when this module is imported rather than run
// (node -e, the REPL), so guard it before converting it to a URL.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { propose } = await import('./agent.js');

  const action = propose();
  console.log('PROPOSED');
  console.log(JSON.stringify(action, null, 2));

  const result = submit(action);
  const { verdict, ruleId, reason } = result.decision;
  console.log(`\nACTION   ${action.actionId}`);
  console.log(`VERDICT  ${verdict}`);
  console.log(`RULE     ${ruleId}`);
  console.log(`REASON   ${reason}`);

  if (result.performed) {
    console.log(`\nACTED — appended to ${result.ledgerPath}`);
    console.log(result.line);
  } else if (result.escalated) {
    console.log(`\nESCALATED — waiting on ${result.item.waitingOn}`);
    console.log(`RISK     ${result.item.riskScore}`);
    console.log(`PARKED   ${result.pendingPath}`);
    console.log(`EXPIRES  ${result.item.expiresAt} (${result.item.ttlSeconds}s)`);
    console.log('Nothing was written to the ledger.');
    // Not a success and not a refusal; its own code so a caller can tell.
    process.exitCode = 4;
  } else {
    console.log('\nBLOCKED — nothing was written to the ledger.');
    // A blocked action is not a successful one, so it does not exit 0.
    process.exitCode = 3;
  }
}
