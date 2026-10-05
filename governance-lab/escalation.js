// escalation.js — the queue of actions waiting on a human.
//
// Owns data/pending/<actionId>.json and nothing else. It can park an item,
// read one, claim one and resolve one. It cannot touch the ledger: only act.js
// can do that, so approving something still goes through the one code path
// that performs side effects.
//
// Two invariants live here:
//
//   Expiry. Every read computes it. A pending item past its expiry reads as
//   denied no matter who is asking, so no caller can forget to check and no
//   item fires because someone was slow to look at the queue.
//
//   One claim. Claiming is an exclusive file create, which the filesystem
//   makes atomic. Two approvals racing cannot both win, so a single human yes
//   cannot be spent twice.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PENDING_DIR = join(HERE, 'data', 'pending');

const DEFAULT_TTL_SECONDS = 3600;

// actionIds arrive from the command line and are turned into file paths, so
// they are validated rather than trusted. UUIDs and nothing else.
const ACTION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class InvalidActionIdError extends Error {
  constructor(actionId) {
    super(`"${actionId}" is not a valid actionId`);
    this.name = 'InvalidActionIdError';
  }
}

export function pendingPath(actionId) {
  if (typeof actionId !== 'string' || !ACTION_ID.test(actionId)) {
    throw new InvalidActionIdError(actionId);
  }
  return join(PENDING_DIR, `${actionId}.json`);
}

function claimPath(actionId) {
  return `${pendingPath(actionId)}.claim`;
}

// Read at park time, not at read time, so the deadline is a property of the
// parked item. Shortening the window later cannot retroactively kill something
// already waiting, and lengthening it cannot revive something already lapsed.
export function ttlSeconds() {
  const raw = process.env.ESCALATION_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_SECONDS;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `ESCALATION_TTL_SECONDS must be a positive number of seconds, got "${raw}"`
    );
  }
  return seconds;
}

function writeItem(item, { create = false } = {}) {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    pendingPath(item.actionId),
    `${JSON.stringify(item, null, 2)}\n`,
    { encoding: 'utf8', ...(create ? { flag: 'wx' } : {}) }
  );
  return item;
}

// Everything a decision needs, in the file itself. An approver who has to go
// and look up the account age somewhere else is a signature, not a decision.
export function park(action, decision) {
  const ttl = ttlSeconds();
  const parkedAt = new Date();
  const expiresAt = new Date(parkedAt.getTime() + ttl * 1000);

  const item = {
    actionId: action.actionId,
    status: 'pending',
    ruleId: decision.ruleId,
    reason: decision.reason,
    waitingOn: decision.escalateTo,
    riskScore: decision.risk.score,
    factors: decision.risk.factors,
    parkedAt: parkedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds: ttl,
    action,
    resolution: null,
  };

  return writeItem(item, { create: true });
}

function withExpiry(item, now = new Date()) {
  const expiresAt = new Date(item.expiresAt);
  const expired = item.status === 'pending' && now >= expiresAt;

  return {
    ...item,
    expired,
    // Silence is not consent: an unanswered item reads as denied, not as held.
    effectiveStatus: expired ? 'denied' : item.status,
    effectiveReason: expired
      ? 'expired without a decision — silence is not consent'
      : (item.resolution?.reason ?? item.reason),
    msLeft: expiresAt.getTime() - now.getTime(),
  };
}

export function load(actionId) {
  const path = pendingPath(actionId);
  if (!existsSync(path)) return null;

  return withExpiry(JSON.parse(readFileSync(path, 'utf8')));
}

export function list() {
  if (!existsSync(PENDING_DIR)) return [];

  return readdirSync(PENDING_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(PENDING_DIR, name), 'utf8')))
    .map((item) => withExpiry(item))
    .sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
}

// Exclusive create: succeeds for exactly one caller, ever. Returns false for
// everyone after, which is what makes a spent approval unspendable again.
export function claim(actionId, claimant) {
  mkdirSync(PENDING_DIR, { recursive: true });

  try {
    writeFileSync(
      claimPath(actionId),
      `${JSON.stringify({ ...claimant, at: new Date().toISOString() })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function isClaimed(actionId) {
  return existsSync(claimPath(actionId));
}

export function resolve(actionId, patch) {
  const path = pendingPath(actionId);
  const current = JSON.parse(readFileSync(path, 'utf8'));

  writeItem({ ...current, ...patch });
  return load(actionId);
}
