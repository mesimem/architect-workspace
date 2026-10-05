// govern.js — the human side of the gate: pending, approve, deny.
//
// Presentation only. Every decision it reports comes from act.js and
// escalation.js, so running a command here and calling the functions directly
// cannot disagree about whether an approval was spent or an item expired.
//
// Exit codes: 0 done, 2 bad usage, 4 refused (already spent, expired, unknown).

import { InvalidActionIdError } from './escalation.js';
import { MissingNameError, approve, deny } from './act.js';
import { list } from './escalation.js';

const USAGE = `governance-lab

  node govern.js pending
  node govern.js approve <actionId> --by "<name>"
  node govern.js deny    <actionId> --by "<name>" [--reason "<why>"]

Both approve and deny require --by. Pending items expire (default 3600s,
override with ESCALATION_TTL_SECONDS) and an expired item reads as denied.`;

function parseFlags(argv) {
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const name = token.slice(2);
    const next = argv[i + 1];

    // `--by --reason x` would otherwise read as the name "--reason".
    if (next === undefined || next.startsWith('--')) {
      flags[name] = '';
    } else {
      flags[name] = next;
      i += 1;
    }
  }

  return flags;
}

function humanLeft(ms) {
  if (ms <= 0) return `expired ${Math.round(-ms / 1000)}s ago`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s left`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m ${seconds % 60}s left`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

function showFactors(item) {
  for (const factor of item.factors) {
    const points = factor.points > 0 ? `+${factor.points}` : '  0';
    console.log(
      `    ${points}  ${factor.label}: ${JSON.stringify(factor.value)} — ${factor.note}`
    );
  }
}

function cmdPending() {
  const items = list();
  const waiting = items.filter((item) => item.effectiveStatus === 'pending');

  if (items.length === 0) {
    console.log('Nothing has ever been escalated.');
    return 0;
  }

  // Only what is actually waiting. A resolved item listed under this heading
  // reads as still open, and an expired one is resolved whether or not anyone
  // came back to it — those are counted below instead.
  console.log(`PENDING (${waiting.length} waiting)\n`);

  if (waiting.length === 0) {
    console.log('  Nothing is waiting on a decision.\n');
  }

  for (const item of waiting) {
    console.log(`  ${item.actionId}`);
    console.log(
      `    ${item.action.actionType} ${item.action.resource}` +
        (item.action.amount === null ? '' : ` $${item.action.amount}`)
    );
    console.log(`    risk ${item.riskScore} by rule "${item.ruleId}"`);
    console.log(`    waiting on ${item.waitingOn} — ${humanLeft(item.msLeft)}`);
    showFactors(item);
    console.log('');
  }

  const settled = items.filter((item) => item.effectiveStatus !== 'pending');
  if (settled.length > 0) {
    const tally = settled.reduce((counts, item) => {
      const key = item.expired ? 'expired' : item.status;
      return { ...counts, [key]: (counts[key] ?? 0) + 1 };
    }, {});

    const parts = Object.entries(tally).map(([key, n]) => `${n} ${key}`);
    console.log(`Settled: ${parts.join(', ')} (${settled.length} total).`);
  }

  return 0;
}

function report(result, verb) {
  if (result.outcome === 'not-found') {
    console.log(`NOT FOUND — no escalation parked under ${result.actionId}.`);
    return 4;
  }

  if (result.outcome === 'expired') {
    const { item } = result;
    console.log(`REFUSED — this escalation expired and reads as DENIED.`);
    console.log(`  parked  ${item.parkedAt}`);
    console.log(`  expired ${item.expiresAt} (after ${item.ttlSeconds}s)`);
    console.log(`  status  ${item.status} — ${item.resolution.reason}`);
    console.log('Nothing was written to the ledger.');
    return 4;
  }

  if (result.outcome === 'already-spent') {
    const { resolution } = result.item;
    console.log('REFUSED — that approval was already spent.');
    console.log(
      `  ${result.item.status} by ${resolution?.by ?? 'unknown'} at ${resolution?.at ?? 'unknown'}`
    );
    console.log('Nothing changed and nothing was written to the ledger.');
    return 4;
  }

  if (result.outcome === 'already-resolved') {
    const { resolution } = result.item;
    console.log(`REFUSED — already ${result.item.status}.`);
    console.log(
      `  by ${resolution?.by ?? 'unknown'} at ${resolution?.at ?? 'unknown'}`
    );
    return 4;
  }

  const { resolution } = result.item;
  console.log(`${verb} — by ${resolution.by} at ${resolution.at}`);

  if (result.outcome === 'approved') {
    console.log(`ACTED — appended to ${result.ledgerPath}`);
    console.log(result.line);
  } else {
    console.log(`REASON  ${resolution.reason}`);
    console.log('Nothing was written to the ledger.');
  }

  return 0;
}

function main(argv) {
  const [command, actionId] = argv;
  const flags = parseFlags(argv);

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  if (command === 'pending') return cmdPending();

  if (command !== 'approve' && command !== 'deny') {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  if (!actionId || actionId.startsWith('--')) {
    console.error(`${command} needs an actionId.\n\n${USAGE}`);
    return 2;
  }

  try {
    if (command === 'approve') {
      return report(approve(actionId, flags.by), 'APPROVED');
    }
    return report(deny(actionId, flags.by, flags.reason), 'DENIED');
  } catch (error) {
    // A missing name or a malformed id is a usage problem, not a crash.
    if (error instanceof MissingNameError) {
      console.error(`REFUSED — ${error.message}`);
      console.error('Nothing was written to the ledger.');
      return 2;
    }
    if (error instanceof InvalidActionIdError) {
      console.error(`REFUSED — ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
