// STORY-005: what a customer knows, and how we check it without ever holding it.
//
// This is the first module in this repo that handles a password. Everything
// before it authenticated with a static bearer token read from the
// environment (see ../../http/auth.js), which is fine for a service-to-service
// call and useless for a human logging in to a portal.
//
// THE THREE RULES THIS MODULE EXISTS TO ENFORCE
//
//  1. A PLAINTEXT PASSWORD IS NEVER STORED, and never leaves this module. What
//     is stored is a scrypt hash with a per-user random salt. Someone who
//     steals the credential table cannot log in with it, and - because the
//     salts differ - cannot attack two users with one precomputed table.
//
//  2. NOTHING HERE LOGS. Not the password, not the hash, not the userId. That
//     is not an oversight to be fixed later: this module has no logging
//     surface at all, so no future edit can accidentally put a credential in a
//     log line. Auditing a login attempt is the caller's job, and the caller
//     (portalLoginService) receives only a reason CODE, never the secret.
//
//  3. AN UNKNOWN USER COSTS THE SAME AS A WRONG PASSWORD. The obvious
//     implementation returns early when the userId is not in the table, and
//     that early return is a user-enumeration oracle: an attacker measures the
//     response and learns which customer IDs are real, which is exactly the
//     list they want before mounting a password attack. So an unknown user is
//     verified against a decoy hash and pays the full scrypt cost.
//
// WHY scrypt AND NOT bcrypt OR argon2. Both are better-known choices and both
// are npm dependencies. CLAUDE.md classifies introducing an external
// dependency as a decision to escalate, and node's crypto module ships scrypt
// (RFC 7914), which is a memory-hard KDF designed for exactly this. The cost
// parameters are stored inside each hash string, so they can be raised later
// without invalidating existing hashes - see COST PARAMETERS below.
//
// COST PARAMETERS live in the hash, not in this file's constants, on purpose.
// A hash reads scrypt$N$r$p$salt$key. Verification uses the parameters found
// in the stored string, so raising DEFAULT_PARAMS tomorrow re-hashes new
// passwords at the new cost while every existing hash still verifies. The
// alternative - global constants used for both - locks the cost in forever.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Two distinct kinds of failure, deliberately
//     handled differently. A bad CONFIGURATION throws (PortalCredentialError)
//     because a credential table that will not parse must stop the server, not
//     degrade it. A bad LOGIN returns { ok: false, reason }, because a wrong
//     password is a normal event, not an exception.
//  2. Will it retry? No. The only work is local CPU. There is nothing to
//     retry and nothing that can be flaky.
//  3. Recovery path? A malformed table is fixed by correcting the environment
//     variable and restarting; the error names the problem without echoing the
//     entry, since the entry contains a hash.
//  4. Handled here: missing/empty/malformed config, duplicate userIds, an
//     unparseable or truncated hash, wrong password, unknown user, non-string
//     and oversized inputs, and timing leaks on both the compare and the
//     unknown-user path. NOT handled: password rotation, expiry, reuse
//     history, breach-list checks, and lockout after repeated failures -
//     lockout belongs to the login service, which is the only place that can
//     see attempts over time.

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

// N=16384, r=8, p=1 is the interactive-login baseline from the scrypt paper:
// roughly 16 MB of memory and ~50-100 ms per hash on ordinary hardware. Slow
// enough to make offline cracking expensive, fast enough that a customer does
// not notice it while logging in.
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

// scrypt needs 128 * N * r bytes. Node's default maxmem is 32 MB, which the
// parameters above only just fit under; stating it explicitly means raising N
// later fails with a clear error here rather than a cryptic one from OpenSSL.
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;

// Bounds the work an unauthenticated caller can ask for. scrypt's cost barely
// moves with password length, but hashing a 10 MB "password" is still free
// work for an attacker and none for us.
const MAX_PASSWORD_BYTES = 1024;

// Applies to hashPassword only - to passwords we are CREATING. Verification
// deliberately does not enforce it: a rule tightened tomorrow must not lock
// out a customer whose existing password predates it.
const MIN_NEW_PASSWORD_LENGTH = 12;

// Reason codes. These are for the audit trail and for tests. They are NOT for
// the customer: the login service collapses all of them into one "invalid
// credentials" message, because telling a caller which half of the pair was
// wrong hands them the other half for free.
const REASONS = {
  OK: "ok",
  UNKNOWN_USER: "unknown_user",
  BAD_PASSWORD: "bad_password",
  MALFORMED_INPUT: "malformed_input",
  UNUSABLE_HASH: "unusable_hash",
};

class PortalCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "PortalCredentialError";
    this.errorClass = "ConfigError";
  }
}

// A decoy that no password can ever match, built once at load. Its only job is
// to give the unknown-user path the same scrypt cost as the wrong-password
// path (rule 3 above). Random rather than a fixed constant so it is not a
// recognisable marker in a memory dump.
const DECOY_HASH = encodeHash(DEFAULT_PARAMS, crypto.randomBytes(16), crypto.randomBytes(KEY_LENGTH));

function encodeHash(params, salt, key) {
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

// Returns null rather than throwing: a hash can arrive from a config file
// written by a human, and the caller decides whether that is fatal (loading
// the table) or just a failed login (verifying against a corrupt row).
function decodeHash(encoded) {
  if (typeof encoded !== "string") {
    return null;
  }
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // N must be a power of two greater than 1 - scrypt rejects anything else,
  // and catching it here gives a clear reason instead of an OpenSSL error.
  if (!Number.isSafeInteger(N) || N < 2 || (N & (N - 1)) !== 0) {
    return null;
  }
  if (!Number.isSafeInteger(r) || r < 1 || !Number.isSafeInteger(p) || p < 1) {
    return null;
  }
  const salt = Buffer.from(parts[4], "base64");
  const key = Buffer.from(parts[5], "base64");
  // Buffer.from ignores invalid base64 rather than failing, so a truncated or
  // corrupted field shows up as a short buffer. Both are checked.
  //
  // THE KEY LENGTH IS EXACT, AND THAT MATTERS. The first version of this
  // accepted any key of 16 bytes or more and then derived a key of whatever
  // length it found - which its own test caught as a live hole: scrypt's
  // 30-byte output is the first 30 bytes of its 32-byte output, so chopping
  // four characters off a stored hash produced a hash that STILL VERIFIED
  // while comparing fewer bytes. Anyone able to corrupt the credential table
  // could weaken the check without breaking it. An unexpected length is now a
  // refusal, and derivation below always asks for KEY_LENGTH.
  if (salt.length < 8 || key.length !== KEY_LENGTH) {
    return null;
  }
  return { params: { N: N, r: r, p: p }, salt: salt, key: key };
}

function isUsablePassword(password) {
  return (
    typeof password === "string" &&
    password.length > 0 &&
    Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES
  );
}

// Hashes a NEW password. Used by scripts/hashPortalPassword.js and by tests.
// Never called on the login path - logging in verifies, it does not re-hash.
async function hashPassword(password, params = DEFAULT_PARAMS) {
  if (typeof password !== "string" || password.length < MIN_NEW_PASSWORD_LENGTH) {
    throw new PortalCredentialError(
      "A new portal password must be a string of at least " +
        MIN_NEW_PASSWORD_LENGTH +
        " characters."
    );
  }
  if (!isUsablePassword(password)) {
    throw new PortalCredentialError(
      "A portal password may not exceed " + MAX_PASSWORD_BYTES + " bytes."
    );
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY_BYTES,
  });
  return encodeHash(params, salt, key);
}

// Constant-time by construction: both sides are scrypt outputs of the same
// declared length, and the length is compared first because timingSafeEqual
// throws on a mismatch - and a throw is itself a timing signal.
async function verifyPassword(password, encoded) {
  const decoded = decodeHash(encoded);
  if (!decoded || !isUsablePassword(password)) {
    return false;
  }
  let derived;
  try {
    // KEY_LENGTH, never decoded.key.length - see decodeHash.
    derived = await scrypt(password, decoded.salt, KEY_LENGTH, {
      N: decoded.params.N,
      r: decoded.params.r,
      p: decoded.params.p,
      maxmem: MAX_MEMORY_BYTES,
    });
  } catch (error) {
    // Only reachable from parameters this process would refuse to create -
    // an absurd N in a hand-edited hash, say. Not a valid login either way.
    return false;
  }
  return derived.length === decoded.key.length && crypto.timingSafeEqual(derived, decoded.key);
}

// Parses COLABERRY_PORTAL_CREDENTIALS into Map<customerId, encodedHash>.
//
//   COLABERRY_PORTAL_CREDENTIALS="CUST-1:scrypt$16384$8$1$<salt>$<key>,CUST-2:scrypt$..."
//
// Split on the FIRST colon only: a hash contains "$" and base64, never ":",
// but a customer ID conceivably could, and splitting on every colon would
// quietly corrupt the hash instead of failing loudly.
//
// Throws on an empty table rather than returning one. An empty credential
// table means nobody can log in, which is a misconfiguration - the same
// reasoning as loadPrincipals() in ../../http/auth.js.
function loadPortalCredentials(raw = process.env.COLABERRY_PORTAL_CREDENTIALS) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new PortalCredentialError(
      "COLABERRY_PORTAL_CREDENTIALS is not set. Expected \"<customerId>:<scryptHash>\" " +
        "entries separated by commas. Generate a hash with " +
        "`node scripts/hashPortalPassword.js`. Refusing to start a portal nobody can log in to."
    );
  }

  const credentials = new Map();

  raw
    .split(",")
    .map(function (entry) {
      return entry.trim();
    })
    .filter(function (entry) {
      return entry !== "";
    })
    .forEach(function (entry) {
      const separator = entry.indexOf(":");
      if (separator <= 0) {
        // Deliberately does not echo the entry - it contains a password hash.
        throw new PortalCredentialError(
          "A COLABERRY_PORTAL_CREDENTIALS entry is malformed. Expected <customerId>:<scryptHash>."
        );
      }
      const customerId = entry.slice(0, separator).trim();
      const hash = entry.slice(separator + 1).trim();

      if (customerId === "") {
        throw new PortalCredentialError(
          "A COLABERRY_PORTAL_CREDENTIALS entry has an empty customerId."
        );
      }
      if (!decodeHash(hash)) {
        throw new PortalCredentialError(
          "The stored credential for " +
            JSON.stringify(customerId) +
            " is not a usable scrypt hash."
        );
      }
      if (credentials.has(customerId)) {
        // Last-one-wins would be a silent way to grant access with a stale
        // password. Ambiguous config is a config error.
        throw new PortalCredentialError(
          "COLABERRY_PORTAL_CREDENTIALS lists " + JSON.stringify(customerId) + " more than once."
        );
      }
      credentials.set(customerId, hash);
    });

  if (credentials.size === 0) {
    throw new PortalCredentialError("COLABERRY_PORTAL_CREDENTIALS contained no usable entries.");
  }

  return credentials;
}

// The login path's single entry point. Returns { ok, reason } - never the
// hash, never the password, never a hint of which one was wrong.
async function verifyCredentials({ customerId, password }, credentials) {
  if (typeof customerId !== "string" || customerId.trim() === "" || !isUsablePassword(password)) {
    // No scrypt work: this is a malformed REQUEST, not a login attempt against
    // a real account, so there is no enumeration signal to hide. Rejecting it
    // cheaply is also what stops a 10 MB body costing us a hash.
    return { ok: false, reason: REASONS.MALFORMED_INPUT };
  }

  const stored = credentials.get(customerId);

  if (stored === undefined) {
    // Full cost against the decoy, then a fixed answer. See rule 3.
    await verifyPassword(password, DECOY_HASH);
    return { ok: false, reason: REASONS.UNKNOWN_USER };
  }

  // A row that got past loadPortalCredentials but no longer decodes means the
  // table was mutated in memory. Distinguished from a wrong password because
  // an operator needs to see it in the audit trail; the customer still just
  // sees "invalid credentials".
  if (!decodeHash(stored)) {
    return { ok: false, reason: REASONS.UNUSABLE_HASH };
  }

  const matched = await verifyPassword(password, stored);
  return matched
    ? { ok: true, reason: REASONS.OK, customerId: customerId }
    : { ok: false, reason: REASONS.BAD_PASSWORD };
}

module.exports = {
  hashPassword,
  verifyPassword,
  loadPortalCredentials,
  verifyCredentials,
  PortalCredentialError,
  REASONS,
  DEFAULT_PARAMS,
  MIN_NEW_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
};
