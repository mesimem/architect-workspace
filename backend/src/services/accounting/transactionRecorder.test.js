const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { recordTransaction, accountingAuditKey } = require("./transactionRecorder");
const { getLedger, findPosted, AccountingAuthError } = require("./accountingClient");
const { findAuditEntry, hasAuditEntry, getAuditEntries } = require("../audit/auditLog");

const TOKEN = "test-accounting-token";
const FAST = { timeoutMs: 20, maxAttempts: 2 };
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function transactionFor(id, overrides) {
  return Object.assign(
    {
      transactionId: id,
      customerId: "CUST-1",
      entryType: "sale",
      amountCents: 249900,
      currency: "USD",
      occurredAt: "2026-09-01T12:00:00.000Z",
      memo: "Trip " + id,
    },
    overrides
  );
}

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, {
      COLABERRY_DATA_DIR: dir,
      COLABERRY_ACCOUNTING_API_TOKEN: TOKEN,
    }),
    encoding: "utf8",
  }).trim();
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;

  // CRITERION 1: a completed transaction is logged in the accounting software.
  const ok = await recordTransaction(
    Object.assign(
      {
        auditKey: "rec-txn-0001",
        transaction: transactionFor("txn-rec-0001"),
        completed: true,
        actor: "CUST-1",
        correlationId: "corr-abc",
        token: TOKEN,
      },
      FAST
    )
  );

  assert.strictEqual(ok.status, "recorded_and_posted");
  assert.strictEqual(ok.posted, true);
  assert.strictEqual(ok.audited, true);
  assert.ok(ok.reference.startsWith("ACCT-"));
  assert.ok(
    getLedger().some(function (r) {
      return r.transactionId === "txn-rec-0001";
    })
  );

  console.log("transactionRecorder: a completed transaction is posted to the accounting software");

  // CRITERION 3, for the completed case: two audit entries - what happened, and
  // what we did about it in the books.
  const okEntry = findAuditEntry("rec-txn-0001");
  assert.strictEqual(okEntry.event, "transaction.processed");
  assert.strictEqual(okEntry.outcome, "success");
  assert.strictEqual(okEntry.actor, "CUST-1");
  assert.strictEqual(okEntry.resource, "txn-rec-0001");
  assert.strictEqual(okEntry.correlationId, "corr-abc");
  assert.strictEqual(okEntry.context.amountCents, 249900);

  const okPostEntry = findAuditEntry(accountingAuditKey("rec-txn-0001", "posted"));
  assert.strictEqual(okPostEntry.event, "accounting.post");
  assert.strictEqual(okPostEntry.outcome, "success");
  assert.strictEqual(okPostEntry.context.reference, ok.reference);
  assert.strictEqual(ok.accountingAudited, true);

  console.log("transactionRecorder: the completed transaction produced both audit entries");

  // CRITERION 2: a failed transaction is NOT logged in the accounting software
  // - and the accounting API is never even called, so there is nothing to undo.
  let failedPosterCalls = 0;
  const shouldNotBeCalled = async function () {
    failedPosterCalls += 1;
    return { reference: "ACCT-SHOULD-NOT-EXIST" };
  };

  const ledgerBefore = getLedger().length;
  const failed = await recordTransaction(
    Object.assign(
      {
        auditKey: "rec-txn-0002",
        transaction: transactionFor("txn-rec-0002"),
        completed: false,
        reason: "payment_declined",
        actor: "CUST-2",
        post: shouldNotBeCalled,
        token: TOKEN,
      },
      FAST
    )
  );

  assert.strictEqual(failed.status, "recorded_not_posted");
  assert.strictEqual(failed.posted, false);
  assert.strictEqual(failed.accounting, null);
  assert.strictEqual(failedPosterCalls, 0, "a failed transaction must not reach the accounting API");
  assert.strictEqual(getLedger().length, ledgerBefore);
  assert.strictEqual(findPosted("txn-rec-0002"), null);

  // CRITERION 3, for the failed case: audited anyway. This is the pair of
  // criteria that forces two stores - the books exclude it, the audit log
  // does not.
  assert.strictEqual(failed.audited, true);
  const failedEntry = findAuditEntry("rec-txn-0002");
  assert.strictEqual(failedEntry.outcome, "failure");
  assert.strictEqual(failedEntry.context.reason, "payment_declined");
  assert.strictEqual(failedEntry.context.completed, false);
  // No accounting entry, because no accounting attempt was made.
  assert.strictEqual(hasAuditEntry(accountingAuditKey("rec-txn-0002", "posted")), false);

  console.log("transactionRecorder: a failed transaction is audited but never reaches the books");

  // A POST THAT FAILS still leaves the transaction audited. This is the case
  // the write-ahead ordering exists for: the accounting API is down, and the
  // audit log is the only thing that knows the transaction happened.
  const rejecting = async function () {
    throw new AccountingAuthError();
  };
  const postFailed = await recordTransaction(
    Object.assign(
      {
        auditKey: "rec-txn-0003",
        transaction: transactionFor("txn-rec-0003"),
        completed: true,
        actor: "CUST-3",
        post: rejecting,
        token: "wrong-token",
      },
      FAST
    )
  );

  assert.strictEqual(postFailed.status, "recorded_post_failed");
  assert.strictEqual(postFailed.posted, false);
  assert.strictEqual(postFailed.audited, true);
  assert.strictEqual(postFailed.reference, null);

  const processedEntry = findAuditEntry("rec-txn-0003");
  assert.strictEqual(processedEntry.outcome, "success"); // the transaction DID complete
  const failedPostEntry = findAuditEntry(accountingAuditKey("rec-txn-0003", "unauthorized"));
  assert.strictEqual(failedPostEntry.outcome, "failure"); // the POST did not
  assert.strictEqual(failedPostEntry.context.errorClass, "AuthError");
  assert.ok(!JSON.stringify(getAuditEntries()).includes("wrong-token"));

  console.log("transactionRecorder: a failed post still leaves the transaction audited");

  // RECOVERY: call again with the SAME auditKey once the credential is fixed.
  // The post is retried even though the first audit entry replays, because the
  // previous run may have died before it got that far.
  const recovered = await recordTransaction(
    Object.assign(
      {
        auditKey: "rec-txn-0003",
        transaction: transactionFor("txn-rec-0003"),
        completed: true,
        actor: "CUST-3",
        token: TOKEN,
      },
      FAST
    )
  );

  assert.strictEqual(recovered.status, "recorded_and_posted");
  assert.strictEqual(recovered.posted, true);
  assert.strictEqual(recovered.replayed, true, "the transaction entry replays rather than duplicating");

  // THE TRAIL SHOWS BOTH: the failure and the recovery. This is why the
  // accounting status is part of the entry's key.
  assert.strictEqual(
    findAuditEntry(accountingAuditKey("rec-txn-0003", "unauthorized")).outcome,
    "failure"
  );
  assert.strictEqual(
    findAuditEntry(accountingAuditKey("rec-txn-0003", "posted")).outcome,
    "success"
  );

  console.log("transactionRecorder: a retry after a failed post records the recovery, not just the failure");

  // IDEMPOTENCY: recording the same completed transaction twice does not
  // produce a second entry in the books.
  const ledgerSize = getLedger().length;
  const replay = await recordTransaction(
    Object.assign(
      {
        auditKey: "rec-txn-0001",
        transaction: transactionFor("txn-rec-0001"),
        completed: true,
        actor: "CUST-1",
        token: TOKEN,
      },
      FAST
    )
  );

  assert.strictEqual(replay.posted, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.accounting.status, "already_posted");
  assert.strictEqual(replay.reference, ok.reference);
  assert.strictEqual(getLedger().length, ledgerSize, "a replay must not add a second ledger row");

  console.log("transactionRecorder: replaying a completed transaction cannot double-post it");

  // MALFORMED DATA on a transaction that did complete: audited as completed,
  // refused by the books, and the refusal is itself audited.
  const malformed = await recordTransaction(
    Object.assign(
      {
        auditKey: "rec-txn-0004",
        transaction: transactionFor("txn-rec-0004", { amountCents: 12.5, currency: "dollars" }),
        completed: true,
        actor: "CUST-4",
        token: TOKEN,
      },
      FAST
    )
  );

  assert.strictEqual(malformed.status, "recorded_post_failed");
  assert.strictEqual(malformed.posted, false);
  assert.strictEqual(malformed.accounting.status, "invalid_transaction");
  assert.strictEqual(findAuditEntry("rec-txn-0004").outcome, "success");
  assert.strictEqual(
    findAuditEntry(accountingAuditKey("rec-txn-0004", "invalid_transaction")).outcome,
    "failure"
  );

  console.log("transactionRecorder: malformed data is audited and kept out of the books");

  // NO AUDIT, NO POST. If we cannot record what we are about to do, we do not
  // do it - an untraceable entry in someone's books is worse than a missing one.
  let neverCalled = 0;
  const guard = async function () {
    neverCalled += 1;
    return { reference: "ACCT-NEVER" };
  };

  for (const badKey of [undefined, "short", null, 12345, "a".repeat(129)]) {
    const refused = await recordTransaction(
      Object.assign(
        {
          auditKey: badKey,
          transaction: transactionFor("txn-rec-0005"),
          completed: true,
          post: guard,
          token: TOKEN,
        },
        FAST
      )
    );
    assert.strictEqual(refused.status, "audit_failed");
    assert.strictEqual(refused.audited, false);
    assert.strictEqual(refused.posted, false);
    assert.strictEqual(refused.errorClass, "ValidationError");
  }

  assert.strictEqual(neverCalled, 0, "nothing may be posted that could not be audited");
  assert.strictEqual(findPosted("txn-rec-0005"), null);

  console.log("transactionRecorder: what cannot be audited is not posted");

  // DURABILITY OF THE DEDUP, ACROSS A REAL RESTART. This is the one store where
  // forgetting means a duplicate entry in someone's real books, so it is tested
  // against two processes rather than assumed from the shared store's tests.
  const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-acct-"));
  const childCall =
    "const r = require('./backend/src/services/accounting/transactionRecorder');" +
    "const c = require('./backend/src/services/accounting/accountingClient');" +
    "r.recordTransaction({ auditKey: 'rec-restart-0001', completed: true, actor: 'CUST-R'," +
    " transaction: { transactionId: 'txn-restart-0001', customerId: 'CUST-R', entryType: 'sale'," +
    " amountCents: 100000, currency: 'USD', occurredAt: '2026-09-01T12:00:00.000Z' } })" +
    ".then(o => console.log(JSON.stringify([o.status, o.posted, o.accounting.status, c.getLedger().length])));";

  const first = JSON.parse(inChildProcess(restartDir, childCall));
  assert.deepStrictEqual(first, ["recorded_and_posted", true, "posted", 1]);

  const second = JSON.parse(inChildProcess(restartDir, childCall));
  // posted: true, but "already_posted" and an EMPTY in-process ledger - the
  // second process never called the API, because the durable dedup record
  // survived the restart.
  assert.deepStrictEqual(second, ["recorded_and_posted", true, "already_posted", 0]);

  console.log("transactionRecorder: the dedup survives a restart, so a rerun cannot double-post");

  fs.rmSync(restartDir, { recursive: true, force: true });

  console.log("transactionRecorder: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
