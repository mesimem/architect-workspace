// STORY-013: the story's third named failure path - "system crash during
// proposal creation".
//
// Every other proposal suite runs with COLABERRY_DATA_DIR unset, which is
// in-memory. That is correct for testing decisions and useless for testing this
// one, because the whole claim of this story is about what is still true after
// the process goes away. An in-memory Map survives a restart perfectly, having
// never restarted.
//
// THE CLAIM UNDER TEST, AND IT IS THE LOAD-BEARING ONE. `startedAt` is written
// to disk before any work happens and never rewritten, so a restart reloads the
// ORIGINAL start instant. A proposal that has been open for a hundred minutes
// across a crash is a hundred minutes late - not freshly opened.
//
// WHY THAT IS WORTH A SUITE OF ITS OWN. Get it wrong and the system does not
// break, it flatters itself: every restart silently resets every clock, so no
// proposal is ever late, AC-1 passes for every proposal ever made, and AC-2
// never fires. A deploy in the middle of a busy afternoon would wipe the SLA
// for every proposal in progress and nothing anywhere would say so. That is a
// far worse failure than losing a row, because losing a row is loud - the
// advisor looks for their draft, cannot find it, and starts again.
//
// THE ONLY HONEST WAY TO TEST THIS IS A SECOND PROCESS. Re-reading in this one
// would hit the rows already in the module's Map and prove nothing about the
// file. Same reasoning, and the same shape, as quotes.durability.test.js,
// roleAssignments.durability.test.js and jsonFileStore.test.js.
//
// THE SECOND CLAIM: THE DELAY PAGE DEDUPS ACROSS A RESTART. The notifier keys
// "have we paged about this?" on the durable audit log rather than an in-memory
// Set, precisely so a reboot cannot re-page every advisor whose proposal was
// already late. proposalDelayNotifier.test.js proves that against a fake
// durable store; only this file proves it against a real one.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const STORE = "./backend/src/services/proposals/proposalStore";
const NOTIFIER = "./backend/src/services/proposals/proposalDelayNotifier";
const AUDIT = "./backend/src/services/audit/auditLog";

// Safari at cost $4,200 sold at $5,000 for two. Subtotal $10,000.
const DETAILS = JSON.stringify({
  title: "Ten days in Tanzania",
  lines: [
    { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
  ],
  currency: "USD",
  internalNotes: "Supplier may discount.",
});

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { COLABERRY_DATA_DIR: dir }),
    encoding: "utf8",
    // stderr carries the structured audit and notifier log lines; they are not
    // the result.
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-proposals-"));
}

// Opens a draft in its own process, with a start instant we choose. Back-dating
// it is how a "hundred minutes ago" draft exists without the test waiting.
function openIn(dir, correlationId, startedAt) {
  return inChildProcess(
    dir,
    'const s = require("' + STORE + '");' +
      "const r = s.startProposal({" +
      '  customerId: "CUST-D-13", tripReference: "TRIP-D-13", title: "Tanzania",' +
      '  actor: "ADVISOR-D-13", correlationId: "' + correlationId + '"' +
      '}, { now: function () { return "' + startedAt + '"; } });' +
      'if (!r.ok) { throw new Error("start failed: " + r.reason); }' +
      "console.log(r.proposal.proposalId);"
  );
}

// Issues it in another process, at an instant we choose, and reports the SLA
// verdict that was recorded. The notifier is stubbed out here so that the
// paging cases below can be about paging and nothing else.
function completeIn(dir, proposalId, completedAt) {
  return JSON.parse(
    inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        "(async function () {" +
        "  const r = await s.completeProposal({" +
        '    proposalId: "' + proposalId + '", details: ' + DETAILS + "," +
        '    actor: "ADVISOR-D-13", correlationId: "corr-complete-' + proposalId.slice(-8) + '"' +
        "  }, {" +
        '    now: function () { return "' + completedAt + '"; },' +
        "    notifyDelay: async function () { return { status: \"stubbed\", notified: false }; }" +
        "  });" +
        "  console.log(JSON.stringify({" +
        "    ok: r.ok, reason: r.reason || null," +
        "    startedAt: r.ok && r.proposal.startedAt," +
        "    version: r.ok && r.proposal.version," +
        "    breached: r.ok && r.sla.breached," +
        "    elapsedMs: r.ok && r.sla.elapsedMs," +
        "    totalCents: r.ok && r.proposal.pricing.totalCents" +
        "  }));" +
        "})();"
    )
  );
}

function main() {
  // ===== A DRAFT SURVIVES A RESTART, WITH ITS ORIGINAL CLOCK =====
  {
    const dir = freshDir();
    const startedAt = "2026-09-30T09:00:00.000Z";
    const proposalId = openIn(dir, "corr-durable-open-01", startedAt);

    const readBack = JSON.parse(
      inChildProcess(
        dir,
        'const s = require("' + STORE + '");' +
          'const p = s.getProposalForStaff({ proposalId: "' + proposalId + '" });' +
          "console.log(JSON.stringify({" +
          "  found: p !== null," +
          "  startedAt: p && p.startedAt," +
          "  status: p && p.status," +
          "  version: p && p.version," +
          "  openedBy: p && p.openedBy" +
          "}));"
      )
    );
    assert.strictEqual(readBack.found, true, "the draft did not survive the restart");
    assert.strictEqual(readBack.status, "drafting");
    assert.strictEqual(readBack.version, 1);
    assert.strictEqual(readBack.openedBy, "ADVISOR-D-13");
    // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
    assert.strictEqual(readBack.startedAt, startedAt, "the clock was reset by the restart");
    console.log("proposals.durability: a draft survives a restart with its original start instant");
  }

  // ===== A RESTART CANNOT HIDE AN OVERRUN =====
  // The draft was opened a hundred minutes ago, the process died, and it comes
  // back. It must still be a hundred minutes late. If startedAt were re-stamped
  // on load - or held only in memory and rebuilt - this is the case that would
  // silently pass forever while the SLA meant nothing.
  {
    const dir = freshDir();
    const hundredMinutesAgo = new Date(Date.now() - 100 * 60 * 1000).toISOString();
    const proposalId = openIn(dir, "corr-durable-open-02", hundredMinutesAgo);

    const afterRestart = JSON.parse(
      inChildProcess(
        dir,
        'const s = require("' + STORE + '");' +
          "const late = s.listBreachedOpenProposals();" +
          'const p = s.getProposalForStaff({ proposalId: "' + proposalId + '" });' +
          "const clock = require(\"./backend/src/services/proposals/proposalClock\");" +
          "const position = clock.slaPositionFor(p, new Date().toISOString());" +
          "console.log(JSON.stringify({" +
          "  listedAsLate: late.some(function (x) { return x.proposalId === p.proposalId; })," +
          "  breached: position.breached," +
          "  overdueMs: position.overdueMs," +
          "  startedAt: p.startedAt" +
          "}));"
      )
    );
    assert.strictEqual(afterRestart.startedAt, hundredMinutesAgo);
    assert.strictEqual(afterRestart.breached, true, "a restart hid the overrun");
    assert.ok(afterRestart.overdueMs > 69 * 60 * 1000, "about seventy minutes past the deadline");
    assert.strictEqual(afterRestart.listedAsLate, true, "and it is not in the breach list");
    console.log("proposals.durability: a draft late before the crash is still late after it");
  }

  // ===== A PROPOSAL OPENED IN ONE PROCESS IS ISSUED IN ANOTHER =====
  // The realistic shape of a restart mid-proposal: the advisor opens it before
  // a deploy and clicks Complete after. The elapsed time is measured across the
  // restart, not from the moment the new process started.
  {
    const dir = freshDir();
    const startedAt = "2026-09-30T09:00:00.000Z";
    const proposalId = openIn(dir, "corr-durable-open-03", startedAt);

    const issued = completeIn(dir, proposalId, "2026-09-30T09:41:00.000Z");
    assert.strictEqual(issued.ok, true);
    assert.strictEqual(issued.startedAt, startedAt, "completion used the pre-restart clock");
    assert.strictEqual(issued.version, 2);
    assert.strictEqual(issued.breached, true);
    assert.strictEqual(issued.elapsedMs, 2460000, "41 minutes, measured across the restart");
    assert.strictEqual(issued.totalCents, 1000000);
    console.log("proposals.durability: a proposal opened before a restart is issued with one clock");

    // AND THE RECORDED BREACH SURVIVES THE NEXT RESTART. A lost breach is the
    // silent failure: the proposal is still there, looking entirely normal, and
    // the record that it was late is gone.
    const reread = JSON.parse(
      inChildProcess(
        dir,
        'const s = require("' + STORE + '");' +
          'const p = s.getProposalForStaff({ proposalId: "' + proposalId + '" });' +
          "console.log(JSON.stringify({" +
          "  status: p.status, breached: p.sla.breached, elapsedMs: p.sla.elapsedMs," +
          "  overdueMs: p.sla.overdueMs, openBreach: s.listBreachedOpenProposals().length" +
          "}));"
      )
    );
    assert.strictEqual(reread.status, "issued");
    assert.strictEqual(reread.breached, true, "the recorded breach evaporated");
    assert.strictEqual(reread.elapsedMs, 2460000, "and the duration did not drift");
    assert.strictEqual(reread.overdueMs, 660000);
    assert.strictEqual(reread.openBreach, 0, "an issued proposal is not an open breach");
    console.log("proposals.durability: a recorded breach and its duration survive a restart");
  }

  // ===== THE AUDIT TRAIL SURVIVES TOO =====
  // AC-3 is not "an audit function was called". If the entry is gone after a
  // restart, the guarantee was never real.
  {
    const dir = freshDir();
    const proposalId = openIn(dir, "corr-durable-open-04", "2026-09-30T09:00:00.000Z");
    completeIn(dir, proposalId, "2026-09-30T09:12:00.000Z");

    const trail = JSON.parse(
      inChildProcess(
        dir,
        'const a = require("' + AUDIT + '");' +
          "const mine = a.getAuditEntries().filter(function (e) {" +
          '  return e.resource === "' + proposalId + '";' +
          "});" +
          "console.log(JSON.stringify({" +
          "  events: mine.map(function (e) { return e.event; }).sort()," +
          "  opened: !!a.findAuditEntry(\"" + proposalId + ":proposal.opened.v1\")," +
          "  issued: !!a.findAuditEntry(\"" + proposalId + ":proposal.issued.v2\")," +
          "  elapsedMs: (mine.find(function (e) { return e.event === \"proposal.issued\"; }) || {}).context.elapsedMs" +
          "}));"
      )
    );
    assert.deepStrictEqual(trail.events, ["proposal.issued", "proposal.opened"]);
    // Keyed on the version, so the issue is a second entry rather than being
    // swallowed by the audit log's first-write-wins rule.
    assert.strictEqual(trail.opened, true, "the opening entry is gone");
    assert.strictEqual(trail.issued, true, "the issuing entry is gone");
    assert.strictEqual(trail.elapsedMs, 720000, "the elapsed time in the trail did not survive");
    console.log("proposals.durability: both audit entries survive a restart, under stable keys");
  }

  // ===== THE DELAY PAGE DEDUPS ACROSS A RESTART =====
  // The reason the notifier keys on the audit log instead of a Set. Page in one
  // process, restart, and the advisor is not paged again - proven here against
  // a real file rather than a fake durable store.
  {
    const dir = freshDir();
    const hundredMinutesAgo = new Date(Date.now() - 100 * 60 * 1000).toISOString();
    const proposalId = openIn(dir, "corr-durable-open-05", hundredMinutesAgo);

    const pageSnippet =
      'const s = require("' + STORE + '");' +
      'const n = require("' + NOTIFIER + '");' +
      "(async function () {" +
      "  const summary = await n.sweepBreachedProposals({" +
      "    proposals: s.listBreachedOpenProposals()" +
      "  });" +
      "  console.log(JSON.stringify({" +
      "    considered: summary.considered, notified: summary.notified," +
      "    alreadyNotified: summary.alreadyNotified, failed: summary.failed," +
      "    outbox: n.getOutbox().length" +
      "  }));" +
      "})();";

    const firstSweep = JSON.parse(inChildProcess(dir, pageSnippet));
    assert.strictEqual(firstSweep.considered, 1);
    assert.strictEqual(firstSweep.notified, 1, "the late draft was not paged about");
    assert.strictEqual(firstSweep.outbox, 1);

    // ...process dies. New process, empty outbox, empty memory - only the disk
    // remembers.
    const secondSweep = JSON.parse(inChildProcess(dir, pageSnippet));
    assert.strictEqual(secondSweep.considered, 1, "it is still late, and still in the queue");
    assert.strictEqual(secondSweep.notified, 0, "a restart re-paged the advisor");
    assert.strictEqual(secondSweep.alreadyNotified, 1);
    assert.strictEqual(secondSweep.outbox, 0, "and nothing was sent the second time");
    console.log("proposals.durability: a restart does not re-page an advisor already told");

    // And the record of the page is itself in the trail, readable later.
    const paged = inChildProcess(
      dir,
      'const a = require("' + AUDIT + '");' +
        'console.log(String(!!a.findAuditEntry("' + proposalId + ':proposal.delay_notified")));'
    );
    assert.strictEqual(paged, "true", "the page is not in the audit trail");
    console.log("proposals.durability: the delay page is recorded durably, not just in memory");
  }

  // ===== IDEMPOTENCY HOLDS ACROSS A RESTART, NOT JUST WITHIN ONE PROCESS =====
  // The correlationId dedup is a scan of the store, so it only works if the
  // store is the one on disk. A retry that arrives after a restart - which is
  // exactly when a client retries - must not open a second proposal with a
  // second clock.
  {
    const dir = freshDir();
    const first = openIn(dir, "corr-durable-retry-06", "2026-09-30T09:00:00.000Z");
    const second = openIn(dir, "corr-durable-retry-06", "2026-09-30T09:25:00.000Z");
    assert.strictEqual(second, first, "the retry opened a second proposal after the restart");

    const count = inChildProcess(
      dir,
      'const s = require("' + STORE + '");' +
        'const p = s.getProposalForStaff({ proposalId: "' + first + '" });' +
        "console.log(p.startedAt);"
    );
    assert.strictEqual(count, "2026-09-30T09:00:00.000Z", "the retry restarted the clock");
    console.log("proposals.durability: a retry after a restart replays instead of restarting a clock");
  }

  console.log("proposals.durability: all tests passed");
}

main();
