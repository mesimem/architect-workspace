// STORY-011 hardening: an account and its payments have to survive a restart.
// A balance that resets to the full total after a deploy tells a customer they
// owe money they have already paid.
//
// THE ONLY HONEST WAY TO TEST THIS IS A SECOND PROCESS. Re-reading in this one
// would hit the module's in-memory Map and prove nothing about the file. Same
// shape as groupBooking.durability.test.js.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const STORE = "./backend/src/services/payments/paymentAccountStore";

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payment-accounts-"));
  try {
    inChildProcess(
      dir,
      `const s = require(${JSON.stringify(STORE)});
       s.openAccount({ customerId: "CUST-D", tripRef: "TRIP-D", totalCents: 500000, openedBy: "FIN-1" });
       s.recordPayment("PA-CUST-D-TRIP-D", { paymentId: "PAY-D1", amountCents: 200000, status: "succeeded" });`
    );

    // Second process: a fresh module, reading only from the file.
    const after = JSON.parse(
      inChildProcess(
        dir,
        `const s = require(${JSON.stringify(STORE)});
         const replay = s.recordPayment("PA-CUST-D-TRIP-D", { paymentId: "PAY-D1", amountCents: 200000, status: "succeeded" });
         console.log(JSON.stringify({ account: s.getAccount("PA-CUST-D-TRIP-D"), replay: replay.status }));`
      )
    );
    assert.strictEqual(after.account.balanceCents, 300000);
    assert.strictEqual(after.account.payments.length, 1);
    // Idempotency holds across the restart too.
    assert.strictEqual(after.replay, "replayed");
    console.log("paymentAccountStore durability: balance and payments survive a restart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
