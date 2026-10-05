// audit.js — the one way anything gets written to data/decisions.jsonl.
//
// Every governance event lands here: evaluations, approvals, denials and
// expiries. One append-only stream, so "what happened to this action" is a
// single grep on actionId rather than a reconciliation of several logs.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DECISIONS_PATH = join(HERE, 'data', 'decisions.jsonl');

export function append(entry) {
  const line = { at: new Date().toISOString(), ...entry };

  mkdirSync(dirname(DECISIONS_PATH), { recursive: true });
  appendFileSync(DECISIONS_PATH, `${JSON.stringify(line)}\n`, 'utf8');

  return line;
}
