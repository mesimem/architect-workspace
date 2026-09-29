// STORY-007 hardening: a quote has to survive a restart.
//
// Every other quote suite runs with COLABERRY_DATA_DIR unset, which is
// in-memory - correct for testing decisions, useless for testing durability.
// That is a real gap rather than a theoretical one: the story's named failure
// path is "quote not saved", quoteWriteGuard reads every write back before
// calling it a success, and NONE of that had been exercised against an actual
// file. An in-memory Map reads back perfectly from a store that would have
// lost the row on disk.
//
// WHAT A LOST QUOTE ACTUALLY COSTS. A customer was sent a price. They accept
// it a week later and the quote is gone, or worse, it is there at the wrong
// version because a revision evaporated on deploy and the original came back.
// The business is then arguing with a customer about what it offered them,
// with an audit trail that says one thing and a quote book that says another.
//
// THE ONLY HONEST WAY TO TEST THIS IS A SECOND PROCESS. Re-reading in this one
// would hit the rows already in the module's Map and prove nothing about the
// file. Same reasoning, and the same shape, as
// roleAssignments.durability.test.js, auditLog.test.js and jsonFileStore.test.js.
//
// THE DIRECTION THAT MATTERS MOST IS THE REVISION. A lost CREATE is loud: the
// advisor looks for the quote, cannot find it, and re-issues it within the
// hour. A lost REVISION is silent and worse - the quote is still there, at the
// superseded price, and it looks entirely normal. So the revision gets its own
// case rather than being folded into "quotes persist".

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const STORE = "./backend/src/services/quotes/quoteStore";
const VIEW = "./backend/src/services/quotes/quoteView";
const AUDIT = "./backend/src/services/audit/auditLog";

// Safari at cost $4,200 sold at $5,000 for two. Subtotal $10,000.
const LINES = JSON.stringify([
  { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
]);

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
    // stderr carries the structured audit log lines; they are not the result.
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-quotes-"));
}

function generateIn(dir, correlationId, extra = "") {
  return inChildProcess(
    dir,
    'const s = require("' + STORE + '");' +
      "const r = s.generateQuote({" +
      '  customerId: "CUST-D-1", title: "Tanzania", lines: ' + LINES + "," +
      '  internalNotes: "Supplier may discount.",' +
      '  actor: "ADVISOR-D-1", correlationId: "' + correlationId + '"' +
      "});" +
      extra +
      'if (!r.ok) { throw new Error("generate failed: " + r.reason); }' +
      "console.log(r.quote.quoteId);"
  );
}

function main() {
  // ===== A QUOTE SURVIVES A RESTART, AND SO DOES ITS AUDIT ENTRY =====
  {
    const dir = freshDir();
    const quoteId = generateIn(dir, "corr-durable-create");

    const readBack = inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        'const q = s.getQuoteForCustomer({ customerId: "CUST-D-1", quoteId: "' + quoteId + '" });' +
        "console.log(JSON.stringify({" +
        "  found: q !== null," +
        "  version: q && q.version," +
        "  total: q && q.pricing.totalCents," +
        "  issuedBy: q && q.issuedBy," +
        "  listed: s.listQuotesForCustomer({ customerId: \"CUST-D-1\" }).length" +
        "}));"
    );
    const state = JSON.parse(readBack);
    assert.strictEqual(state.found, true, "the quote did not survive the restart");
    assert.strictEqual(state.version, 1);
    assert.strictEqual(state.total, 1000000, "the price did not survive intact");
    assert.strictEqual(state.issuedBy, "ADVISOR-D-1");
    assert.strictEqual(state.listed, 1);

    // The audit entry is a SEPARATE file. A quote that persists without its
    // entry is the guardrail violated across a restart rather than within one.
    const trail = JSON.parse(
      inChildProcess(
        dir,
        'const a = require("' + AUDIT + '");' +
          "console.log(JSON.stringify(a.getAuditEntries().filter(e => e.resource === \"" + quoteId + "\").map(e => e.event)));"
      )
    );
    assert.deepStrictEqual(trail, ["quote.generated"]);
    console.log("quotes durability: a quote and its audit entry both survive a restart");

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== THE CASE THAT MATTERS MOST: A REVISION SURVIVES =====
  // A lost revision is silent. The quote is still there, at the old price,
  // looking entirely normal.
  {
    const dir = freshDir();
    const quoteId = generateIn(dir, "corr-durable-revise");

    inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        "const r = s.modifyQuote({" +
        '  quoteId: "' + quoteId + '", changes: { discountBasisPoints: 1000 },' +
        '  actor: "ADVISOR-D-2", correlationId: "corr-durable-revision-save"' +
        "});" +
        'if (!r.ok || !r.changed) { throw new Error("modify failed: " + r.reason); }' +
        "console.log(r.quote.version);"
    );

    // Third process: neither the create nor the revision happened in it.
    const after = JSON.parse(
      inChildProcess(
        dir,
        'const s = require("' + STORE + '");' +
          'const v = require("' + VIEW + '");' +
          'const q = s.getQuoteForCustomer({ customerId: "CUST-D-1", quoteId: "' + quoteId + '" });' +
          "console.log(JSON.stringify(v.customerQuoteView(q)));"
      )
    );
    assert.strictEqual(after.version, 2, "the revision was lost - the quote reverted to v1");
    assert.strictEqual(after.discountCents, 100000);
    assert.strictEqual(after.totalCents, 900000, "the customer would be shown the superseded price");
    console.log("quotes durability: a revision survives, so a customer is not shown a superseded price");

    // AND THE CUSTOMER VIEW IS STILL CLEAN AFTER A ROUND TRIP THROUGH JSON.
    // Worth asserting separately: the stored row is serialized and reparsed
    // between processes, so this proves the projection filters the REHYDRATED
    // record and not just the frozen object priceQuote happened to return.
    const serialized = JSON.stringify(after);
    assert.ok(!serialized.includes("420000"), "a unit cost survived into the customer view");
    assert.ok(!serialized.includes("840000"), "a line cost survived into the customer view");
    assert.ok(!serialized.includes("Supplier may discount"));
    assert.ok(!/cost|margin|internal|supplier/i.test(serialized));
    console.log("quotes durability: the rehydrated quote still renders without costs");

    // Both acts are in the trail, distinctly - the version-keyed audit key
    // holding up across processes, not just within one.
    const events = JSON.parse(
      inChildProcess(
        dir,
        'const a = require("' + AUDIT + '");' +
          "console.log(JSON.stringify(a.getAuditEntries().filter(e => e.resource === \"" + quoteId + "\").map(e => e.event + \":\" + e.actor)));"
      )
    );
    assert.deepStrictEqual(events.sort(), [
      "quote.generated:ADVISOR-D-1",
      "quote.modified:ADVISOR-D-2",
    ]);
    console.log("quotes durability: generation and revision are both in the persisted trail, attributed");

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== IDEMPOTENCY HOLDS ACROSS A RESTART, NOT JUST WITHIN ONE PROCESS =====
  // The correlationId dedup scans the store. If the store came back empty or
  // partial, a retry after a deploy would issue a SECOND quote at a second id
  // for the same request - two documents, two totals, and no way to tell a
  // customer which is real.
  {
    const dir = freshDir();
    const first = generateIn(dir, "corr-durable-idempotent");
    const second = generateIn(dir, "corr-durable-idempotent");
    assert.strictEqual(second, first, "a retry after a restart issued a second quote");

    const count = inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        'console.log(s.listQuotesForCustomer({ customerId: "CUST-D-1" }).length);'
    );
    assert.strictEqual(count, "1");
    console.log("quotes durability: a retry after a restart is still a replay, not a second quote");

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== THE ROLLBACK REACHES THE DISK TOO =====
  // quoteWriteGuard undoes a write whose audit failed. In memory that is a
  // Map.delete. On disk it has to be a file that no longer contains the row -
  // an unauditable quote that is merely absent from one process's Map, while
  // sitting in the JSON for the next process to load, is the guardrail
  // violated with extra steps.
  {
    const dir = freshDir();
    inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        "const failing = function () { throw Object.assign(new Error(\"audit down\"), { errorClass: \"UpstreamUnavailable\" }); };" +
        "const r = s.generateQuote({" +
        '  customerId: "CUST-D-1", lines: ' + LINES + ',' +
        '  actor: "ADVISOR-D-1", correlationId: "corr-durable-rollback"' +
        "}, { audit: failing });" +
        'if (r.ok) { throw new Error("expected the unauditable quote to be refused"); }' +
        'if (r.reason !== "audit_unavailable") { throw new Error("wrong reason: " + r.reason); }' +
        "console.log(r.reason);"
    );

    // The next process must not find it. This is the assertion that would fail
    // if the rollback only ever undid the in-memory copy.
    const survived = inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        'console.log(s.listQuotesForCustomer({ customerId: "CUST-D-1" }).length);'
    );
    assert.strictEqual(survived, "0", "an unauditable quote was left on disk for the next process");

    // And the store file itself, read raw - no rows, or no file at all.
    const storeFile = path.join(dir, "quotes.json");
    if (fs.existsSync(storeFile)) {
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(storeFile, "utf8")), []);
    }
    console.log("quotes durability: a rolled-back quote is gone from the file, not just from memory");

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("quotes durability: all tests passed");
}

main();
