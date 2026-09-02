// STORY-005 step 3: tests for the login attempt.
//
// This is the suite that covers the story's acceptance criteria directly:
//   criterion 1 - correct credentials grant portal access
//   criterion 2 - incorrect credentials are denied
//   criterion 3 - ALL login attempts are logged for security audit
//
// The passwords below are test fixtures, not credentials of any real account.
// Time is injected, so lockout is tested at its boundaries without sleeping.

const assert = require("assert");

const { hashPassword } = require("./portalCredentials");
const { verifySession } = require("./portalSessions");
const { getAuditEntries } = require("../audit/auditLog");
const {
  login,
  logout,
  clearFailureTracking,
  STATUSES,
  EVENTS,
  CREDENTIAL_REASONS,
  MAX_FAILED_ATTEMPTS,
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
} = require("./portalLoginService");

const PASSWORD = "serengeti-migration-2026";
const WRONG_PASSWORD = "serengeti-migration-2025";

const T0 = 1_760_000_000_000;

// Reads the audit trail as it grows, so each assertion looks only at the
// entries its own scenario produced.
function auditSince(mark) {
  return getAuditEntries().slice(mark);
}

function auditMark() {
  return getAuditEntries().length;
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;

  const credentials = new Map([
    ["CUST-1", await hashPassword(PASSWORD)],
    ["CUST-2", await hashPassword(PASSWORD)],
  ]);
  const options = { credentials: credentials, now: T0 };

  // ============================================== CRITERION 1: correct login
  let mark = auditMark();
  const success = await login({ customerId: "CUST-1", password: PASSWORD }, options);

  assert.strictEqual(success.status, STATUSES.AUTHENTICATED);
  assert.strictEqual(typeof success.token, "string");
  assert.strictEqual(success.session.customerId, "CUST-1");
  assert.strictEqual(success.session.role, "customer");

  // "Then they access their portal" - the token must actually work.
  const live = verifySession(success.token, T0 + 1000);
  assert.strictEqual(live.ok, true);
  assert.strictEqual(live.session.customerId, "CUST-1");
  console.log("portalLogin: CRITERION 1 - correct credentials issue a working session");

  const successEntries = auditSince(mark);
  assert.strictEqual(successEntries.length, 1, "exactly one entry, not zero and not two");
  assert.strictEqual(successEntries[0].event, EVENTS.SUCCEEDED);
  assert.strictEqual(successEntries[0].outcome, "success");
  assert.strictEqual(successEntries[0].actor, "CUST-1");
  assert.strictEqual(successEntries[0].resource, "portal-session:" + success.session.sessionId);
  console.log("portalLogin: a successful login is audited, naming the session it created");

  // ============================================ CRITERION 2: incorrect login
  clearFailureTracking();
  mark = auditMark();
  const denied = await login({ customerId: "CUST-1", password: WRONG_PASSWORD }, options);

  assert.strictEqual(denied.status, STATUSES.INVALID_CREDENTIALS);
  assert.strictEqual(denied.token, undefined, "NO TOKEN ON A DENIED LOGIN");
  assert.strictEqual(denied.session, undefined);
  console.log("portalLogin: CRITERION 2 - a wrong password is denied and issues nothing");

  // The four rejection reasons must be indistinguishable from outside. If a
  // future edit makes one of them more informative, this fails.
  const rejections = [
    ["CUST-1", WRONG_PASSWORD, CREDENTIAL_REASONS.BAD_PASSWORD],
    ["CUST-NOBODY", PASSWORD, CREDENTIAL_REASONS.UNKNOWN_USER],
    ["", PASSWORD, CREDENTIAL_REASONS.MALFORMED_INPUT],
    ["CUST-1", "", CREDENTIAL_REASONS.MALFORMED_INPUT],
    ["CUST-1", null, CREDENTIAL_REASONS.MALFORMED_INPUT],
    [{ toString: () => "CUST-1" }, PASSWORD, CREDENTIAL_REASONS.MALFORMED_INPUT],
  ];

  const seenReasons = [];
  for (const [customerId, password, expectedReason] of rejections) {
    clearFailureTracking();
    const attemptMark = auditMark();
    const result = await login({ customerId: customerId, password: password }, options);

    assert.deepStrictEqual(
      result,
      { status: STATUSES.INVALID_CREDENTIALS, message: "Invalid credentials." },
      "every rejection is byte-identical to the customer"
    );

    const entries = auditSince(attemptMark);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].context.reason, expectedReason, "but the trail knows why");
    seenReasons.push(entries[0].context.reason);
  }
  console.log(
    "portalLogin: " +
      rejections.length +
      " different rejections are identical to the customer (" +
      Array.from(new Set(seenReasons)).length +
      " distinct reasons in the audit trail)"
  );

  // A corrupt stored hash is the fourth reason - it needs its own table.
  clearFailureTracking();
  mark = auditMark();
  const corrupt = await login(
    { customerId: "CUST-BROKEN", password: PASSWORD },
    { credentials: new Map([["CUST-BROKEN", "scrypt$nonsense"]]), now: T0 }
  );
  assert.strictEqual(corrupt.status, STATUSES.INVALID_CREDENTIALS);
  assert.strictEqual(auditSince(mark)[0].context.reason, CREDENTIAL_REASONS.UNUSABLE_HASH);
  console.log("portalLogin: a corrupted stored credential is denied and audited as such");

  // ======================================= CRITERION 3: ALL attempts audited
  clearFailureTracking();
  mark = auditMark();
  await login({ customerId: "CUST-1", password: PASSWORD }, options);
  await login({ customerId: "CUST-1", password: WRONG_PASSWORD }, options);
  await login({ customerId: "CUST-GHOST", password: PASSWORD }, options);
  await login({ customerId: "", password: "" }, options);

  const all = auditSince(mark);
  assert.strictEqual(all.length, 4, "four attempts, four entries - ALL means all");
  assert.deepStrictEqual(
    all.map(function (entry) {
      return entry.outcome;
    }),
    ["success", "failure", "failure", "failure"]
  );
  assert.deepStrictEqual(
    all.map(function (entry) {
      return entry.actor;
    }),
    ["CUST-1", "CUST-1", "CUST-GHOST", "<empty>"]
  );
  console.log("portalLogin: CRITERION 3 - all four attempt kinds land in the audit trail");

  // THE ATTACK THIS DEFENDS. The audit log is first-write-wins, so keying an
  // entry on a client-supplied correlation id would let an attacker send one
  // id repeatedly and have every attempt after the first silently discarded -
  // silencing the log they are about to fill. Keys are server-side UUIDs.
  clearFailureTracking();
  mark = auditMark();
  for (let i = 0; i < 4; i += 1) {
    await login(
      { customerId: "CUST-1", password: WRONG_PASSWORD, correlationId: "replayed-id-aaaa" },
      options
    );
  }
  const replayed = auditSince(mark);
  assert.strictEqual(replayed.length, 4, "A REPLAYED CORRELATION ID MUST NOT SUPPRESS ENTRIES");
  assert.strictEqual(new Set(replayed.map((e) => e.auditKey)).size, 4, "four distinct keys");
  assert.ok(
    replayed.every(function (entry) {
      return entry.correlationId === "replayed-id-aaaa";
    }),
    "the correlation id is still carried for tracing"
  );
  console.log("portalLogin: replaying one correlation id cannot silence the login log");

  // Nothing secret may reach the trail. The audit log redacts by key name as a
  // backstop, but the real guarantee is that this service never passes it.
  const trail = JSON.stringify(getAuditEntries());
  assert.ok(!trail.includes(PASSWORD), "NO PASSWORD IN THE AUDIT TRAIL");
  assert.ok(!trail.includes(WRONG_PASSWORD), "not even a wrong one");
  assert.ok(!trail.includes(success.token), "NO SESSION TOKEN IN THE AUDIT TRAIL");
  console.log("portalLogin: no password and no token appears anywhere in the audit trail");

  // ==================================================== throttling / lockout
  clearFailureTracking();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
    const attempt = await login({ customerId: "CUST-1", password: WRONG_PASSWORD }, options);
    assert.strictEqual(attempt.status, STATUSES.INVALID_CREDENTIALS, "not locked yet at " + (i + 1));
  }
  const locking = await login({ customerId: "CUST-1", password: WRONG_PASSWORD }, options);
  assert.strictEqual(locking.status, STATUSES.INVALID_CREDENTIALS, "the 5th is still a refusal");

  mark = auditMark();
  const blocked = await login({ customerId: "CUST-1", password: WRONG_PASSWORD }, options);
  assert.strictEqual(blocked.status, STATUSES.LOCKED_OUT);
  assert.strictEqual(blocked.retryAfterSeconds, LOCKOUT_MS / 1000);
  assert.strictEqual(auditSince(mark)[0].event, EVENTS.BLOCKED, "a blocked attempt is audited too");
  console.log(
    "portalLogin: " + MAX_FAILED_ATTEMPTS + " failures lock the account, and the block is audited"
  );

  // The lock must be checked BEFORE the password, or it is not a throttle -
  // an attacker would still get a free hash per attempt, and a correct
  // password would sail through a locked account.
  const lockedWithGoodPassword = await login({ customerId: "CUST-1", password: PASSWORD }, options);
  assert.strictEqual(
    lockedWithGoodPassword.status,
    STATUSES.LOCKED_OUT,
    "EVEN THE CORRECT PASSWORD IS REFUSED WHILE LOCKED"
  );
  console.log("portalLogin: a locked account refuses even correct credentials (checked first)");

  // ...and recovers on its own once the window passes.
  const recovered = await login(
    { customerId: "CUST-1", password: PASSWORD },
    { credentials: credentials, now: T0 + LOCKOUT_MS }
  );
  assert.strictEqual(recovered.status, STATUSES.AUTHENTICATED, "the lock expires by itself");
  console.log("portalLogin: the lock lifts when the window passes - no operator needed");

  // A success clears the counter, so four typos followed by a correct login
  // does not leave someone one mistake from a lockout.
  clearFailureTracking();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
    await login({ customerId: "CUST-2", password: WRONG_PASSWORD }, options);
  }
  assert.strictEqual(
    (await login({ customerId: "CUST-2", password: PASSWORD }, options)).status,
    STATUSES.AUTHENTICATED
  );
  for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
    const after = await login({ customerId: "CUST-2", password: WRONG_PASSWORD }, options);
    assert.strictEqual(after.status, STATUSES.INVALID_CREDENTIALS, "counter restarted from zero");
  }
  console.log("portalLogin: a successful login clears the failure counter");

  // Failures spread beyond the window do not accumulate.
  clearFailureTracking();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i += 1) {
    const spread = await login(
      { customerId: "CUST-SLOW", password: WRONG_PASSWORD },
      { credentials: credentials, now: T0 + i * (FAILURE_WINDOW_MS + 1) }
    );
    assert.strictEqual(spread.status, STATUSES.INVALID_CREDENTIALS, "never locks at attempt " + i);
  }
  console.log("portalLogin: failures spread past the window never accumulate into a lockout");

  // An unknown identifier is throttled too. If only real accounts locked out,
  // "this one locked" would confirm the account exists.
  clearFailureTracking();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    await login({ customerId: "CUST-DOES-NOT-EXIST", password: WRONG_PASSWORD }, options);
  }
  const ghostBlocked = await login(
    { customerId: "CUST-DOES-NOT-EXIST", password: WRONG_PASSWORD },
    options
  );
  assert.strictEqual(
    ghostBlocked.status,
    STATUSES.LOCKED_OUT,
    "an unknown account locks exactly like a real one"
  );
  console.log("portalLogin: unknown accounts throttle too - lockout is not an existence oracle");

  // An oversized identifier is bounded before it reaches the durable trail.
  clearFailureTracking();
  mark = auditMark();
  await login({ customerId: "C".repeat(5000), password: WRONG_PASSWORD }, options);
  const bounded = auditSince(mark)[0];
  assert.ok(bounded.actor.length < 200, "the trail cannot be padded with a huge identifier");
  assert.ok(bounded.actor.endsWith("<truncated>"));
  console.log("portalLogin: an oversized attempted identifier is truncated before it is stored");

  // ============================================ the unauditable login is refused
  // The security decision at the heart of criterion 3: if the attempt cannot
  // be recorded, access is not granted. A login we cannot account for is worse
  // than an outage.
  clearFailureTracking();
  function throwingAudit() {
    throw Object.assign(new Error("audit store is down"), { errorClass: "ContractViolation" });
  }

  const unauditableSuccess = await login(
    { customerId: "CUST-1", password: PASSWORD },
    { credentials: credentials, now: T0, audit: throwingAudit }
  );
  assert.strictEqual(unauditableSuccess.status, STATUSES.AUDIT_UNAVAILABLE);
  assert.strictEqual(unauditableSuccess.token, undefined, "NO TOKEN WHEN THE ATTEMPT IS UNLOGGABLE");
  console.log("portalLogin: correct credentials are REFUSED if the attempt cannot be audited");

  // And the session minted a moment earlier must be taken back, or an
  // unaccounted-for session is left alive in the store.
  let orphans = 0;
  const beforeOrphanCheck = auditMark();
  for (let i = 0; i < 3; i += 1) {
    const attempt = await login(
      { customerId: "CUST-1", password: PASSWORD },
      { credentials: credentials, now: T0, audit: throwingAudit }
    );
    if (attempt.token && verifySession(attempt.token, T0).ok) {
      orphans += 1;
    }
  }
  assert.strictEqual(orphans, 0, "NO ORPHANED SESSIONS SURVIVE AN UNAUDITABLE LOGIN");
  assert.strictEqual(auditSince(beforeOrphanCheck).length, 0, "and nothing was written");
  console.log("portalLogin: the session minted for an unauditable login is revoked, not orphaned");

  const unauditableFailure = await login(
    { customerId: "CUST-1", password: WRONG_PASSWORD },
    { credentials: credentials, now: T0, audit: throwingAudit }
  );
  assert.strictEqual(
    unauditableFailure.status,
    STATUSES.AUDIT_UNAVAILABLE,
    "an unloggable FAILURE is reported honestly too, not passed off as a refusal"
  );
  console.log("portalLogin: an unauditable failed attempt reports unavailable, not 'denied'");

  // ==================================================================== logout
  clearFailureTracking();
  const session = await login({ customerId: "CUST-1", password: PASSWORD }, options);
  mark = auditMark();
  const out = logout({ token: session.token, customerId: "CUST-1" });

  assert.deepStrictEqual(out, { status: "logged_out", endedSession: true });
  assert.strictEqual(verifySession(session.token, T0).ok, false, "the token is dead");
  assert.strictEqual(auditSince(mark)[0].event, EVENTS.LOGGED_OUT);
  console.log("portalLogin: logout ends the session and is audited");

  mark = auditMark();
  const again = logout({ token: session.token, customerId: "CUST-1" });
  assert.deepStrictEqual(again, { status: "logged_out", endedSession: false });
  assert.strictEqual(
    auditSince(mark).length,
    1,
    "a token presented after logout is still worth recording"
  );
  console.log("portalLogin: logging out twice is safe, and both attempts are on record");

  console.log("portalLogin: all tests passed");
}

main();
