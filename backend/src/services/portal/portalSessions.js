// STORY-005: what the customer holds after they log in, and when it stops working.
//
// A password is presented once. Everything after that is a session, and the
// two failure paths this story names - "session timeout" and "unauthorized
// access" - both live here rather than in the credential module.
//
// WHAT IS STORED IS A DIGEST, NOT THE TOKEN. The customer gets 32 random
// bytes; this store keeps only their SHA-256 digest. That means the session
// file on disk (see ../shared/jsonFileStore.js) is not a list of working
// credentials: someone who reads it cannot replay a single session, because
// they cannot invert the digest. It is the same reason a password table stores
// hashes, applied to the thing the password issues. There is no salt and no
// KDF here on purpose - unlike a password, the token is 256 bits of uniform
// randomness, so there is nothing to guess and nothing to precompute.
//
// TWO CLOCKS, NOT ONE. Both are needed and they answer different questions.
//   - IDLE timeout: has this customer done anything recently? Slides forward
//     on every request. This is what closes the laptop-left-in-a-hotel-lobby
//     hole, and it is what "session timeout" in the story means.
//   - ABSOLUTE lifetime: how long may one login last, no matter how busy?
//     Never slides. Without it, a stolen token that is used steadily is valid
//     forever, because the idle clock keeps being reset by the thief.
// A session dies at whichever comes first.
//
// EXPIRY DELETES. An expired row is removed the moment it is found rather than
// left in place and filtered on read. A row that still exists but "does not
// count" is one careless read away from being honoured.
//
// NOT IDEMPOTENT, DELIBERATELY. Every other side effect in this repo is keyed
// so a retry cannot duplicate it. Session creation is the exception: two
// logins must produce two independent tokens, or logging in on a phone would
// silently hand back the token already on a desktop and logging out of one
// would log out the other. The thing that must not duplicate here is the
// LOGIN AUDIT ENTRY, and that is keyed - see portalLoginService.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Verification returns { ok: false, reason }
//     for every rejection - unknown, idle-expired, absolute-expired. It never
//     throws on the request path, because a bad token is a normal event. Only
//     misconfiguration (a nonsensical timeout) throws, at load.
//  2. Will it retry? No. The only I/O is a local synchronous file write.
//  3. Recovery path? Sessions are disposable by definition: the recovery for
//     any lost or corrupt session state is that the customer logs in again.
//     This is the one store in the repo where losing rows is acceptable, which
//     is exactly why sessions must never be the audit trail.
//  4. Handled here: unknown/malformed/absent tokens, both expiries, logout,
//     replay of a logged-out token, unbounded session growth per customer, and
//     a token being readable from the store. NOT handled: revoking every
//     session for a customer at once (STORY-006 territory, with the
//     permission changes that would motivate it), device binding, refresh
//     tokens, and cross-process locking - single process, same as every other
//     store here.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise. A restart
// logging everyone out is survivable; see recovery, above.
const SESSIONS = createJsonFileStore("portal-sessions");

const TOKEN_BYTES = 32;

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_ABSOLUTE_HOURS = 12;

// One customer, many devices - but not unbounded. Without a cap, a script that
// logs in in a loop grows the store forever, which is a disk-fill with valid
// credentials. The oldest session is evicted, so the attack costs the attacker
// their own earlier sessions rather than costing us the store.
const MAX_SESSIONS_PER_CUSTOMER = 10;

const REASONS = {
  OK: "ok",
  MALFORMED_TOKEN: "malformed_token",
  UNKNOWN_SESSION: "unknown_session",
  IDLE_TIMEOUT: "idle_timeout",
  ABSOLUTE_TIMEOUT: "absolute_timeout",
};

class PortalSessionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "PortalSessionConfigError";
    this.errorClass = "ConfigError";
  }
}

// Read once at load, per 12-factor. Refuses a value it cannot use rather than
// falling back to the default: an operator who sets IDLE_MINUTES=0 meaning
// "never expire" would otherwise get 30 minutes and no warning, and an
// operator who typos it would get a silently different security posture.
function positiveNumberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PortalSessionConfigError(
      name + " must be a positive number of minutes/hours; received " + JSON.stringify(raw) + "."
    );
  }
  return value;
}

const IDLE_TIMEOUT_MS =
  positiveNumberFromEnv("COLABERRY_PORTAL_SESSION_IDLE_MINUTES", DEFAULT_IDLE_MINUTES) * 60 * 1000;
const ABSOLUTE_LIFETIME_MS =
  positiveNumberFromEnv("COLABERRY_PORTAL_SESSION_ABSOLUTE_HOURS", DEFAULT_ABSOLUTE_HOURS) *
  60 *
  60 *
  1000;

// base64url: safe in an Authorization header, a URL and a log line without
// escaping. Not that the token should ever reach a log line.
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function digestOf(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// Cheap shape check before hashing. Rejects the empty string, a number, and a
// stray object without doing any work.
function isPlausibleToken(token) {
  return typeof token === "string" && token.length >= 16 && token.length <= 256;
}

// The caller gets a copy, never the stored object. Freezing alone would not be
// enough - a caller holding the real row could keep a reference to a session
// that is later revoked.
function publicView(session) {
  return {
    sessionId: session.sessionId,
    customerId: session.customerId,
    role: session.role,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    idleExpiresAt: session.idleExpiresAt,
  };
}

function isExpired(session, now) {
  if (now >= session.absoluteExpiresAt) {
    return REASONS.ABSOLUTE_TIMEOUT;
  }
  if (now >= session.idleExpiresAt) {
    return REASONS.IDLE_TIMEOUT;
  }
  return null;
}

// Drops every expired row. Exported so a caller can sweep on a timer; also run
// on each create, so a portal in normal use never accumulates dead rows even
// if nobody schedules the sweep.
function purgeExpiredSessions(now = Date.now()) {
  let purged = 0;
  for (const digest of Array.from(SESSIONS.keys())) {
    const session = SESSIONS.get(digest);
    if (!session || isExpired(session, now)) {
      SESSIONS.delete(digest);
      purged += 1;
    }
  }
  return purged;
}

function sessionsFor(customerId) {
  const owned = [];
  for (const digest of Array.from(SESSIONS.keys())) {
    const session = SESSIONS.get(digest);
    if (session && session.customerId === customerId) {
      owned.push({ digest: digest, session: session });
    }
  }
  return owned.sort(function (a, b) {
    return a.session.createdAt - b.session.createdAt;
  });
}

// Returns { token, session }. THE TOKEN IS RETURNED EXACTLY ONCE - it is not
// stored and cannot be recovered afterwards, only replaced by logging in
// again. `now` is injectable so the expiry tests do not have to sleep.
function createSession({ customerId, role = "customer" }, now = Date.now()) {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    // A programming error in the caller, not a runtime condition: the login
    // service only reaches here after credentials verified, so it knows who
    // this is. Throwing beats minting a session belonging to nobody.
    throw new PortalSessionConfigError("createSession requires a non-empty customerId.");
  }

  purgeExpiredSessions(now);

  const owned = sessionsFor(customerId);
  // >= because the session about to be created is the (n+1)th.
  while (owned.length >= MAX_SESSIONS_PER_CUSTOMER) {
    SESSIONS.delete(owned.shift().digest);
  }

  const token = mintToken();
  const session = Object.freeze({
    sessionId: crypto.randomUUID(),
    customerId: customerId,
    role: role,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: now + IDLE_TIMEOUT_MS,
    absoluteExpiresAt: now + ABSOLUTE_LIFETIME_MS,
  });

  SESSIONS.set(digestOf(token), session);

  return { token: token, session: publicView(session) };
}

// The request path. Returns { ok: true, session } or { ok: false, reason }.
//
// Verifying SLIDES the idle clock, which is what makes it an idle timeout
// rather than a fixed one. The absolute deadline is copied forward untouched -
// getting that wrong is how a "12 hour maximum" quietly becomes unlimited.
function verifySession(token, now = Date.now()) {
  if (!isPlausibleToken(token)) {
    return { ok: false, reason: REASONS.MALFORMED_TOKEN };
  }

  const digest = digestOf(token);
  const session = SESSIONS.get(digest);
  if (!session) {
    return { ok: false, reason: REASONS.UNKNOWN_SESSION };
  }

  const expiry = isExpired(session, now);
  if (expiry) {
    SESSIONS.delete(digest);
    return { ok: false, reason: expiry };
  }

  const slid = Object.freeze(
    Object.assign({}, session, { lastSeenAt: now, idleExpiresAt: now + IDLE_TIMEOUT_MS })
  );
  SESSIONS.set(digest, slid);

  return { ok: true, reason: REASONS.OK, session: publicView(slid) };
}

// Logout. Returns whether a live session was actually ended, so the caller can
// audit "logged out" separately from "presented a token that was already
// dead". Safe to call twice: the second call is simply false.
function revokeSession(token) {
  if (!isPlausibleToken(token)) {
    return false;
  }
  return SESSIONS.delete(digestOf(token));
}

function countSessions() {
  return SESSIONS.size;
}

module.exports = {
  createSession,
  verifySession,
  revokeSession,
  purgeExpiredSessions,
  countSessions,
  PortalSessionConfigError,
  REASONS,
  IDLE_TIMEOUT_MS,
  ABSOLUTE_LIFETIME_MS,
  MAX_SESSIONS_PER_CUSTOMER,
};
