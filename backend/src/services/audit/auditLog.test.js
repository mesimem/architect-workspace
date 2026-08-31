const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  recordAudit,
  getAuditEntries,
  findAuditEntry,
  hasAuditEntry,
  InvalidAuditEntryError,
} = require("./auditLog");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

// Same pattern as jsonFileStore.test.js: the only honest way to test "survives
// a restart" is a second process, because re-reading in this one would just
// hit the rows already in memory.
function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
  }).trim();
}

function main() {
  // In-memory for this suite. A test run that inherits the previous run's audit
  // rows is not a test.
  delete process.env.COLABERRY_DATA_DIR;

  // HAPPY PATH: a transaction is recorded and comes back with every field the
  // observability rules ask for.
  const recorded = recordAudit({
    auditKey: "audit-txn-0001",
    event: "transaction.processed",
    outcome: "success",
    actor: "CUST-1",
    resource: "TRIP-1",
    correlationId: "corr-1111",
    context: { amountCents: 249900, currency: "USD" },
  });

  assert.strictEqual(recorded.replayed, false);
  assert.strictEqual(recorded.entry.auditKey, "audit-txn-0001");
  assert.strictEqual(recorded.entry.event, "transaction.processed");
  assert.strictEqual(recorded.entry.outcome, "success");
  assert.strictEqual(recorded.entry.actor, "CUST-1");
  assert.strictEqual(recorded.entry.resource, "TRIP-1");
  assert.strictEqual(recorded.entry.correlationId, "corr-1111");
  assert.deepStrictEqual(recorded.entry.context, { amountCents: 249900, currency: "USD" });
  assert.ok(!Number.isNaN(Date.parse(recorded.entry.recordedAt)));
  assert.strictEqual(hasAuditEntry("audit-txn-0001"), true);
  assert.deepStrictEqual(findAuditEntry("audit-txn-0001"), recorded.entry);

  console.log("auditLog: happy path records an entry with the full observability shape");

  // A FAILED TRANSACTION IS STILL AUDITED. This is the criterion that separates
  // this store from the accounting client: the accounting software must not
  // receive a failed transaction, but the audit trail must still show it was
  // attempted and why it was refused.
  const failed = recordAudit({
    auditKey: "audit-txn-0002",
    event: "transaction.processed",
    outcome: "failure",
    actor: "CUST-2",
    resource: "TRIP-2",
    context: { reason: "payment_declined" },
  });

  assert.strictEqual(failed.entry.outcome, "failure");
  assert.strictEqual(failed.entry.context.reason, "payment_declined");
  assert.strictEqual(hasAuditEntry("audit-txn-0002"), true);

  console.log("auditLog: a failed transaction is audited, not dropped");

  // IDEMPOTENCY: the same key twice appends nothing, and the FIRST write wins.
  // A retry arriving with different content must not rewrite what we already
  // recorded - that would let a caller launder its own history.
  const before = getAuditEntries().length;
  const replay = recordAudit({
    auditKey: "audit-txn-0001",
    event: "transaction.processed",
    outcome: "failure", // deliberately different from the original "success"
    actor: "SOMEONE-ELSE",
    resource: "TRIP-999",
    context: { amountCents: 1 },
  });

  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.entry.outcome, "success");
  assert.strictEqual(replay.entry.actor, "CUST-1");
  assert.strictEqual(replay.entry.resource, "TRIP-1");
  assert.strictEqual(getAuditEntries().length, before);

  console.log("auditLog: a replayed key returns the original entry and appends nothing");

  // APPEND-ONLY: what a caller is handed cannot be used to edit the store.
  // Non-strict assignment to a frozen object fails silently, so the assertion
  // is on the value afterwards rather than on a throw.
  const handed = findAuditEntry("audit-txn-0001");
  handed.outcome = "failure";
  handed.context.amountCents = 0;
  assert.strictEqual(findAuditEntry("audit-txn-0001").outcome, "success");
  assert.strictEqual(findAuditEntry("audit-txn-0001").context.amountCents, 249900);

  // And there is no update or delete on the module surface to reach for either.
  const surface = Object.keys(require("./auditLog"));
  assert.ok(!surface.some((name) => /update|delete|remove|clear/i.test(name)));

  console.log("auditLog: entries are frozen and the module exposes no way to edit history");

  // SECRETS NEVER REACH DISK. context is caller-supplied and persists forever,
  // so anything key-shaped like a credential is replaced on the way in.
  const redacted = recordAudit({
    auditKey: "audit-txn-0003",
    event: "accounting.post",
    outcome: "success",
    context: {
      apiToken: "super-secret-value",
      nested: { password: "hunter2", safe: "keep-me" },
      list: [{ authorization: "Bearer abc" }],
      amountCents: 100,
    },
  });

  const ctx = redacted.entry.context;
  assert.strictEqual(ctx.apiToken, "<redacted>");
  assert.strictEqual(ctx.nested.password, "<redacted>");
  assert.strictEqual(ctx.nested.safe, "keep-me");
  assert.strictEqual(ctx.list[0].authorization, "<redacted>");
  assert.strictEqual(ctx.amountCents, 100);
  assert.ok(!JSON.stringify(redacted.entry).includes("super-secret-value"));
  assert.ok(!JSON.stringify(redacted.entry).includes("hunter2"));

  console.log("auditLog: credential-shaped context keys are redacted before they are stored");

  // A deeply nested context is truncated rather than walked forever.
  const deep = recordAudit({
    auditKey: "audit-txn-0004",
    event: "accounting.post",
    outcome: "success",
    context: { a: { b: { c: { d: { e: { f: 1 } } } } } },
  });
  assert.strictEqual(deep.entry.context.a.b.c.d.e, "<truncated>");

  console.log("auditLog: context nesting is capped instead of recursing without a bound");

  // FAILURE PATH: an unusable entry is REFUSED, loudly. Callers must treat this
  // as a refusal to serve - an unauditable transaction is a compliance hole,
  // not a logging nuisance.
  const badEntries = [
    { auditKey: "short", event: "x", outcome: "success" }, // key too short
    { auditKey: undefined, event: "x", outcome: "success" }, // key missing
    { auditKey: "a".repeat(129), event: "x", outcome: "success" }, // key too long
    { auditKey: "audit-txn-0005", event: "", outcome: "success" }, // event blank
    { auditKey: "audit-txn-0005", event: 42, outcome: "success" }, // event not a string
    { auditKey: "audit-txn-0005", event: "x", outcome: "done" }, // unknown outcome
    { auditKey: "audit-txn-0005", event: "x", outcome: undefined }, // outcome missing
  ];

  badEntries.forEach(function (bad, index) {
    assert.throws(
      function () {
        recordAudit(bad);
      },
      function (error) {
        return (
          error instanceof InvalidAuditEntryError &&
          error.errorClass === "ValidationError" &&
          // The message must not echo an oversized or untrusted key value.
          !error.message.includes("a".repeat(129))
        );
      },
      "bad entry #" + index + " should have been refused"
    );
  });

  // Nothing partial was written by any of those refusals.
  assert.strictEqual(hasAuditEntry("audit-txn-0005"), false);

  console.log("auditLog: unusable entries are refused with a ValidationError and write nothing");

  // DURABILITY: an audit trail that forgets on restart maintains nothing. This
  // is the guardrail REQ-017 actually asks for, so it is tested against two
  // real processes rather than asserted in a comment.
  const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-audit-"));

  const written = inChildProcess(
    restartDir,
    "const a = require('./backend/src/services/audit/auditLog');" +
      "a.recordAudit({ auditKey: 'audit-restart-0001', event: 'transaction.processed', " +
      "outcome: 'success', actor: 'CUST-R', resource: 'TRIP-R' });" +
      "console.log(a.getAuditEntries().length);"
  );
  assert.strictEqual(written, "1");

  const afterRestart = inChildProcess(
    restartDir,
    "const a = require('./backend/src/services/audit/auditLog');" +
      "const again = a.recordAudit({ auditKey: 'audit-restart-0001', event: 'transaction.processed', " +
      "outcome: 'failure', actor: 'CUST-R', resource: 'TRIP-R' });" +
      "const e = a.findAuditEntry('audit-restart-0001');" +
      "console.log(JSON.stringify([a.getAuditEntries().length, e.outcome, e.resource, again.replayed]));"
  );
  assert.deepStrictEqual(JSON.parse(afterRestart), [1, "success", "TRIP-R", true]);

  console.log("auditLog: an entry survives a real process restart, and so does its idempotency");

  fs.rmSync(restartDir, { recursive: true, force: true });

  console.log("auditLog: all tests passed");
}

main();
