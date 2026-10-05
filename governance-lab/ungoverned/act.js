// ungoverned/act.js — the same agent, with nothing in front of it.
//
// This is the control case. agent.js is a byte-for-byte copy of the governed
// one: the same four situations, the same reasoning, the same helpfulness, no
// malice anywhere. The only difference is what sits between propose and act,
// and here the answer is nothing.
//
// There is no policy to consult, so no action can be refused. No escalation,
// so nothing can wait for a person. No approval, so no side effect has a name
// attached. No decisions log, so no action has a recorded reason. The ledger
// is the only artefact that survives the run, and it records what happened
// without recording why, who, or on whose authority.
//
// Everything written stays in ungoverned/data/, so the governed ledger,
// decisions log and pending queue are untouched by anything in here.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, 'data', 'ledger.jsonl');

// Exported, and takes an action straight from the agent. Nothing consults a
// verdict first because there is no verdict to consult. The governed copy
// keeps this function module-private for exactly this reason.
export function act(action) {
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

// What the side effect means in the world, for the run report. The ungoverned
// agent happily describes what it did; it just has no mechanism for anyone to
// have disagreed beforehand.
function describe(action) {
  switch (action.actionType) {
    case 'refund':
      return `$${action.amount} moved out on ${action.resource}`;
    case 'delete_record':
      return `${action.resource} deleted${
        action.context.recordHasOrders ? ' (it had orders attached)' : ''
      }`;
    case 'export_and_email':
      return `${action.context.rowCount} rows exported and ${action.context.recipientCount} emails sent`;
    default:
      return `${action.actionType} carried out on ${action.resource}`;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { propose } = await import('./agent.js');

  const action = propose();
  console.log('PROPOSED');
  console.log(JSON.stringify(action, null, 2));

  const result = act(action);

  console.log(`\nACTION   ${action.actionId}`);
  console.log('VERDICT  (none — there is nothing here that could refuse)');
  console.log(`CARRIED OUT — ${describe(action)}`);
  console.log(`appended to ${result.ledgerPath}`);
  console.log(result.line);

  // Exit 0. Every time, for every mode. Nothing went wrong, in the only sense
  // this program is capable of having an opinion about.
}
