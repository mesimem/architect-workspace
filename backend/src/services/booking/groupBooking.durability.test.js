// STORY-008 hardening: a group booking has to survive a restart.
//
// groupBookingService.test.js runs with COLABERRY_DATA_DIR unset, which is
// in-memory - correct for testing decisions, useless for testing durability.
// That is a real gap and not a theoretical one: "booking confirmation failure"
// is one of this story's named failure paths, the write guard reads every
// write back before calling it a success, and NONE of that has met an actual
// file. An in-memory Map reads back perfectly from a store that would have
// lost the row on disk. The identical gap was found on STORY-007 after the
// fact; this suite exists so it is not found after the fact twice.
//
// WHAT A LOST GROUP BOOKING ACTUALLY COSTS, and why it is worse than a lost
// single booking. Eight people were told they were confirmed and one card was
// charged for all eight. If the row does not survive a deploy, nobody is
// booked, the money has still moved, and the failure is discovered by eight
// travellers at an airport rather than by us. The idempotency record is on the
// same row, so losing it also means the organizer's retry books and charges
// the whole group a second time.
//
// THE ONLY HONEST WAY TO TEST THIS IS A SECOND PROCESS. Re-reading in this one
// would hit the rows already in the module's Map and prove nothing about the
// file. Same reasoning and the same shape as quotes.durability.test.js,
// roleAssignments.durability.test.js and jsonFileStore.test.js.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const SERVICE = "./backend/src/services/booking/groupBookingService";
const CRM_LOG = "./backend/src/services/booking/crmTransactionLog";
const CUSTOMERS = "./backend/src/services/crm/customerRecord";
const AUDIT = "./backend/src/services/audit/auditLog";

// FL-100 + HT-200 + SF-300, the same shared itinerary the in-memory suite
// uses. Written out rather than imported so a change to the stand-in
// inventory fails loudly instead of silently agreeing with itself.
const PER_PERSON_CENTS = 128000 + 76000 + 245000;

const MEMBERS = JSON.stringify([
  { memberId: "TRV-D-1", fullName: "Ada Lovelace" },
  { memberId: "TRV-D-2", fullName: "Grace Hopper" },
  { memberId: "TRV-D-3", fullName: "Katherine Johnson" },
]);

function inChildProcess(dir, snippet) {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, {
      COLABERRY_DATA_DIR: dir,
      // Deterministic accounting, for the reason bookTripService.test.js
      // gives: with no token the client refuses to post, which would make
      // these assertions pass or fail for the wrong reason.
      COLABERRY_ACCOUNTING_API_TOKEN: "test-token-not-a-secret",
    }),
    encoding: "utf8",
    // stderr carries the structured log lines; they are not the result.
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "colaberry-groups-"));
}

// Books the group in its own process and prints the result as JSON. `audit`
// lets a case inject an audit function that throws, which is how the rollback
// case is exercised against a real file.
function bookIn(dir, idempotencyKey, options = "{}") {
  return JSON.parse(
    inChildProcess(
      dir,
      'const s = require("' + SERVICE + '");' +
        "s.bookGroupTrip({" +
        '  organizerId: "ORG-D-1", groupName: "Serengeti 2026",' +
        '  itinerary: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },' +
        "  members: " + MEMBERS + "," +
        '  idempotencyKey: "' + idempotencyKey + '"' +
        "}, " + options + ").then(function (r) {" +
        "  console.log(JSON.stringify({" +
        "    status: r.status, groupId: r.groupId, replayed: r.replayed," +
        "    total: r.totalCents, perPerson: r.perPersonCents," +
        "    memberCount: r.memberCount" +
        "  }));" +
        "});"
    )
  );
}

function storeFile(dir) {
  return path.join(dir, "group-bookings.json");
}

function main() {
  // ============ A CONFIRMED GROUP SURVIVES, WITH EVERY MEMBER ON IT ========
  {
    const dir = freshDir();
    const booked = bookIn(dir, "durable-group-0001");
    assert.strictEqual(booked.status, "confirmed");
    assert.strictEqual(booked.memberCount, 3);

    const readBack = JSON.parse(
      inChildProcess(
        dir,
        'const s = require("' + SERVICE + '");' +
          'const g = s.getGroupBooking({ groupId: "' + booked.groupId + '", organizerId: "ORG-D-1" });' +
          "console.log(JSON.stringify({" +
          "  found: g !== null," +
          "  memberCount: g && g.members.length," +
          "  memberIds: g && g.members.map(function (m) { return m.memberId; })," +
          "  itinerary: g && g.itinerary," +
          "  total: g && g.totalCents," +
          "  status: g && g.status" +
          "}));"
      )
    );

    assert.strictEqual(readBack.found, true, "a confirmed group must survive a restart");
    // THE WHOLE GROUP, not a truncated one. A booking that comes back with two
    // of its three travellers is the partial confirmation this story's design
    // exists to make impossible, arriving by a different route.
    assert.strictEqual(readBack.memberCount, 3);
    assert.deepStrictEqual(readBack.memberIds, ["TRV-D-1", "TRV-D-2", "TRV-D-3"]);
    assert.strictEqual(readBack.status, "confirmed");
    assert.strictEqual(readBack.total, PER_PERSON_CENTS * 3);
    // The SHARED itinerary survives as one object on the group.
    assert.deepStrictEqual(readBack.itinerary, {
      flightId: "FL-100",
      hotelId: "HT-200",
      safariId: "SF-300",
    });

    console.log("groupBooking durability: a confirmed group and all its members survive a restart");
  }

  // ===== A RETRY AFTER A RESTART IS STILL A REPLAY, NOT A SECOND CHARGE =====
  //
  // THE CASE THAT MATTERS MOST IN THIS FILE. The idempotency record lives on
  // the stored row, so if the row does not survive, an organizer retrying
  // after a deploy books the group a second time and the card is charged
  // twice for eight people. In-memory this passes trivially; the Map is right
  // there. Against a file it is a genuine question.
  {
    const dir = freshDir();
    const first = bookIn(dir, "durable-group-0002");
    assert.strictEqual(first.replayed, false);

    const second = bookIn(dir, "durable-group-0002");
    assert.strictEqual(second.status, "confirmed");
    assert.strictEqual(second.replayed, true, "a retry after a restart must replay, not rebook");
    assert.strictEqual(second.groupId, first.groupId, "and it must be the same group");
    assert.strictEqual(second.total, first.total);

    // One row on disk, not two. Read raw, so this is the file's word and not
    // a module's.
    const rows = JSON.parse(fs.readFileSync(storeFile(dir), "utf8"));
    assert.strictEqual(rows.length, 1, "a replayed group must not add a second row");

    console.log("groupBooking durability: a retry after a restart replays, with no second group");
  }

  // ======== EVERY MEMBER'S BOOKING HISTORY SURVIVES, AT THEIR SHARE ========
  {
    const dir = freshDir();
    bookIn(dir, "durable-group-0003");

    const crm = JSON.parse(
      inChildProcess(
        dir,
        'const c = require("' + CUSTOMERS + '");' +
          'const r = c.getCustomerRecord({ customerId: "TRV-D-2" });' +
          "console.log(JSON.stringify({" +
          "  status: r.status," +
          "  bookingCount: r.customer && r.customer.bookingCount," +
          "  lifetime: r.customer && r.customer.lifetimeValueCents," +
          '  everyone: require("' + CRM_LOG + '").getLoggedTransactions().length' +
          "}));"
      )
    );

    assert.strictEqual(crm.status, "ok", "a member's history must survive a restart");
    assert.strictEqual(crm.bookingCount, 1);
    assert.strictEqual(crm.everyone, 3, "one durable row per member");
    // REHYDRATED, not the object we wrote. The row was serialized to JSON and
    // reparsed in another process, so this proves the SHARE is what was
    // persisted - not merely what the in-process response happened to carry.
    assert.strictEqual(
      crm.lifetime,
      PER_PERSON_CENTS,
      "a member's persisted value is their share, never the group total"
    );

    console.log("groupBooking durability: each member's history survives, at their own share");
  }

  // ============ THE AUDIT ENTRY SURVIVES, CORRECTLY ATTRIBUTED ============
  {
    const dir = freshDir();
    const booked = bookIn(dir, "durable-group-0004");

    const trail = JSON.parse(
      inChildProcess(
        dir,
        'const a = require("' + AUDIT + '");' +
          'const e = a.findAuditEntry(a.deriveAuditKey("' + booked.groupId + '", "group_booking.confirmed"));' +
          "console.log(JSON.stringify({" +
          "  found: e !== null," +
          "  event: e && e.event," +
          "  actor: e && e.actor," +
          "  memberCount: e && e.context.memberCount," +
          "  memberIds: e && e.context.memberIds," +
          "  total: e && e.context.totalCents," +
          "  raw: JSON.stringify(e)" +
          "}));"
      )
    );

    assert.strictEqual(trail.found, true, "the audit entry must survive a restart");
    assert.strictEqual(trail.event, "group_booking.confirmed");
    assert.strictEqual(trail.actor, "ORG-D-1");
    assert.strictEqual(trail.memberCount, 3);
    assert.deepStrictEqual(trail.memberIds, ["TRV-D-1", "TRV-D-2", "TRV-D-3"]);
    assert.strictEqual(trail.total, PER_PERSON_CENTS * 3);
    // Still no passenger manifest on disk, forever.
    assert.ok(
      !trail.raw.includes("Ada Lovelace"),
      "the persisted audit trail must not hold travellers' names"
    );

    console.log("groupBooking durability: the audit entry survives, attributed and without names");
  }

  // ===== A ROLLED-BACK UNAUDITABLE GROUP IS GONE FROM THE FILE ITSELF =====
  //
  // THE CASE GENUINELY AT RISK, and the reason this file is not just three
  // read-backs. The write guard undoes an unauditable write with store.delete.
  // In memory that is a Map delete and always works. On disk, if jsonFileStore
  // did not persist DELETIONS, the row would be absent from the writing
  // process and present in the JSON for the next process to load - a confirmed
  // group booking with no audit entry, materialising on the next deploy. The
  // guardrail would be violated with extra steps, and every in-memory test
  // would still be green.
  {
    const dir = freshDir();
    const result = bookIn(
      dir,
      "durable-group-0005",
      '{ audit: function () { throw Object.assign(new Error("audit down"), { errorClass: "UpstreamUnavailable" }); } }'
    );
    assert.strictEqual(result.status, "not_confirmed");

    // The file's own word. Either it was never created, or it is empty.
    const rowsOnDisk = fs.existsSync(storeFile(dir))
      ? JSON.parse(fs.readFileSync(storeFile(dir), "utf8"))
      : [];
    assert.strictEqual(rowsOnDisk.length, 0, "the unaudited group must be gone from the file");

    // And a fresh process agrees - no group materialises on the next start.
    const afterRestart = inChildProcess(
      dir,
      'const s = require("' + SERVICE + '");' +
        'console.log(String(s.getGroupBooking({ groupId: "' + result.groupId + '", organizerId: "ORG-D-1" }) !== null));'
    );
    assert.strictEqual(afterRestart, "false");

    console.log("groupBooking durability: an unauditable group is rolled back on disk, not just in memory");
  }

  // ===== AND THE ROLLED-BACK KEY IS STILL USABLE AFTER A RESTART =====
  //
  // The counterpart to the case above. Rolling the row back is only correct if
  // the organizer can then actually book: a rollback that leaves the key
  // unusable has traded an unaudited booking for a group that can never be
  // made at all.
  {
    const dir = freshDir();
    const failed = bookIn(
      dir,
      "durable-group-0006",
      '{ audit: function () { throw new Error("audit down"); } }'
    );
    assert.strictEqual(failed.status, "not_confirmed");

    const retried = bookIn(dir, "durable-group-0006");
    assert.strictEqual(retried.status, "confirmed", "the key must still be usable after a rollback");
    assert.strictEqual(retried.replayed, false, "and it is a genuine first booking, not a replay");
    assert.strictEqual(retried.memberCount, 3);

    const rows = JSON.parse(fs.readFileSync(storeFile(dir), "utf8"));
    assert.strictEqual(rows.length, 1);

    console.log("groupBooking durability: a rolled-back key still books cleanly after a restart");
  }

  console.log("groupBooking durability: all tests passed");
}

main();
