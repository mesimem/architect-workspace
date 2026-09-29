#!/usr/bin/env node
/**
 * desk.js — the order desk.
 *
 *   node src/desk.js confirm <orderId>
 *   node src/desk.js replay
 *
 * THE LAYERS, from the inside out:
 *
 *   breaker( retry( withTimeout( callVendor ) ) )      "can we get an answer?"
 *   runOnce( quality gate → append to sent.log )       "is it worth sending,
 *                                                       and have we already?"
 *
 * The first group is reliability: deadlines, budgets, and declining to call
 * an upstream we have watched fail. Its job ends the moment an answer
 * arrives. The second group is quality and idempotency: whether the answer is
 * fit to put in front of a customer, and whether this customer has already
 * had one. Different questions, different layers, both cheap.
 *
 * WHY THE GATE SITS INSIDE runOnce: a stored result was already gated on the
 * run that stored it. Re-gating it would mean a fresh, bad vendor reply could
 * reject an order that has demonstrably already been sent — the desk
 * contradicting its own send log.
 *
 * The named failures decide what happens next, which is the whole reason for
 * naming them:
 *   UpstreamUnavailable  vendor answered 500     → retry, then fall back
 *   TimeoutError         vendor did not answer   → retry, then dead-letter
 *   BreakerOpen          we declined to call     → fall back immediately
 *   BadResponse          not even a string       → never retried
 *   QualityGateRejected  readable, not sendable  → never sent, dead-lettered
 */

import { randomUUID } from 'node:crypto';

import { fetchConfirmationMessage, VendorError } from './vendor.js';
import {
  retry,
  withTimeout,
  runOnce,
  assertQuality,
  scoreBreakdown,
  CircuitBreaker,
  BadResponse,
  UpstreamUnavailable,
  QUALITY_THRESHOLD,
} from './reliability.js';
import {
  appendSent,
  createBreakerStore,
  createKeyStore,
  parkDeadLetter,
  readDeadLetter,
  writeDeadLetter,
} from './store.js';

const PER_ATTEMPT_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10_000;

/**
 * The only two failures a plain template can honestly stand in for: both mean
 * "we could not reach the vendor", and neither means the vendor told us
 * something we are now ignoring.
 *
 * QualityGateRejected is deliberately absent. Falling back on a rejected
 * message would mean the vendor said something unusable and we sent a
 * different message anyway, under the same confirmation — the customer cannot
 * tell those apart, and one of them is a lie.
 */
const FALLBACK_ON = new Set(['UpstreamUnavailable', 'BreakerOpen']);

/**
 * The idempotency key, derived from the ORDER — the thing the customer has
 * one of — and from nothing else.
 *
 * It must be stable across processes, retries, replays and restarts. Anything
 * generated per run (a UUID, a timestamp, an attempt number) is unique by
 * construction, so it can never collide with the key a previous run stored,
 * so the lookup always misses and every arrival sends again. A key like that
 * is not a weak protection; it is a no-op with a convincing name.
 *
 * Contrast the correlation id below, which is exactly such a per-run UUID —
 * and is correct precisely because it is never used to decide anything.
 */
const sendKey = (orderId) => `order:${orderId}`;

const USAGE = [
  'Usage:',
  '  node src/desk.js confirm <orderId>   confirm one order',
  '  node src/desk.js replay              retry every dead-lettered order',
].join('\n');

/** Less information, all of it true. */
const fallbackMessage = (orderId) =>
  `Your order ${orderId} is confirmed. Full details will follow shortly.`;

/**
 * Is this even a message?
 *
 * Structural validity only — is it a non-empty string. Whether the contents
 * are any good is the quality gate's question, asked later and separately. A
 * null from the vendor is not a low-scoring message; it is not a message.
 *
 * @throws {BadResponse}
 */
function assertStructurallyValid(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new BadResponse('Vendor returned an empty message.', { received: message });
  }
}

/**
 * One attempt: ask the vendor and translate its failure into our vocabulary.
 *
 * The translation belongs here rather than in the vendor. A real vendor hands
 * you an HTTP status and no opinion about your retry policy; deciding that a
 * 500 means "UpstreamUnavailable, try again" is our call, on our side.
 */
async function callVendor(orderId, signal) {
  let message;
  try {
    message = await fetchConfirmationMessage(orderId, { signal });
  } catch (error) {
    if (error instanceof VendorError && error.status >= 500) {
      throw new UpstreamUnavailable(error.message, { status: error.status, cause: error });
    }
    throw error;
  }

  assertStructurallyValid(message);
  return message;
}

/** One line per attempt: which attempt, what happened, what it was called. */
function logAttempt(say, { attempt, attempts, outcome, errorName, willRetry, delayMs, retryable }) {
  const head = `attempt ${attempt}/${attempts}  ${outcome}`;
  if (outcome === 'success') {
    say(head);
    return;
  }
  const next = willRetry ? `retrying in ${delayMs} ms` : retryable ? 'attempts exhausted' : 'not retryable';
  say(`${head}  error=${errorName}  ${next}`);
}

/** One line per breaker transition, so the trip is visible rather than inferred. */
function logBreaker(say, event) {
  switch (event.type) {
    case 'rejected':
      say(`breaker OPEN — vendor not called, ${(event.remainingMs / 1000).toFixed(1)} s of cooldown left`);
      break;
    case 'probe':
      say('breaker HALF-OPEN — cooldown elapsed, letting one probe call through');
      break;
    case 'failure':
      say(`breaker closed — ${event.consecutiveFailures}/${BREAKER_THRESHOLD} consecutive failures (${event.errorName})`);
      break;
    case 'opened':
      say(`breaker OPENED after ${event.consecutiveFailures} consecutive failures — cooling down ${event.cooldownMs / 1000} s`);
      break;
    case 'reopened':
      say(`breaker RE-OPENED — the probe failed with ${event.errorName}, cooling down ${event.cooldownMs / 1000} s`);
      break;
    case 'closed_after_probe':
      say('breaker CLOSED — the probe succeeded, the vendor is back');
      break;
    default:
      break;
  }
}

function createBreaker(onEvent) {
  return new CircuitBreaker({
    store: createBreakerStore(),
    threshold: BREAKER_THRESHOLD,
    cooldownMs: BREAKER_COOLDOWN_MS,
    onEvent,
  });
}

/**
 * Take one order all the way, and emit a receipt for it.
 *
 * Always resolves. A failure here is a reported outcome, not an exception,
 * because "this order was parked" is a normal thing for the desk to do and
 * replay needs the same answer in the same shape.
 *
 * @param {string} orderId
 * @param {{verbose?: boolean}} [options]
 * @returns {Promise<{orderId: string, correlationId: string, attempts: number,
 *                    breakerState: string, gateScore: number|null,
 *                    outcome: 'sent'|'fallback'|'duplicate'|'dead-lettered',
 *                    error: string|null, sent: boolean, line?: string}>}
 */
export async function processOrder(orderId, { verbose = true } = {}) {
  // Identifies this RUN, not this order. Deliberately random and deliberately
  // never used to decide anything — it exists so that at 2 AM one grep across
  // sent.log, dead-letter.jsonl and the console follows one order through
  // every line it touched.
  const correlationId = randomUUID();
  const say = verbose ? (line) => console.log(`[${correlationId}] ${line}`) : () => {};

  let attempts = 0;
  let gateScore = null;

  const breaker = createBreaker((event) => logBreaker(say, event));

  const receipt = async (outcome, error) => {
    const state = await breaker.inspect();
    return {
      orderId,
      correlationId,
      attempts,
      breakerState: state.state,
      gateScore,
      outcome,
      error: error ?? null,
      sent: outcome !== 'dead-lettered',
    };
  };

  let message;
  let fallback = false;
  let degradedFrom = null;

  try {
    message = await breaker.execute(() =>
      retry(() => withTimeout((signal) => callVendor(orderId, signal), PER_ATTEMPT_TIMEOUT_MS), {
        attempts: MAX_ATTEMPTS,
        baseDelayMs: BASE_DELAY_MS,
        onAttempt: (event) => {
          attempts = event.attempt;
          logAttempt(say, event);
        },
      }),
    );
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';

    if (!FALLBACK_ON.has(errorName)) {
      await parkDeadLetter({ orderId, correlationId, errorName, reason: error.message });
      say(`dead-letter: ${orderId} parked with ${errorName} — nothing sent`);
      return receipt('dead-lettered', errorName);
    }

    message = fallbackMessage(orderId);
    fallback = true;
    degradedFrom = errorName;
    say(`fallback: ${errorName} — sending the plain template instead`);
  }

  try {
    // The send is the irreversible bit, so the send is what gets the key —
    // and the gate lives inside the claim, so a stored result short-circuits
    // before the gate is ever consulted.
    const { value: line, duplicate } = await runOnce(
      sendKey(orderId),
      async () => {
        const breakdown = assertQuality(message, orderId);
        gateScore = breakdown.score;
        say(`quality gate: ${breakdown.score}/100 (threshold ${QUALITY_THRESHOLD}) — passed`);
        return appendSent({ orderId, message, fallback, correlationId });
      },
      { store: createKeyStore() },
    );

    if (duplicate) {
      say(`duplicate: ${sendKey(orderId)} was already sent — gate skipped, not sending again`);
      say(`stored line: ${line}`);
      return { ...(await receipt('duplicate', null)), line };
    }

    say(`sent${fallback ? ' (fallback)' : ''}: ${line}`);
    return { ...(await receipt(fallback ? 'fallback' : 'sent', degradedFrom)), line };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';

    if (errorName === 'QualityGateRejected') {
      gateScore = error.score;
      say(`quality gate: ${error.score}/100 (threshold ${QUALITY_THRESHOLD}) — REFUSED`);
      for (const reason of error.reasons) say(`  lost points: ${reason}`);
      await parkDeadLetter({
        orderId,
        correlationId,
        errorName,
        reason: error.message,
        score: error.score,
        lostPointsFor: error.reasons,
        rejectedMessage: message,
      });
      say(`dead-letter: ${orderId} parked with ${errorName} — nothing sent`);
      return receipt('dead-lettered', errorName);
    }

    // The send itself failed. This is the case that must not vanish: we had a
    // message worth sending and could not deliver it.
    await parkDeadLetter({
      orderId,
      correlationId,
      errorName,
      reason: `send failed: ${error.message}`,
    });
    say(`dead-letter: ${orderId} parked with ${errorName} — the send itself failed`);
    return receipt('dead-lettered', errorName);
  }
}

/** Print the receipt: one JSON object, the whole story of one run. */
function printReceipt(result) {
  const { sent: _ignored, line: _alsoIgnored, ...receipt } = result;
  console.log(`receipt: ${JSON.stringify(receipt)}`);
}

/** `confirm <orderId>` */
async function cmdConfirm(orderId) {
  console.log(`confirm ${orderId}`);
  const result = await processOrder(orderId);
  printReceipt(result);
  return result.sent ? 0 : 1;
}

/**
 * `replay` — re-run every parked order through the normal path.
 *
 * Successes are removed; anything that fails again stays parked with a fresh
 * reason. The queue is rewritten once at the end from what actually survived,
 * so replaying twice cannot duplicate an entry or lose one.
 */
async function cmdReplay() {
  const parked = await readDeadLetter();

  if (parked.length === 0) {
    console.log('replay: dead-letter queue is empty, nothing to do');
    return 0;
  }

  console.log(`replay: ${parked.length} order(s) parked`);
  const survivors = [];

  for (const entry of parked) {
    console.log(`replay ${entry.orderId} (parked with ${entry.errorName})`);
    const result = await processOrder(entry.orderId);
    printReceipt(result);

    if (result.sent) {
      console.log(`  replayed: ${entry.orderId} ${result.outcome}, removing from queue`);
    } else {
      // parkDeadLetter already refreshed this row; keep the refreshed copy.
      const refreshed = (await readDeadLetter()).find((row) => row.orderId === entry.orderId);
      survivors.push(refreshed ?? entry);
      console.log(`  still failing: ${entry.orderId} stays parked with ${result.error}`);
    }
  }

  await writeDeadLetter(survivors);
  console.log(`replay: ${parked.length - survivors.length} sent, ${survivors.length} still parked`);
  return survivors.length === 0 ? 0 : 1;
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (command === 'confirm') {
    if (rest.length !== 1) throw new Error(`confirm takes exactly one order id.\n${USAGE}`);
    return cmdConfirm(rest[0]);
  }

  if (command === 'replay') {
    if (rest.length !== 0) throw new Error(`replay takes no arguments.\n${USAGE}`);
    return cmdReplay();
  }

  if (command === 'score') {
    // A small introspection aid: what would the gate say about this text?
    if (rest.length !== 2) throw new Error(`score takes a message and an order id.\n${USAGE}`);
    console.log(JSON.stringify(scoreBreakdown(rest[0], rest[1]), null, 2));
    return 0;
  }

  throw new Error(`Unknown command ${command ? `"${command}"` : '(none given)'}.\n${USAGE}`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // Never swallowed, and never flattened into "something went wrong". The
    // name is the one fact worth keeping: each failure has a different fix.
    console.error(`desk failed — ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
