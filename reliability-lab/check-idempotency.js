#!/usr/bin/env node
/**
 * check-idempotency.js — proves the desk sends each order exactly once.
 *
 * A plain script, deliberately: no framework, no dependencies, exits non-zero
 * on failure. And deliberately NOT named *.test.js or *_test.py, so the
 * surrounding project's own test runner can never pick it up and try to run
 * this lab as part of its suite.
 *
 *   node check-idempotency.js          (or: npm test, from this folder)
 *
 * WHAT IT ASSERTS, with VENDOR_MODE=ok and two runs of `confirm 4001`:
 *   1. data/sent.log gains EXACTLY ONE line for order 4001.
 *   2. The second run's receipt reports outcome "duplicate".
 *
 * Both halves matter. The line count alone would pass if the desk silently
 * stopped sending anything; the duplicate flag alone would pass if the desk
 * reported a duplicate and then appended anyway.
 */

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESK = join(HERE, 'src', 'desk.js');
const SENT_LOG = join(HERE, 'data', 'sent.log');
const KEYS_FILE = join(HERE, 'data', 'keys.json');

const ORDER_ID = '4001';
const KEY = `order:${ORDER_ID}`;

const failures = [];

function check(description, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${description}`);
  } else {
    console.log(`  FAIL  ${description}`);
    if (detail) console.log(`        ${detail}`);
    failures.push(description);
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/** How many lines in sent.log are for this order. */
async function countSentLines(orderId) {
  const text = await readIfPresent(SENT_LOG);
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((row) => row.orderId === orderId).length;
}

/**
 * Forget that this order was ever sent.
 *
 * Test setup, not cheating: the property under test is "two arrivals of an
 * unsent order produce one send", so the run has to begin from unsent or it
 * would pass for the wrong reason on every run after the first.
 */
async function forgetOrderKey() {
  const text = await readIfPresent(KEYS_FILE);
  if (text.trim() === '') return;
  const all = JSON.parse(text);
  delete all[KEY];
  await writeFile(KEYS_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

/** Run the desk once and hand back its exit code and parsed result line. */
function runConfirm(orderId) {
  const run = spawnSync(process.execPath, [DESK, 'confirm', orderId], {
    cwd: HERE,
    env: { ...process.env, VENDOR_MODE: 'ok' },
    encoding: 'utf8',
  });

  const stdout = run.stdout ?? '';
  const receiptLine = stdout.split('\n').find((line) => line.startsWith('receipt: '));

  return {
    status: run.status,
    stdout,
    stderr: run.stderr ?? '',
    result: receiptLine ? JSON.parse(receiptLine.slice('receipt: '.length)) : null,
  };
}

async function main() {
  console.log(`check-idempotency: confirm ${ORDER_ID} twice, expect one send\n`);

  await forgetOrderKey();
  const before = await countSentLines(ORDER_ID);

  const first = runConfirm(ORDER_ID);
  console.log('--- run 1 ---');
  process.stdout.write(first.stdout);
  if (first.stderr) process.stderr.write(first.stderr);

  const second = runConfirm(ORDER_ID);
  console.log('--- run 2 ---');
  process.stdout.write(second.stdout);
  if (second.stderr) process.stderr.write(second.stderr);

  const after = await countSentLines(ORDER_ID);
  const gained = after - before;

  console.log('\n--- assertions ---');

  check('run 1 exits 0', first.status === 0, `exit status was ${first.status}`);
  check('run 2 exits 0', second.status === 0, `exit status was ${second.status}`);
  check(
    'run 1 receipt outcome is "sent"',
    first.result?.outcome === 'sent',
    `receipt was ${JSON.stringify(first.result)}`,
  );
  check(
    'run 2 receipt outcome is "duplicate"',
    second.result?.outcome === 'duplicate',
    `receipt was ${JSON.stringify(second.result)}`,
  );
  check(
    `sent.log gained exactly 1 line for order ${ORDER_ID}`,
    gained === 1,
    `gained ${gained} line(s): ${before} before, ${after} after`,
  );

  console.log('');
  if (failures.length > 0) {
    console.error(`check-idempotency FAILED — ${failures.length} assertion(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('check-idempotency PASSED — one order, two arrivals, one send.');
}

main().catch((error) => {
  console.error(`check-idempotency errored — ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
