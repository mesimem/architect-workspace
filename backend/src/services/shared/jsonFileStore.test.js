const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { createJsonFileStore, CorruptStoreError } = require("./jsonFileStore");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function freshDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-" + label + "-"));
}

// Runs a snippet in a SEPARATE node process with COLABERRY_DATA_DIR set. This
// is the only honest way to test "survives a restart": re-reading the file in
// this process would prove nothing, because the rows are already in memory.
function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
  }).trim();
}

function main() {
  // Default (no COLABERRY_DATA_DIR) is in-memory, which is what keeps the rest
  // of the suite deterministic - no run inherits the previous run's rows.
  delete process.env.COLABERRY_DATA_DIR;
  const ephemeral = createJsonFileStore("ephemeral-check");
  assert.strictEqual(ephemeral.persistent, false);
  assert.strictEqual(ephemeral.filePath, null);
  ephemeral.set("k", { v: 1 });
  assert.deepStrictEqual(ephemeral.get("k"), { v: 1 });
  ephemeral.flush(); // no-op, must not throw

  console.log("jsonFileStore: unset COLABERRY_DATA_DIR means in-memory, no files written");

  // With the variable set, rows are written to disk under the store's name.
  const dir = freshDir("store");
  process.env.COLABERRY_DATA_DIR = dir;
  const store = createJsonFileStore("unit-check");
  assert.strictEqual(store.persistent, true);
  store.set("a", { hello: "world" });

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "unit-check.json"), "utf8"));
  assert.deepStrictEqual(onDisk, [["a", { hello: "world" }]]);

  console.log("jsonFileStore: rows are written to disk as JSON");

  // No stray temp file is left behind - the write is temp-then-rename, and the
  // temp must not survive the rename.
  assert.ok(!fs.existsSync(path.join(dir, "unit-check.json.tmp")));

  console.log("jsonFileStore: the atomic write leaves no temp file behind");

  // A corrupt file is fatal rather than silently starting empty. Discarding an
  // audit trail without saying so is worse than refusing to start.
  fs.writeFileSync(path.join(dir, "corrupt-check.json"), "{ this is not json", "utf8");
  assert.throws(
    function () {
      createJsonFileStore("corrupt-check");
    },
    function (error) {
      return error instanceof CorruptStoreError && error.errorClass === "ContractViolation";
    }
  );

  // A file holding valid JSON of the wrong SHAPE is equally fatal.
  fs.writeFileSync(path.join(dir, "wrongshape-check.json"), '{"not":"an array"}', "utf8");
  assert.throws(function () {
    createJsonFileStore("wrongshape-check");
  }, CorruptStoreError);

  console.log("jsonFileStore: a corrupt or wrong-shaped file refuses to load");

  delete process.env.COLABERRY_DATA_DIR;

  // THE REAL TEST: does an advisor review survive a process restart? Two
  // separate node processes, same data directory.
  const restartDir = freshDir("restart");

  const written = inChildProcess(
    restartDir,
    "const q = require('./backend/src/services/advisor/advisorReviewQueue');" +
      "q.queueForReview('RESTART-TEST-0001', { customerId: 'CUST-R', reasons: ['ambiguous_wording'], flaggedAt: 'now' });" +
      "q.recordNotification('RESTART-TEST-0001', 'failed', 'TimeoutError');" +
      "console.log(q.getQueuedReviews().length);"
  );
  assert.strictEqual(written, "1");

  const afterRestart = inChildProcess(
    restartDir,
    "const q = require('./backend/src/services/advisor/advisorReviewQueue');" +
      "const r = q.findReview('RESTART-TEST-0001');" +
      "console.log(JSON.stringify([q.getQueuedReviews().length, r && r.customerId, r && r.status, r && r.notificationStatus, r && r.reasons]));"
  );
  assert.deepStrictEqual(JSON.parse(afterRestart), [
    1,
    "CUST-R",
    "pending_review",
    "failed", // the in-place notification update was flushed, not just held in memory
    ["ambiguous_wording"],
  ]);

  console.log("jsonFileStore: an advisor review survives a real process restart");

  // And the idempotency guarantee holds ACROSS restarts, which is the case
  // that actually matters: a retry after a crash must not re-queue the work.
  const requeued = inChildProcess(
    restartDir,
    "const q = require('./backend/src/services/advisor/advisorReviewQueue');" +
      "const out = q.queueForReview('RESTART-TEST-0001', { customerId: 'CUST-R', reasons: ['ambiguous_wording'], flaggedAt: 'later' });" +
      "console.log(JSON.stringify([out.replayed, out.review.flaggedAt, q.getQueuedReviews().length]));"
  );
  assert.deepStrictEqual(JSON.parse(requeued), [true, "now", 1]);

  console.log("jsonFileStore: idempotency holds across a restart, not just within one process");

  // The CRM transaction log and the African interaction log are durable too.
  const logsDir = freshDir("logs");
  inChildProcess(
    logsDir,
    "require('./backend/src/services/booking/crmTransactionLog').logTransaction({ tripId: 'TRIP-R1', customerId: 'CUST-R' });" +
      "require('./backend/src/services/africa/interactionLog').logInteraction('RESTART-INTERACTION-1', { customerId: 'CUST-R', outcome: 'viewed' });"
  );
  const logsAfter = inChildProcess(
    logsDir,
    "const crm = require('./backend/src/services/booking/crmTransactionLog').getLoggedTransactions();" +
      "const acts = require('./backend/src/services/africa/interactionLog').getLoggedInteractions();" +
      "console.log(JSON.stringify([crm.length, crm[0].tripId, acts.length, acts[0].outcome]));"
  );
  assert.deepStrictEqual(JSON.parse(logsAfter), [1, "TRIP-R1", 1, "viewed"]);

  console.log("jsonFileStore: the CRM and interaction audit logs survive a restart too");

  [dir, restartDir, logsDir].forEach(function (d) {
    fs.rmSync(d, { recursive: true, force: true });
  });
}

main();
