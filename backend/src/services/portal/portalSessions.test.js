// STORY-005 step 2: tests for the session store.
//
// Time is INJECTED throughout (`now` is a parameter on every entry point), so
// the two expiry clocks are tested at their exact boundaries without a single
// sleep. A test that waits 30 minutes does not get run.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
  }).trim();
}

function main() {
  // In-memory for this suite, for the reason given in auditLog.test.js: a run
  // that inherits the previous run's sessions is not a test.
  delete process.env.COLABERRY_DATA_DIR;

  const {
    createSession,
    verifySession,
    revokeSession,
    purgeExpiredSessions,
    PortalSessionConfigError,
    REASONS,
    IDLE_TIMEOUT_MS,
    ABSOLUTE_LIFETIME_MS,
    MAX_SESSIONS_PER_CUSTOMER,
  } = require("./portalSessions");

  const T0 = 1_760_000_000_000; // a fixed instant; the value is arbitrary

  // ---------------------------------------------------------------- happy path
  const { token, session } = createSession({ customerId: "CUST-1" }, T0);

  assert.strictEqual(typeof token, "string");
  assert.ok(token.length >= 40, "a 32-byte token is at least 40 base64url characters");
  assert.strictEqual(session.customerId, "CUST-1");
  assert.strictEqual(session.role, "customer");
  assert.strictEqual(session.idleExpiresAt, T0 + IDLE_TIMEOUT_MS);
  assert.strictEqual(session.absoluteExpiresAt, T0 + ABSOLUTE_LIFETIME_MS);

  const verified = verifySession(token, T0 + 1000);
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.session.customerId, "CUST-1");
  assert.strictEqual(verified.session.sessionId, session.sessionId);
  console.log("portalSessions: a new session verifies and carries who it belongs to");

  // The returned view must be a copy. If a caller could mutate the stored row
  // it could extend its own session or change whose it is.
  verified.session.customerId = "CUST-ATTACKER";
  verified.session.absoluteExpiresAt = Number.MAX_SAFE_INTEGER;
  const unaffected = verifySession(token, T0 + 2000);
  assert.strictEqual(unaffected.session.customerId, "CUST-1");
  assert.strictEqual(unaffected.session.absoluteExpiresAt, T0 + ABSOLUTE_LIFETIME_MS);
  console.log("portalSessions: the caller gets a copy - mutating it does not touch the store");

  // ---------------------------------------------------------- unknown tokens
  const foreign = crypto.randomBytes(32).toString("base64url");
  assert.deepStrictEqual(verifySession(foreign, T0), {
    ok: false,
    reason: REASONS.UNKNOWN_SESSION,
  });
  for (const bad of [undefined, null, "", "short", 12345, {}, "x".repeat(257)]) {
    assert.deepStrictEqual(verifySession(bad, T0), {
      ok: false,
      reason: REASONS.MALFORMED_TOKEN,
    });
  }
  console.log("portalSessions: an unguessed token is unknown, a malformed one is refused outright");

  // -------------------------------------------------------------- idle timeout
  const idle = createSession({ customerId: "CUST-IDLE" }, T0).token;

  assert.strictEqual(verifySession(idle, T0 + IDLE_TIMEOUT_MS - 1).ok, true, "one ms before");
  // The check above slid the clock, so re-base the deadline onto that moment.
  const slidFrom = T0 + IDLE_TIMEOUT_MS - 1;
  assert.deepStrictEqual(verifySession(idle, slidFrom + IDLE_TIMEOUT_MS), {
    ok: false,
    reason: REASONS.IDLE_TIMEOUT,
  });
  // Expiry DELETES. A second presentation of the same token must not even be
  // recognised, or an expired row is one careless read away from honoured.
  assert.deepStrictEqual(verifySession(idle, slidFrom + IDLE_TIMEOUT_MS), {
    ok: false,
    reason: REASONS.UNKNOWN_SESSION,
  });
  console.log("portalSessions: an idle session expires on the boundary and the row is deleted");

  // ------------------------------------------------------- the idle clock slides
  const busy = createSession({ customerId: "CUST-BUSY" }, T0).token;
  let at = T0;
  for (let i = 0; i < 5; i += 1) {
    at += IDLE_TIMEOUT_MS - 1000; // busy: acts just before every deadline
    assert.strictEqual(verifySession(busy, at).ok, true, "still alive at hop " + i);
  }
  assert.ok(at > T0 + IDLE_TIMEOUT_MS, "we are well past the ORIGINAL idle deadline");
  console.log("portalSessions: staying active slides the idle deadline forward");

  // ------------------------------------------------- but never past the absolute
  // The defect this guards: copying the absolute deadline forward along with
  // the idle one turns a 12-hour maximum into an unlimited session for anyone
  // who keeps using the token - which is exactly what a thief does.
  const marathon = createSession({ customerId: "CUST-MARATHON" }, T0).token;
  let clock = T0;
  let finalReason = null;
  for (let i = 0; i < 200; i += 1) {
    clock += IDLE_TIMEOUT_MS - 1000;
    const result = verifySession(marathon, clock);
    if (!result.ok) {
      finalReason = result.reason;
      break;
    }
  }
  assert.strictEqual(finalReason, REASONS.ABSOLUTE_TIMEOUT, "must die of old age, not idleness");
  assert.ok(clock >= T0 + ABSOLUTE_LIFETIME_MS, "and only once the absolute lifetime is up");
  console.log(
    "portalSessions: a continuously used session still dies at the absolute lifetime (" +
      Math.round(ABSOLUTE_LIFETIME_MS / 3600000) +
      "h)"
  );

  // -------------------------------------------------------------------- logout
  const out = createSession({ customerId: "CUST-OUT" }, T0).token;
  assert.strictEqual(revokeSession(out), true, "a live session is ended");
  assert.deepStrictEqual(verifySession(out, T0 + 1), {
    ok: false,
    reason: REASONS.UNKNOWN_SESSION,
  });
  assert.strictEqual(revokeSession(out), false, "revoking twice is safe and reports honestly");
  assert.strictEqual(revokeSession("not-a-token"), false);
  console.log("portalSessions: logout ends the session, and logging out twice is safe");

  // ------------------------------------------------------ one customer, two devices
  const phone = createSession({ customerId: "CUST-2" }, T0).token;
  const laptop = createSession({ customerId: "CUST-2" }, T0 + 1).token;
  assert.notStrictEqual(phone, laptop, "two logins never share a token");
  assert.strictEqual(verifySession(phone, T0 + 2).ok, true);
  assert.strictEqual(verifySession(laptop, T0 + 2).ok, true);
  revokeSession(phone);
  assert.strictEqual(verifySession(laptop, T0 + 3).ok, true, "logging out one device keeps the other");
  console.log("portalSessions: two devices get independent sessions; logging out one keeps the other");

  // ------------------------------------------------------------- the session cap
  // Without a cap, a login loop grows the store forever - a disk fill made of
  // valid credentials.
  const tokens = [];
  for (let i = 0; i < MAX_SESSIONS_PER_CUSTOMER + 3; i += 1) {
    tokens.push(createSession({ customerId: "CUST-CAP" }, T0 + i).token);
  }
  const alive = tokens.filter(function (candidate) {
    return verifySession(candidate, T0 + 100).ok;
  });
  assert.strictEqual(alive.length, MAX_SESSIONS_PER_CUSTOMER, "the cap holds");
  assert.strictEqual(alive[0], tokens[3], "the OLDEST sessions are the ones evicted");
  console.log(
    "portalSessions: a customer is capped at " +
      MAX_SESSIONS_PER_CUSTOMER +
      " sessions, evicting oldest first"
  );

  // ---------------------------------------------------------------- purging
  createSession({ customerId: "CUST-PURGE" }, T0);
  const purged = purgeExpiredSessions(T0 + ABSOLUTE_LIFETIME_MS + 1);
  assert.ok(purged > 0, "everything created at T0 is long expired by now");
  console.log("portalSessions: purgeExpiredSessions drops " + purged + " dead rows");

  // -------------------------------------------------------------- bad callers
  for (const bad of [undefined, "", "   ", 7, null]) {
    assert.throws(function () {
      createSession({ customerId: bad }, T0);
    }, PortalSessionConfigError);
  }
  console.log("portalSessions: a session cannot be minted for nobody");

  // ------------------------------------- the token is not recoverable from disk
  // The claim in the module header, tested rather than asserted in a comment:
  // what lands on disk is a digest, so the session file is not a list of
  // working credentials. The same child process proves durability across a
  // restart, because both facts come from the same file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sessions-"));

  const issued = inChildProcess(
    dir,
    "const s = require('./backend/src/services/portal/portalSessions');" +
      "console.log(s.createSession({ customerId: 'CUST-DISK' }).token);"
  );
  const onDisk = fs.readFileSync(path.join(dir, "portal-sessions.json"), "utf8");

  assert.ok(!onDisk.includes(issued), "THE TOKEN MUST NOT BE ON DISK");
  assert.ok(
    onDisk.includes(crypto.createHash("sha256").update(issued, "utf8").digest("hex")),
    "its digest is what was stored"
  );
  assert.ok(onDisk.includes("CUST-DISK"), "the row itself is there");
  console.log("portalSessions: the stored row holds the token's digest, never the token");

  const afterRestart = inChildProcess(
    dir,
    "const s = require('./backend/src/services/portal/portalSessions');" +
      "const r = s.verifySession(" +
      JSON.stringify(issued) +
      ");" +
      "console.log(JSON.stringify([r.ok, r.session && r.session.customerId]));"
  );
  assert.deepStrictEqual(JSON.parse(afterRestart), [true, "CUST-DISK"]);
  console.log("portalSessions: a session survives a real process restart");

  fs.rmSync(dir, { recursive: true, force: true });

  console.log("portalSessions: all tests passed");
}

main();
