// STORY-005 step 1: tests for the credential module.
//
// The passwords below are test fixtures. They exist only inside this process,
// they are not the credentials of any account anywhere, and the module under
// test reads its real table from the environment. Nothing here is a secret.

const assert = require("assert");

const {
  hashPassword,
  verifyPassword,
  loadPortalCredentials,
  verifyCredentials,
  PortalCredentialError,
  REASONS,
  MIN_NEW_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
} = require("./portalCredentials");

const PASSWORD = "correct-horse-battery-staple";
const OTHER_PASSWORD = "correct-horse-battery-stapl3";

async function main() {
  // ---------------------------------------------------------------- happy path
  const hash = await hashPassword(PASSWORD);

  assert.ok(hash.startsWith("scrypt$16384$8$1$"), "hash carries its cost parameters");
  assert.strictEqual(await verifyPassword(PASSWORD, hash), true);
  console.log("portalCredentials: a hashed password verifies against its own hash");

  // The whole point of hashing. If the password appeared in the hash string
  // this module would be storing a secret in a file that gets backed up.
  assert.ok(!hash.includes(PASSWORD), "the plaintext password is not in the hash");
  console.log("portalCredentials: the plaintext never appears in the stored hash");

  const second = await hashPassword(PASSWORD);
  assert.notStrictEqual(hash, second, "same password, different salt, different hash");
  assert.strictEqual(await verifyPassword(PASSWORD, second), true);
  console.log("portalCredentials: the same password hashes differently every time (per-user salt)");

  // ------------------------------------------------------------- wrong password
  assert.strictEqual(await verifyPassword(OTHER_PASSWORD, hash), false);
  assert.strictEqual(await verifyPassword(PASSWORD + " ", hash), false);
  assert.strictEqual(await verifyPassword(PASSWORD.toUpperCase(), hash), false);
  console.log("portalCredentials: a password off by one character, a space or case is refused");

  // ------------------------------------------------------- unusable hash inputs
  // Each of these is a hash a human could plausibly produce by hand-editing
  // config. None of them may verify, and none may throw - a corrupt row is a
  // failed login, not a crash on the login path.
  const brokenHashes = [
    undefined,
    null,
    42,
    "",
    "not-a-hash",
    "bcrypt$16384$8$1$c2FsdA==$a2V5", // right shape, wrong algorithm
    "scrypt$16384$8$1$c2FsdA==", // truncated: five fields, not six
    "scrypt$16385$8$1$c2FsdA==$a2V5", // N is not a power of two
    "scrypt$0$8$1$c2FsdA==$a2V5", // N below the minimum
    "scrypt$16384$0$1$c2FsdA==$a2V5", // r must be at least 1
    "scrypt$16384$8$1$c2E=$" + Buffer.alloc(32).toString("base64"), // salt too short
    "scrypt$16384$8$1$" + Buffer.alloc(16).toString("base64") + "$a2V5", // key too short
    hash.slice(0, -4), // truncated key
  ];
  for (const broken of brokenHashes) {
    assert.strictEqual(
      await verifyPassword(PASSWORD, broken),
      false,
      "unusable hash must not verify: " + String(broken).slice(0, 24)
    );
  }
  console.log(
    "portalCredentials: " + brokenHashes.length + " unusable hash shapes all fail closed, none throw"
  );

  // ------------------------------------------------------ unusable new passwords
  const tooShort = "x".repeat(MIN_NEW_PASSWORD_LENGTH - 1);
  await assert.rejects(function () {
    return hashPassword(tooShort);
  }, PortalCredentialError);
  await assert.rejects(function () {
    return hashPassword(undefined);
  }, PortalCredentialError);
  await assert.rejects(function () {
    return hashPassword("x".repeat(MAX_PASSWORD_BYTES + 1));
  }, PortalCredentialError);
  console.log("portalCredentials: a too-short, absent or oversized new password is refused");

  // An oversized password on the VERIFY path is refused without doing the
  // work, so an unauthenticated caller cannot buy CPU with a large body.
  assert.strictEqual(await verifyPassword("x".repeat(MAX_PASSWORD_BYTES + 1), hash), false);
  console.log("portalCredentials: an oversized password is refused at verify, not hashed");

  // --------------------------------------------------------- loading the table
  const hashA = await hashPassword(PASSWORD);
  const hashB = await hashPassword(OTHER_PASSWORD);
  const table = loadPortalCredentials("CUST-1:" + hashA + " , CUST-2:" + hashB);

  assert.strictEqual(table.size, 2);
  assert.strictEqual(table.get("CUST-1"), hashA, "surrounding whitespace is trimmed");
  console.log("portalCredentials: a well-formed credential table loads, whitespace and all");

  const badTables = [
    [undefined, "unset"],
    ["", "empty"],
    ["   ", "blank"],
    [",,", "no usable entries"],
    ["CUST-1", "no separator"],
    [":" + hashA, "empty customerId"],
    ["CUST-1:not-a-hash", "unusable hash"],
    ["CUST-1:" + hashA + ",CUST-1:" + hashB, "duplicate customerId"],
  ];
  for (const [raw, why] of badTables) {
    assert.throws(
      function () {
        loadPortalCredentials(raw);
      },
      PortalCredentialError,
      "must refuse a table that is " + why
    );
  }
  console.log(
    "portalCredentials: " + badTables.length + " malformed credential tables are all refused at load"
  );

  // A config error is read by a human and often pasted into a ticket. It must
  // name the problem without quoting the row, because the row is a hash.
  const leaked = (function () {
    try {
      loadPortalCredentials("CUST-1:" + hashA + ",CUST-1:" + hashB);
      return null;
    } catch (error) {
      return error.message;
    }
  })();
  assert.ok(leaked.includes("CUST-1"), "the error says which entry is wrong");
  assert.ok(!leaked.includes(hashA), "the error does not echo the hash");
  assert.ok(!leaked.includes(PASSWORD), "the error does not echo a password");
  console.log("portalCredentials: a config error names the entry without echoing its hash");

  // Splitting on the first colon means a customer ID containing one is read as
  // a shorter ID with a hash that then fails to decode - so the entry is
  // REFUSED. That is the behaviour we want: a colon in an ID is unsupported,
  // and unsupported must be loud. Splitting on the last colon instead would
  // have loaded this entry under a truncated ID, which is the silent version.
  assert.throws(function () {
    loadPortalCredentials("ns:CUST-9:" + hashA);
  }, PortalCredentialError);
  console.log("portalCredentials: a colon inside a customerId is refused, not silently truncated");

  // --------------------------------------------------------- verifyCredentials
  const ok = await verifyCredentials({ customerId: "CUST-1", password: PASSWORD }, table);
  assert.deepStrictEqual(ok, { ok: true, reason: REASONS.OK, customerId: "CUST-1" });
  console.log("portalCredentials: correct credentials are accepted");

  assert.deepStrictEqual(
    await verifyCredentials({ customerId: "CUST-1", password: OTHER_PASSWORD }, table),
    { ok: false, reason: REASONS.BAD_PASSWORD }
  );
  assert.deepStrictEqual(
    await verifyCredentials({ customerId: "CUST-NOBODY", password: PASSWORD }, table),
    { ok: false, reason: REASONS.UNKNOWN_USER }
  );
  console.log("portalCredentials: a wrong password and an unknown user are both refused");

  // Neither refusal may carry anything the caller could use.
  const refusal = await verifyCredentials({ customerId: "CUST-1", password: OTHER_PASSWORD }, table);
  assert.deepStrictEqual(Object.keys(refusal).sort(), ["ok", "reason"]);
  console.log("portalCredentials: a refusal returns only ok and reason - no hash, no hint");

  for (const bad of [
    { customerId: "", password: PASSWORD },
    { customerId: "   ", password: PASSWORD },
    { customerId: 7, password: PASSWORD },
    { customerId: "CUST-1", password: "" },
    { customerId: "CUST-1", password: null },
    { customerId: "CUST-1", password: { toString: () => PASSWORD } },
  ]) {
    assert.deepStrictEqual(await verifyCredentials(bad, table), {
      ok: false,
      reason: REASONS.MALFORMED_INPUT,
    });
  }
  console.log("portalCredentials: malformed login input is refused before any hashing");

  // A row corrupted in memory after load is distinguishable in the audit trail
  // from a wrong password, without being distinguishable to the customer.
  const corrupted = new Map(table);
  corrupted.set("CUST-1", "scrypt$nonsense");
  assert.deepStrictEqual(
    await verifyCredentials({ customerId: "CUST-1", password: PASSWORD }, corrupted),
    { ok: false, reason: REASONS.UNUSABLE_HASH }
  );
  console.log("portalCredentials: a corrupted stored hash fails closed with its own reason code");

  // ------------------------------------------------- user enumeration by timing
  // The defect this guards: returning early for an unknown user makes that
  // path measurably faster than a wrong password, which tells an attacker
  // which customer IDs exist. Both paths must do the full scrypt work.
  //
  // The bound is deliberately loose (half, not "roughly equal") because wall
  // clock on a shared machine is noisy and a flaky security test gets deleted.
  // An early return would come in orders of magnitude under it, not at 49%.
  async function timeOf(customerId, runs) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < runs; i += 1) {
      await verifyCredentials({ customerId: customerId, password: OTHER_PASSWORD }, table);
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  }
  const wrongPassword = await timeOf("CUST-1", 3);
  const unknownUser = await timeOf("CUST-NOBODY", 3);
  assert.ok(
    unknownUser >= wrongPassword * 0.5,
    "an unknown user must not be measurably cheaper than a wrong password (" +
      Math.round(unknownUser) +
      "ms vs " +
      Math.round(wrongPassword) +
      "ms)"
  );
  console.log(
    "portalCredentials: an unknown user costs the same as a wrong password (" +
      Math.round(unknownUser) +
      "ms vs " +
      Math.round(wrongPassword) +
      "ms) - no enumeration oracle"
  );

  console.log("portalCredentials: all tests passed");
}

main();
