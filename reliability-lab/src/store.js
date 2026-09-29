/**
 * store.js — everything the lab writes to disk, in one place.
 *
 * Three files, three different jobs:
 *   sent.log         append-only.  What the customer got. Never rewritten.
 *   breaker.json     read-modify-write.  One small object, the circuit state.
 *   dead-letter.jsonl  a work queue.  Orders that could not be sent, and why.
 *
 * Keeping the file handles here means desk.js can be read as policy — what we
 * do when the vendor misbehaves — rather than as plumbing.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Anchored to this file, not the shell's cwd, so the data lands in the same
// place whether you run from the repo root or from inside the folder.
export const DATA_DIR = join(HERE, '..', 'data');
export const SENT_LOG = join(DATA_DIR, 'sent.log');
export const BREAKER_FILE = join(DATA_DIR, 'breaker.json');
export const DEAD_LETTER_FILE = join(DATA_DIR, 'dead-letter.jsonl');
export const KEYS_FILE = join(DATA_DIR, 'keys.json');

const ensureDataDir = () => mkdir(DATA_DIR, { recursive: true });

/**
 * Replace a file's contents without ever leaving it half-written.
 *
 * Write to a temp file, then rename over the target — rename is atomic on
 * both POSIX and NTFS, so a crash mid-write loses the new contents rather
 * than shredding the old ones. This matters most for dead-letter.jsonl: that
 * file IS the record of unfinished work, and a truncated one loses orders.
 */
async function writeAtomic(path, contents) {
  await ensureDataDir();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

/** Read a file, treating "not there yet" as empty rather than as an error. */
async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Append one confirmation to the send log.
 *
 * One line, one JSON object, newline-terminated — so a partially written
 * final line is visibly incomplete rather than silently corrupting the file.
 * `fallback` is always present, true or false, so nothing downstream has to
 * guess what a missing key meant.
 *
 * @param {{orderId: string, message: string, fallback: boolean, correlationId: string}} record
 * @returns {Promise<string>} the exact line written
 */
export async function appendSent({ orderId, message, fallback, correlationId }) {
  const line = JSON.stringify({
    orderId,
    correlationId,
    message,
    sentAt: new Date().toISOString(),
    fallback: Boolean(fallback),
  });
  await ensureDataDir();
  await appendFile(SENT_LOG, line + '\n', 'utf8');
  return line;
}

/** A load/save pair for CircuitBreaker, backed by data/breaker.json. */
export function createBreakerStore() {
  return {
    async load() {
      const text = await readIfPresent(BREAKER_FILE);
      if (text.trim() === '') return null;
      try {
        return JSON.parse(text);
      } catch {
        // A corrupt breaker file is not worth crashing the desk over. The
        // breaker treats null as "closed" and one real call re-establishes
        // the truth. Not swallowed silently — it is reported to stderr.
        console.error(`warning: ${BREAKER_FILE} is not valid JSON; treating the circuit as closed`);
        return null;
      }
    },
    async save(state) {
      await writeAtomic(BREAKER_FILE, JSON.stringify(state, null, 2) + '\n');
    },
  };
}

/**
 * A get/put/remove trio for runOnce, backed by data/keys.json.
 *
 * Unlike the breaker file, a damaged keys file is NOT shrugged off. The
 * breaker guessing wrong costs one wasted call; this file guessing wrong
 * costs a duplicate send to a real customer, so a corrupt one is a hard stop.
 */
export function createKeyStore() {
  const readAll = async () => {
    const text = await readIfPresent(KEYS_FILE);
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${KEYS_FILE} is not valid JSON, so past sends cannot be read. ` +
          'Refusing to send rather than risk sending twice.',
        { cause: error },
      );
    }
  };

  const writeAll = (all) => writeAtomic(KEYS_FILE, JSON.stringify(all, null, 2) + '\n');

  return {
    async get(key) {
      return (await readAll())[key] ?? null;
    },
    async put(key, record) {
      const all = await readAll();
      all[key] = record;
      await writeAll(all);
    },
    async remove(key) {
      const all = await readAll();
      delete all[key];
      await writeAll(all);
    },
  };
}

/**
 * Every order currently parked, in the order they were parked.
 *
 * @returns {Promise<Array<{orderId: string, errorName: string, reason: string, failedAt: string}>>}
 */
export async function readDeadLetter() {
  const text = await readIfPresent(DEAD_LETTER_FILE);
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Replace the queue wholesale — used by replay once it knows what survived. */
export async function writeDeadLetter(entries) {
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeAtomic(DEAD_LETTER_FILE, entries.length === 0 ? '' : body + '\n');
}

/**
 * Park an order that could not be sent, keyed on orderId.
 *
 * Upsert, not append: an order that fails five times is one piece of
 * unfinished work, not five. Appending blindly would turn one stuck order
 * into a queue that grows every time you replay it.
 *
 * Extra fields (the quality score and what it lost points for) ride along
 * unchanged — whoever triages this row needs the verdict, not just the label.
 *
 * @param {{orderId: string, errorName: string, reason: string, correlationId: string}} failure
 * @returns {Promise<object>} the entry as stored
 */
export async function parkDeadLetter({ orderId, errorName, reason, correlationId, ...extra }) {
  const entry = {
    orderId,
    correlationId,
    errorName,
    reason,
    ...extra,
    failedAt: new Date().toISOString(),
  };
  const existing = await readDeadLetter();
  const index = existing.findIndex((row) => row.orderId === orderId);

  if (index === -1) existing.push(entry);
  else existing[index] = { ...existing[index], ...entry };

  await writeDeadLetter(existing);
  return entry;
}
