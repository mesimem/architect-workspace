// STORY-005: the login attempt itself - the one place that sees a password,
// a session and the audit trail at the same time.
//
// ACCEPTANCE CRITERION 3 IS THE HARD ONE. "The system logs all login attempts
// for security audit" means ALL of them: the successes, the wrong passwords,
// the unknown accounts, the malformed submissions and the ones we refused to
// even check because the account was locked. A login log that records only
// successes cannot answer the question it exists to answer - who has been
// trying to get in, and how often. So the audit write is not a side note at
// the end of the happy path; it is on every return path in this file, and a
// login that cannot be audited DOES NOT SUCCEED (see UNAUDITABLE, below).
//
// WHAT THE CALLER LEARNS vs WHAT THE AUDIT TRAIL LEARNS. These are
// deliberately different, and keeping them different is most of the security
// value here:
//
//   situation            | customer sees        | audit entry records
//   ---------------------|----------------------|--------------------------
//   wrong password       | invalid_credentials  | reason: bad_password
//   no such account      | invalid_credentials  | reason: unknown_user
//   corrupt stored hash  | invalid_credentials  | reason: unusable_hash
//   malformed submission | invalid_credentials  | reason: malformed_input
//
// One message, four facts. Telling the customer which half of the pair was
// wrong hands an attacker the other half; withholding it from the audit trail
// blinds the operator who has to investigate.
//
// AUDIT KEYS ARE GENERATED HERE, NEVER ACCEPTED FROM THE CALLER. The audit log
// is first-write-wins by design (see ../audit/auditLog.js), which is what
// stops a retry rewriting history. Keyed on a client-supplied correlation id,
// that same property becomes an attack: send every login attempt with the
// header X-Correlation-ID: aaaaaaaa and only the FIRST is ever recorded, so an
// attacker can silence the log they are about to fill. Every attempt therefore
// gets a fresh server-side UUID. The client's correlation id is still carried
// on the entry - it is useful for tracing - but it is never the key.
//
// THROTTLING. Five failures against one identifier inside fifteen minutes
// locks it for fifteen minutes, and a locked identifier is refused BEFORE the
// password is checked. That bounds an online guessing attack, and it also
// bounds the CPU an unauthenticated caller can spend on our behalf - scrypt is
// deliberately expensive, which cuts both ways.
//   - Unknown identifiers are counted too. If only real accounts were
//     throttled, "this one locked out" would confirm the account exists.
//   - Known trade-off: an attacker who knows a customer's ID can lock them out
//     for fifteen minutes. That is a denial of service, and it is the accepted
//     side of this trade - the alternative is unlimited guessing. The real fix
//     is per-source-IP throttling at the edge, which is nginx's job, not this
//     module's, plus the risk-based step-up that belongs with STORY-006.
//   - Counters are IN MEMORY, not in the durable store, on purpose: persisting
//     them would mean a disk write per failed attempt, which hands an attacker
//     a write amplification lever. Losing counters on restart weakens a rate
//     limiter slightly; it loses no audit data, because the audit trail is a
//     separate, durable store.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every outcome is a typed `status`; nothing
//     throws on the request path. UNAUDITABLE: if the audit write throws, the
//     login is refused with `audit_unavailable` and any session already minted
//     is revoked, so we never hand out access we cannot account for. That is
//     the one place this module chooses unavailability over service.
//  2. Will it retry? No. Verification is local CPU and the audit write is a
//     local synchronous file write; neither is flaky, and a retry loop around
//     a password check is a brute-force tool. The customer retries by logging
//     in again, which the throttle then counts.
//  3. Recovery path? A locked identifier recovers by waiting out the window.
//     An audit store that will not write is an operator problem - it surfaces
//     as a 503 at the boundary and in the structured log, never as a silent
//     success.
//  4. Handled here: all four rejection reasons, lockout, replayed correlation
//     ids, an audit store that throws, oversized attacker-supplied identifiers
//     reaching the trail, and unbounded growth of the throttle table. NOT
//     handled: per-IP throttling (edge), CAPTCHA, MFA, password reset, and
//     notifying a customer that someone is attacking their account.

const crypto = require("crypto");

const { verifyCredentials, REASONS: CREDENTIAL_REASONS } = require("./portalCredentials");
const { createSession, revokeSession } = require("./portalSessions");
const { recordAudit } = require("../audit/auditLog");

const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

// The throttle table is keyed on attacker-supplied text, so it needs a ceiling
// of its own. Beyond this the oldest entries are dropped - which loses some
// throttling under a spray attack across thousands of identifiers, but that
// attack is not guessing one password, and an unbounded map is a worse
// outcome than a weakened counter.
const MAX_TRACKED_IDENTIFIERS = 10000;

// An attempted customerId is untrusted input that ends up in a durable store.
// Bounded before it is written, so nobody can pad the audit trail with a
// megabyte per attempt.
const MAX_AUDITED_IDENTIFIER_LENGTH = 128;

const STATUSES = {
  AUTHENTICATED: "authenticated",
  INVALID_CREDENTIALS: "invalid_credentials",
  LOCKED_OUT: "locked_out",
  AUDIT_UNAVAILABLE: "audit_unavailable",
};

const EVENTS = {
  SUCCEEDED: "portal.login.succeeded",
  FAILED: "portal.login.failed",
  BLOCKED: "portal.login.blocked",
  LOGGED_OUT: "portal.logout",
};

// The single message every rejection returns. Defined once so no future edit
// can accidentally make one branch more informative than another.
const GENERIC_REJECTION = "Invalid credentials.";

// identifier -> { failures, windowStartedAt, lockedUntil }
const FAILURE_TRACKING = new Map();

function log(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: "portal-login",
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

// Never the password, never the token. A non-string identifier is described
// rather than coerced, so `[object Object]` never becomes an audit actor.
function safeIdentifier(customerId) {
  if (typeof customerId !== "string") {
    return "<non-string:" + typeof customerId + ">";
  }
  const trimmed = customerId.trim();
  if (trimmed === "") {
    return "<empty>";
  }
  return trimmed.length > MAX_AUDITED_IDENTIFIER_LENGTH
    ? trimmed.slice(0, MAX_AUDITED_IDENTIFIER_LENGTH) + "<truncated>"
    : trimmed;
}

function pruneTracking(now) {
  for (const [identifier, record] of Array.from(FAILURE_TRACKING.entries())) {
    const lockExpired = !record.lockedUntil || now >= record.lockedUntil;
    const windowExpired = now - record.windowStartedAt >= FAILURE_WINDOW_MS;
    if (lockExpired && windowExpired) {
      FAILURE_TRACKING.delete(identifier);
    }
  }
  // Map iterates in insertion order, so the first keys are the oldest.
  while (FAILURE_TRACKING.size > MAX_TRACKED_IDENTIFIERS) {
    FAILURE_TRACKING.delete(FAILURE_TRACKING.keys().next().value);
  }
}

function lockoutRemainingMs(identifier, now) {
  const record = FAILURE_TRACKING.get(identifier);
  if (!record || !record.lockedUntil || now >= record.lockedUntil) {
    return 0;
  }
  return record.lockedUntil - now;
}

function noteFailure(identifier, now) {
  const existing = FAILURE_TRACKING.get(identifier);

  // A window that has run out starts again rather than accumulating: five
  // typos spread over a year must not lock anybody out.
  if (!existing || now - existing.windowStartedAt >= FAILURE_WINDOW_MS) {
    FAILURE_TRACKING.set(identifier, { failures: 1, windowStartedAt: now, lockedUntil: null });
    return { failures: 1, locked: false };
  }

  existing.failures += 1;
  if (existing.failures >= MAX_FAILED_ATTEMPTS) {
    existing.lockedUntil = now + LOCKOUT_MS;
  }
  return { failures: existing.failures, locked: Boolean(existing.lockedUntil) };
}

function clearFailures(identifier) {
  FAILURE_TRACKING.delete(identifier);
}

// Returns true if the attempt is on record, false if the audit store refused.
// Never throws: the caller must be able to react to an unauditable attempt
// rather than crash on it, and crashing would itself lose the attempt.
//
// `audit` is injected (defaulting to the real recorder) for the same reason
// the accounting client injects its transport: the UNAUDITABLE path below is a
// security decision, and a security decision nobody can test is a security
// decision nobody can trust.
function auditAttempt(audit, { event, outcome, actor, resource, context, correlationId }) {
  try {
    audit({
      // Fresh every time. See AUDIT KEYS, above - this is the line that stops
      // a replayed correlation id silencing the log.
      auditKey: "login-" + crypto.randomUUID(),
      event: event,
      outcome: outcome,
      actor: actor,
      resource: resource,
      context: context,
      correlationId: correlationId,
    });
    return true;
  } catch (error) {
    log("error", "login_attempt_unauditable", {
      correlationId: correlationId || null,
      event: event,
      error_class: error && error.errorClass ? error.errorClass : "UnknownError",
    });
    return false;
  }
}

// The refusal every failed login returns, so the four reasons are
// indistinguishable from outside by shape as well as by message.
function rejection() {
  return { status: STATUSES.INVALID_CREDENTIALS, message: GENERIC_REJECTION };
}

function unauditable() {
  return {
    status: STATUSES.AUDIT_UNAVAILABLE,
    message: "Sign-in is temporarily unavailable. Please try again shortly.",
  };
}

// `credentials` is the Map from loadPortalCredentials, injected rather than
// read here so the boundary loads it once at startup and a test can hand over
// its own. `now` is injectable so the lockout tests need no sleeps.
async function login(
  { customerId, password, correlationId },
  { credentials, now = Date.now(), audit = recordAudit }
) {
  const identifier = safeIdentifier(customerId);

  pruneTracking(now);

  // BEFORE the password check, deliberately: a locked identifier must not buy
  // an attacker any scrypt work.
  const remaining = lockoutRemainingMs(identifier, now);
  if (remaining > 0) {
    const retryAfterSeconds = Math.ceil(remaining / 1000);
    const audited = auditAttempt(audit, {
      event: EVENTS.BLOCKED,
      outcome: "failure",
      actor: identifier,
      resource: null,
      context: { reason: "locked_out", retryAfterSeconds: retryAfterSeconds },
      correlationId: correlationId,
    });
    if (!audited) {
      return unauditable();
    }
    log("error", "login_blocked", { correlationId: correlationId || null, retryAfterSeconds });
    return {
      status: STATUSES.LOCKED_OUT,
      message: "Too many failed sign-in attempts. Try again later.",
      retryAfterSeconds: retryAfterSeconds,
    };
  }

  const verdict = await verifyCredentials({ customerId: customerId, password: password }, credentials);

  if (!verdict.ok) {
    const { failures, locked } = noteFailure(identifier, now);
    const audited = auditAttempt(audit, {
      event: EVENTS.FAILED,
      outcome: "failure",
      actor: identifier,
      resource: null,
      // The SPECIFIC reason goes here and nowhere else. This is the asymmetry
      // the table at the top of this file describes.
      context: {
        reason: verdict.reason,
        failuresInWindow: failures,
        lockedOut: locked,
      },
      correlationId: correlationId,
    });
    if (!audited) {
      return unauditable();
    }
    log("error", "login_failed", {
      correlationId: correlationId || null,
      reason: verdict.reason,
      failuresInWindow: failures,
      lockedOut: locked,
    });
    return rejection();
  }

  // Verified. Mint the session first so the audit entry can name it, then
  // treat an unauditable success as a failed login and take the session back.
  const { token, session } = createSession({ customerId: verdict.customerId, role: "customer" }, now);

  const audited = auditAttempt(audit, {
    event: EVENTS.SUCCEEDED,
    outcome: "success",
    actor: verdict.customerId,
    resource: "portal-session:" + session.sessionId,
    context: { sessionId: session.sessionId, expiresAt: session.absoluteExpiresAt },
    correlationId: correlationId,
  });
  if (!audited) {
    // UNAUDITABLE. An access grant we cannot account for is worse than an
    // outage, and the guardrail is explicit that all attempts are logged.
    revokeSession(token);
    return unauditable();
  }

  clearFailures(identifier);

  log("info", "login_succeeded", {
    correlationId: correlationId || null,
    customerId: verdict.customerId,
    sessionId: session.sessionId,
  });

  return {
    status: STATUSES.AUTHENTICATED,
    token: token, // returned once; see portalSessions.js
    session: session,
  };
}

// Logging out is an audited event too - "when did this session end, and was it
// ended deliberately?" is a question an incident review asks. Idempotent: the
// second logout reports `endedSession: false` and is still recorded, because
// a token presented after logout is itself worth seeing in the trail.
function logout({ token, customerId, correlationId }, { audit = recordAudit } = {}) {
  const endedSession = revokeSession(token);

  const audited = auditAttempt(audit, {
    event: EVENTS.LOGGED_OUT,
    outcome: "success",
    actor: safeIdentifier(customerId),
    resource: null,
    context: { endedSession: endedSession },
    correlationId: correlationId,
  });

  return { status: audited ? "logged_out" : STATUSES.AUDIT_UNAVAILABLE, endedSession: endedSession };
}

// Test and operational use: clears the throttle table. Not called on the
// request path - an attacker who could reach this would have an unlimited
// guessing budget.
function clearFailureTracking() {
  FAILURE_TRACKING.clear();
}

module.exports = {
  login,
  logout,
  clearFailureTracking,
  STATUSES,
  EVENTS,
  CREDENTIAL_REASONS,
  MAX_FAILED_ATTEMPTS,
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
};
