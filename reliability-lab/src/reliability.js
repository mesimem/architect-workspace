/**
 * reliability.js — the two protections that go around a call you do not own.
 *
 * withTimeout gives one attempt a deadline. retry gives the whole operation a
 * budget. They compose in one direction only: withTimeout INSIDE, retry
 * AROUND it. The other way round you get one deadline covering all the
 * attempts, which is a stopwatch, not a timeout.
 *
 * This module knows nothing about orders or vendors. It knows about deadlines,
 * budgets, and which failures are worth trying again.
 */

import { setTimeout as sleep } from 'node:timers/promises';

/** An attempt that did not come back inside its deadline. Worth retrying. */
export class TimeoutError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'TimeoutError';
    this.deadlineMs = options.deadlineMs;
  }
}

/** The far side was there but broken — a 500-style failure. Worth retrying. */
export class UpstreamUnavailable extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'UpstreamUnavailable';
    this.status = options.status;
  }
}

/**
 * The far side answered promptly and the answer is not usable.
 *
 * NOT retryable, and that is the whole point: a wrong answer will be wrong
 * again. Retrying it just buys three copies of the same lie, more slowly.
 */
export class BadResponse extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BadResponse';
    this.received = options.received;
  }
}

/**
 * The circuit is open: we are deliberately not calling the vendor at all.
 *
 * This is not the vendor failing. This is us declining to make a call we have
 * good reason to think will fail, and failing in microseconds instead of
 * seconds so the caller can get on with its fallback.
 */
export class BreakerOpen extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BreakerOpen';
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * The retryable set, keyed on error *name* rather than on the class.
 *
 * Naming the failure is the point of the exercise: "it broke" tells you
 * nothing, and each of these three has a different correct response. Matching
 * on the name also survives an error that was rebuilt across a boundary,
 * where `instanceof` quietly stops being true.
 */
const RETRYABLE_ERROR_NAMES = new Set(['TimeoutError', 'UpstreamUnavailable']);

/**
 * Default retry policy: try again only if the next try could plausibly differ.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  return error instanceof Error && RETRYABLE_ERROR_NAMES.has(error.name);
}

/**
 * Exponential backoff with jitter.
 *
 * The doubling gap gives a struggling upstream room to recover instead of
 * being hammered while it is down. The jitter is the part people skip: without
 * it, a thousand clients that failed in the same second retry in the same
 * second, and the retry storm is now the outage.
 *
 * @param {number} attempt 1-based attempt that just failed
 * @param {number} baseDelayMs
 * @param {() => number} [random] injectable for deterministic tests
 * @returns {number} milliseconds to wait before the next attempt
 */
export function backoffDelayMs(attempt, baseDelayMs, random = Math.random) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = random() * exponential * JITTER_RATIO;
  return Math.round(exponential + jitter);
}

const JITTER_RATIO = 0.25;

/**
 * Run one attempt with a deadline.
 *
 * `fn` receives an AbortSignal and should pass it down to whatever it calls,
 * the way `fetch(url, { signal })` does. A timeout that only stops *waiting*
 * still leaves the original work running: the process hangs on to the socket,
 * the timer, and the memory. Cancelling is what makes the deadline real.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fn
 * @param {number} ms deadline for this single attempt
 * @returns {Promise<T>}
 * @throws {TimeoutError} if `fn` has not settled within `ms`
 */
export async function withTimeout(fn, ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`withTimeout needs a positive deadline, got ${ms}.`);
  }

  const controller = new AbortController();
  let timer;

  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first so the race settles as a TimeoutError deterministically,
      // then abort to tear down the work we have stopped waiting for. The
      // other order is a coin flip between TimeoutError and AbortError.
      reject(new TimeoutError(`Attempt exceeded its ${ms} ms deadline.`, { deadlineMs: ms }));
      controller.abort();
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try an operation up to `attempts` times, backing off between tries.
 *
 * The cap is not a detail. An uncapped retry against a vendor that is billing
 * per call is the difference between a bad night and a bill, and against one
 * that is down it is a denial-of-service attack you are running on yourself.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.attempts=3] hard cap on total tries
 * @param {number} [options.baseDelayMs=500] first gap, doubled each time
 * @param {(error: unknown) => boolean} [options.shouldRetry] defaults to isRetryable
 * @param {(event: object) => void} [options.onAttempt] called once per attempt
 * @param {() => number} [options.random] injectable jitter source
 * @returns {Promise<T>}
 * @throws the last error seen, unchanged — the caller needs its name
 */
export async function retry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 500,
    shouldRetry = isRetryable,
    onAttempt,
    random,
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`retry needs at least 1 attempt, got ${attempts}.`);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const value = await fn(attempt);
      onAttempt?.({ attempt, attempts, outcome: 'success' });
      return value;
    } catch (error) {
      const retryable = shouldRetry(error);
      const isLast = attempt >= attempts;
      const willRetry = retryable && !isLast;
      const delayMs = willRetry ? backoffDelayMs(attempt, baseDelayMs, random) : undefined;

      onAttempt?.({
        attempt,
        attempts,
        outcome: 'failure',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        retryable,
        willRetry,
        delayMs,
      });

      // Rethrown as-is. Wrapping it here would bury the name the caller needs
      // under a generic "retries exhausted", which is the failure telling you
      // it failed and nothing else.
      if (!willRetry) throw error;

      await sleep(delayMs);
    }
  }
}

/**
 * The message came back fine and is not good enough to send.
 *
 * This is a different kind of failure from the ones above, and that is the
 * point of having it: reliability's job ends when an answer arrives. Whether
 * the answer is worth putting in front of a customer is a separate question,
 * asked by a separate layer, and both are cheap.
 */
export class QualityGateRejected extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'QualityGateRejected';
    this.score = options.score;
    this.reasons = options.reasons ?? [];
  }
}

export const QUALITY_THRESHOLD = 70;

const BANNED_PHRASES = ['as an ai', 'i cannot', "i'm sorry", 'as a language model'];
const MIN_MESSAGE_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 300;

const escapeForRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Score a message out of 100, and say what it lost points for.
 *
 * Three cheap, explainable checks. Nothing here is clever, and that is a
 * feature: a gate whose verdict you cannot explain to the person whose
 * message it blocked is a gate nobody will leave switched on.
 *
 * @param {unknown} message
 * @param {string} orderId
 * @returns {{score: number, checks: Array<object>, reasons: string[]}}
 */
export function scoreBreakdown(message, orderId) {
  const text = typeof message === 'string' ? message : '';

  // \b so "5001" does not match inside "15001" — a confirmation for a
  // different, longer order number would otherwise score full marks here.
  const mentionsOrder = new RegExp(`\\b${escapeForRegExp(orderId)}\\b`).test(text);
  const bannedHit = BANNED_PHRASES.find((phrase) => text.toLowerCase().includes(phrase));
  const lengthOk = text.length >= MIN_MESSAGE_LENGTH && text.length <= MAX_MESSAGE_LENGTH;

  const checks = [
    {
      name: 'mentions-order-id',
      possible: 40,
      earned: mentionsOrder ? 40 : 0,
      reason: mentionsOrder ? null : `does not contain order id ${orderId} as a whole token`,
    },
    {
      name: 'no-banned-phrases',
      possible: 30,
      earned: bannedHit ? 0 : 30,
      reason: bannedHit ? `contains the banned phrase "${bannedHit}"` : null,
    },
    {
      name: 'sensible-length',
      possible: 30,
      earned: lengthOk ? 30 : 0,
      reason: lengthOk
        ? null
        : `length ${text.length} is outside ${MIN_MESSAGE_LENGTH}-${MAX_MESSAGE_LENGTH} characters`,
    },
  ];

  return {
    score: checks.reduce((total, check) => total + check.earned, 0),
    checks,
    reasons: checks.filter((check) => check.earned === 0).map((check) => check.reason),
  };
}

/**
 * The score on its own, 0 to 100.
 *
 * @param {unknown} message
 * @param {string} orderId
 * @returns {number}
 */
export function score(message, orderId) {
  return scoreBreakdown(message, orderId).score;
}

/**
 * Refuse to pass on a message that scores below the threshold.
 *
 * @throws {QualityGateRejected} carrying the score and every lost point
 */
export function assertQuality(message, orderId, threshold = QUALITY_THRESHOLD) {
  const breakdown = scoreBreakdown(message, orderId);

  if (breakdown.score < threshold) {
    throw new QualityGateRejected(
      `scored ${breakdown.score}/100, below the threshold of ${threshold} — ${breakdown.reasons.join('; ')}`,
      { score: breakdown.score, reasons: breakdown.reasons },
    );
  }

  return breakdown;
}

/**
 * A second arrival found the key claimed but not yet finished.
 *
 * We cannot return a result we do not have, and we must not run the work
 * again, so the only honest answer is to refuse and let the caller decide.
 */
export class DuplicateInFlight extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DuplicateInFlight';
    this.key = options.key;
  }
}

/**
 * Run `fn` at most once per key, ever, and return the stored result after that.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE POINT. The claim is written before
 * `fn` runs, not after. "Do the work, then record that we did it" leaves a
 * window — however small — in which two arrivals both read "not sent yet",
 * both decide to send, and the customer gets two emails. Claiming first means
 * the second arrival finds the claim even though the first has not finished.
 *
 * A claim carries a lease. If a process dies between claiming and finishing,
 * the key would otherwise be poisoned forever and that order could never be
 * sent by anyone — so a claim older than `leaseMs` is reclaimable.
 *
 * @template T
 * @param {string} key stable, derived from the work itself
 * @param {() => Promise<T>} fn the side effect to protect
 * @param {object} options
 * @param {{get: Function, put: Function, remove: Function}} options.store
 * @param {() => number} [options.now]
 * @param {number} [options.leaseMs=60000]
 * @param {(event: object) => void} [options.onEvent]
 * @returns {Promise<{value: T, duplicate: boolean}>}
 * @throws {DuplicateInFlight} if another live claim holds the key
 */
export async function runOnce(key, fn, options = {}) {
  const { store, now = Date.now, leaseMs = 60_000, onEvent } = options;
  if (!store) throw new TypeError('runOnce needs a store to persist its keys.');

  const existing = await store.get(key);

  if (existing?.state === 'completed') {
    onEvent?.({ type: 'duplicate', key, completedAt: existing.completedAt });
    return { value: existing.result, duplicate: true };
  }

  if (existing?.state === 'claimed') {
    const ageMs = now() - (Date.parse(existing.claimedAt ?? '') || 0);
    if (ageMs < leaseMs) {
      throw new DuplicateInFlight(`Key ${key} is already in flight; not running it twice.`, { key });
    }
    onEvent?.({ type: 'lease_expired', key, ageMs });
  }

  const claimedAt = new Date(now()).toISOString();
  await store.put(key, { state: 'claimed', claimedAt });
  onEvent?.({ type: 'claimed', key });

  let value;
  try {
    value = await fn();
  } catch (error) {
    // Release the claim. Holding it would convert one failed send into an
    // order that can never be sent again — the protection eating the work it
    // was meant to protect.
    await store.remove(key);
    onEvent?.({ type: 'released', key, errorName: error instanceof Error ? error.name : 'UnknownError' });
    throw error;
  }

  await store.put(key, {
    state: 'completed',
    claimedAt,
    completedAt: new Date(now()).toISOString(),
    result: value,
  });
  onEvent?.({ type: 'stored', key });

  return { value, duplicate: false };
}

export const BREAKER_CLOSED = 'closed';
export const BREAKER_OPEN = 'open';
export const BREAKER_HALF_OPEN = 'half_open';

/** The state of a breaker that has never seen a failure. */
export function initialBreakerState() {
  return {
    state: BREAKER_CLOSED,
    consecutiveFailures: 0,
    openedAt: null,
    openUntil: null,
    lastErrorName: null,
  };
}

/**
 * Accept only a state we recognise. A truncated or hand-edited breaker file
 * should not crash the desk, but it must not be trusted either: the safe
 * reading of "I cannot tell" is "closed", because that costs one real call to
 * find out rather than blocking every call on a corrupt byte.
 */
function normaliseState(raw) {
  const valid =
    raw &&
    typeof raw === 'object' &&
    [BREAKER_CLOSED, BREAKER_OPEN, BREAKER_HALF_OPEN].includes(raw.state) &&
    Number.isInteger(raw.consecutiveFailures);

  return valid ? { ...initialBreakerState(), ...raw } : initialBreakerState();
}

/**
 * A circuit breaker that survives process exit.
 *
 * WHERE IT GOES: around the retry, never inside it. Inside, each retry reports
 * its own little failure and the counter resets on every new operation, so the
 * breaker never trips and is decoration. Outside, the whole operation —
 * all three attempts, the backoff, the lot — counts as the single failure it
 * actually was, and three of those trip it.
 *
 * The state lives in a store the caller supplies, so a run of the command that
 * trips the breaker is still remembered by the next, separate run. A breaker
 * that forgets everything when the process exits protects a long-running
 * server and does nothing at all for a CLI.
 */
export class CircuitBreaker {
  /**
   * @param {object} options
   * @param {{load: () => Promise<object|null>, save: (s: object) => Promise<void>}} options.store
   * @param {number} [options.threshold=3] consecutive failed operations before opening
   * @param {number} [options.cooldownMs=10000] how long to stay open
   * @param {() => number} [options.now] injectable clock
   * @param {(event: object) => void} [options.onEvent] observability hook
   */
  constructor({ store, threshold = 3, cooldownMs = 10_000, now = Date.now, onEvent } = {}) {
    if (!store) throw new TypeError('CircuitBreaker needs a store to persist its state.');
    this.store = store;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.onEvent = onEvent;
  }

  /** Read the current state without changing it — for reporting. */
  async inspect() {
    return normaliseState(await this.store.load());
  }

  /**
   * Run one operation under the breaker.
   *
   * @template T
   * @param {() => Promise<T>} fn the whole protected operation, retries included
   * @returns {Promise<T>}
   * @throws {BreakerOpen} instantly, without calling `fn`, while the circuit is open
   */
  async execute(fn) {
    const state = normaliseState(await this.store.load());
    const now = this.now();

    let isProbe = false;

    if (state.state === BREAKER_OPEN) {
      const remainingMs = (Date.parse(state.openUntil ?? '') || 0) - now;

      if (remainingMs > 0) {
        this.onEvent?.({ type: 'rejected', remainingMs, consecutiveFailures: state.consecutiveFailures });
        throw new BreakerOpen(
          `Circuit open after ${state.consecutiveFailures} consecutive failures; ` +
            `not calling the vendor for another ${(remainingMs / 1000).toFixed(1)} s.`,
          { retryAfterMs: remainingMs },
        );
      }

      // Cooldown elapsed. Exactly one call gets through to find out whether
      // the far side is back. Persisting half_open BEFORE making it is what
      // makes it exactly one: a second process starting now sees the slot is
      // already taken rather than probing in parallel.
      isProbe = true;
      await this.store.save({ ...state, state: BREAKER_HALF_OPEN });
      this.onEvent?.({ type: 'probe' });
    }

    try {
      const value = await fn();
      await this.store.save(initialBreakerState());
      this.onEvent?.({ type: isProbe ? 'closed_after_probe' : 'success' });
      return value;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const consecutiveFailures = state.consecutiveFailures + 1;

      // A failed probe re-opens immediately — it already had its second
      // chance, and making it earn three more failures would send three more
      // doomed operations at an upstream we just watched fail.
      const shouldOpen = isProbe || consecutiveFailures >= this.threshold;

      await this.store.save(
        shouldOpen
          ? {
              state: BREAKER_OPEN,
              consecutiveFailures,
              openedAt: new Date(now).toISOString(),
              openUntil: new Date(now + this.cooldownMs).toISOString(),
              lastErrorName: errorName,
            }
          : { ...initialBreakerState(), consecutiveFailures, lastErrorName: errorName },
      );

      this.onEvent?.({
        type: shouldOpen ? (isProbe ? 'reopened' : 'opened') : 'failure',
        errorName,
        consecutiveFailures,
        cooldownMs: shouldOpen ? this.cooldownMs : undefined,
      });

      // The breaker observes; it does not translate. The caller still needs
      // the original name to decide between falling back and dead-lettering.
      throw error;
    }
  }
}
