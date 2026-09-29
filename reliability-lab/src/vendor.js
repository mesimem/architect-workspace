/**
 * vendor.js — a stand-in for an outside AI service that writes confirmation
 * messages.
 *
 * WHY THIS EXISTS: in real life this is somebody else's server. You cannot ask
 * a real vendor to start timing out at 21:00 so you can watch what your code
 * does. So tonight you own one that fails on command.
 *
 * Behaviour is chosen by the VENDOR_MODE environment variable (default "ok"):
 *
 *   ok      ~50 ms, then a correct message.
 *   slow    hangs for 10 s, then the same correct message. Not an error —
 *           that is the point. Nothing here ever gives up.
 *   down    throws a 500-style error.
 *   garbage fast, but confidently wrong: either a different order number or a
 *           refusal that a human would never accept as a confirmation.
 *
 * This module is the *unreliable* half of the lab and is meant to stay that
 * way. Do not add timeouts or retries in here — the caller is what we are
 * trying to harden, and a vendor that protects you is not a vendor.
 *
 * It does accept an AbortSignal, exactly as `fetch(url, { signal })` does.
 * That is not the vendor protecting you; it is the vendor letting you hang up.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_MODE = 'ok';
const SLOW_DELAY_MS = 10_000;
const OK_DELAY_MS = 50;

export const VENDOR_MODES = ['ok', 'slow', 'down', 'garbage'];

/** An upstream failure, carrying the status a real HTTP client would surface. */
export class VendorError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VendorError';
    this.status = status;
  }
}

/** The message the desk is hoping for. */
const goodMessage = (orderId) =>
  `Your order ${orderId} is confirmed and will ship within 2 days.`;

/**
 * Read the mode from the environment. An unrecognised value is a
 * configuration mistake, so it is refused loudly rather than silently
 * treated as "ok" — a lab that quietly ignores your setting teaches nothing.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} one of VENDOR_MODES
 */
export function resolveMode(env = process.env) {
  const raw = env.VENDOR_MODE;
  if (raw === undefined || raw === '') return DEFAULT_MODE;
  const mode = raw.trim().toLowerCase();
  if (!VENDOR_MODES.includes(mode)) {
    throw new VendorError(
      `Unknown VENDOR_MODE "${raw}". Expected one of: ${VENDOR_MODES.join(', ')}.`,
      400,
    );
  }
  return mode;
}

/**
 * Ask the vendor to write a confirmation message for an order.
 *
 * @param {string} orderId
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {AbortSignal} [options.signal] hang up early; rejects with AbortError
 * @returns {Promise<string>} the message, whatever its quality
 * @throws {VendorError} in "down" mode, or on a bad VENDOR_MODE
 */
export async function fetchConfirmationMessage(orderId, options = {}) {
  const { env = process.env, signal } = options;
  const mode = resolveMode(env);

  switch (mode) {
    case 'ok':
      await sleep(OK_DELAY_MS, undefined, { signal });
      return goodMessage(orderId);

    case 'slow':
      // Ten seconds of nothing. No error, no progress, no way for the caller
      // to tell this apart from a vendor that is never coming back.
      await sleep(SLOW_DELAY_MS, undefined, { signal });
      return goodMessage(orderId);

    case 'down':
      await sleep(OK_DELAY_MS, undefined, { signal });
      throw new VendorError('Vendor unavailable: 500 Internal Server Error', 500);

    case 'garbage': {
      // Fast and wrong — the failure mode that looks like success. Half the
      // time it confirms an order nobody placed; half the time it refuses in
      // the unmistakable voice of a model that has lost the plot.
      const wrongOrderId = String(Number(orderId) + 7 || 'X-0000');
      const replies = [
        goodMessage(wrongOrderId),
        'As an AI I cannot confirm orders or provide shipping information.',
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    default:
      // Unreachable: resolveMode has already rejected anything else.
      throw new VendorError(`Unhandled vendor mode "${mode}".`, 500);
  }
}
