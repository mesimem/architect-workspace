// act.js — carries out a proposed action, but only via the gate.
//
// The side effect for tonight is one JSON line appended to data/ledger.jsonl.
// That line stands in for the money moving, the record disappearing and the
// forty thousand emails leaving.
//
// STRUCTURE: performAction is not exported. The only export that can write to
// the ledger is submit(), and submit() calls evaluate() before it does
// anything, with no argument that can skip it. There is no exported function
// that takes an action and acts on it without a verdict.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluate } from './gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, 'data', 'ledger.jsonl');

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

export function submit(action) {
  const decision = evaluate(action);

  // Anything that is not an explicit allow does not act. A verdict this code
  // does not recognise is treated as a refusal, not as permission.
  if (decision.verdict !== 'allow') {
    return { decision, performed: false };
  }

  return { decision, performed: true, ...performAction(action) };
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
  console.log(`\nVERDICT  ${verdict}`);
  console.log(`RULE     ${ruleId}`);
  console.log(`REASON   ${reason}`);

  if (result.performed) {
    console.log(`\nACTED — appended to ${result.ledgerPath}`);
    console.log(result.line);
  } else {
    console.log('\nBLOCKED — nothing was written to the ledger.');
    // A blocked action is not a successful one, so it does not exit 0.
    process.exitCode = 3;
  }
}
