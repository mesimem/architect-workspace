// STORY-008: the three acceptance criteria, and the three named failure paths.
//
//   CRITERION 1  a complete group booking confirms for ALL members
//   CRITERION 2  an incomplete one prompts for what is missing
//   CRITERION 3  every group booking transaction is logged
//
//   FAILURE      incomplete group details
//   FAILURE      payment issues
//   FAILURE      booking confirmation failure
//
// A test token keeps the accounting post deterministic instead of depending on
// the developer's environment - with no token configured the client refuses to
// post, which would make these assertions pass or fail for the wrong reason.
// Same reasoning, same line, as bookTripService.test.js.
process.env.COLABERRY_ACCOUNTING_API_TOKEN = "test-token-not-a-secret";

const assert = require("assert");

const { bookGroupTrip, getGroupBooking, STATUSES } = require("./groupBookingService");
const { getLoggedTransactions } = require("./crmTransactionLog");
const { getCustomerRecord } = require("../crm/customerRecord");
const { getLedger } = require("../accounting/accountingClient");
const { getAuditEntries, findAuditEntry, deriveAuditKey } = require("../audit/auditLog");

// The single-trip price of the shared itinerary used throughout: FL-100
// (128000) + HT-200 (76000) + SF-300 (245000). Written out rather than
// imported so that a change to the stand-in inventory fails this test loudly
// instead of silently agreeing with itself.
const PER_PERSON_CENTS = 128000 + 76000 + 245000;

function groupRequest(overrides) {
  return Object.assign(
    {
      organizerId: "ORG-1",
      groupName: "Kenya 2026",
      itinerary: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
      members: [
        { memberId: "TRV-1", fullName: "Ada Lovelace" },
        { memberId: "TRV-2", fullName: "Grace Hopper" },
        { memberId: "TRV-3", fullName: "Katherine Johnson" },
      ],
      idempotencyKey: "group-key-0001",
    },
    overrides || {}
  );
}

// A store that accepts every write and keeps none of them. This is the
// "booking confirmation failure" path in its dangerous form: `set` returns
// perfectly well and the row is simply not there afterwards.
function lostWriteStore() {
  return {
    get: function () {
      return undefined;
    },
    set: function () {
      return this;
    },
    delete: function () {
      return false;
    },
    has: function () {
      return false;
    },
    keys: function () {
      return [].values();
    },
    values: function () {
      return [].values();
    },
    flush: function () {},
    size: 0,
  };
}

// A real, working store that is not the module's own - so a test can inspect
// exactly what was written and what was rolled back.
function inspectableStore() {
  const rows = new Map();
  return {
    rows: rows,
    get: rows.get.bind(rows),
    set: function (key, value) {
      rows.set(key, value);
      return this;
    },
    delete: rows.delete.bind(rows),
    has: rows.has.bind(rows),
    keys: rows.keys.bind(rows),
    values: rows.values.bind(rows),
    flush: function () {},
    get size() {
      return rows.size;
    },
  };
}

function auditEventsFor(resource) {
  return getAuditEntries()
    .filter(function (entry) {
      return entry.resource === resource;
    })
    .map(function (entry) {
      return entry.event;
    });
}

async function main() {
  // ================================================== CRITERION 1: confirmed

  const confirmed = await bookGroupTrip(groupRequest());

  assert.strictEqual(confirmed.status, STATUSES.CONFIRMED);
  assert.strictEqual(confirmed.replayed, false);
  assert.strictEqual(confirmed.organizerId, "ORG-1");
  assert.strictEqual(confirmed.groupName, "Kenya 2026");
  assert.ok(confirmed.groupId.startsWith("group_"));

  // ALL MEMBERS, not some. This is the criterion stated as an assertion: the
  // response carries one confirmed entry per traveller submitted, each with
  // its own booking reference.
  assert.strictEqual(confirmed.memberCount, 3);
  assert.strictEqual(confirmed.members.length, 3);
  assert.deepStrictEqual(
    confirmed.members.map(function (member) {
      return member.memberId;
    }),
    ["TRV-1", "TRV-2", "TRV-3"]
  );
  assert.ok(
    confirmed.members.every(function (member) {
      return member.status === "confirmed";
    }),
    "every member must be confirmed, not merely present"
  );
  assert.strictEqual(new Set(confirmed.members.map(function (m) { return m.tripId; })).size, 3);

  console.log("groupBookingService: CRITERION 1 - a complete group confirms for all members");

  // THE SHARED ITINERARY. One itinerary on the group, which is REQ-010's
  // "shared itinerary information". There is no per-member copy to diverge:
  // the members carry a booking reference and a name, and nothing else that
  // could contradict the group's own legs.
  assert.deepStrictEqual(confirmed.itinerary, {
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
  });
  assert.ok(
    confirmed.members.every(function (member) {
      return member.itinerary === undefined;
    }),
    "a member must not carry their own copy of the itinerary"
  );

  console.log("groupBookingService: the itinerary is shared, with no per-member copy");

  // Priced as the single-trip price times the head count, charged once.
  assert.strictEqual(confirmed.perPersonCents, PER_PERSON_CENTS);
  assert.strictEqual(confirmed.totalCents, PER_PERSON_CENTS * 3);
  assert.strictEqual(confirmed.currency, "USD");

  console.log("groupBookingService: the group is priced per person and charged once");

  // ================================================ CRITERION 3: logged

  // (a) THE AUDIT TRAIL. One confirmed event for the group, attributed to the
  // organizer, carrying the ids of everyone on it.
  const confirmedEntry = findAuditEntry(
    deriveAuditKey(confirmed.groupId, "group_booking.confirmed")
  );
  assert.ok(confirmedEntry, "a confirmed group must be in the audit trail");
  assert.strictEqual(confirmedEntry.event, "group_booking.confirmed");
  assert.strictEqual(confirmedEntry.outcome, "success");
  assert.strictEqual(confirmedEntry.actor, "ORG-1");
  assert.strictEqual(confirmedEntry.resource, confirmed.groupId);
  assert.strictEqual(confirmedEntry.context.memberCount, 3);
  assert.deepStrictEqual(confirmedEntry.context.memberIds, ["TRV-1", "TRV-2", "TRV-3"]);
  assert.strictEqual(confirmedEntry.context.totalCents, PER_PERSON_CENTS * 3);

  // Travellers are recorded by ID, never by name. The audit trail persists to
  // disk forever and does not need to be a passenger manifest.
  assert.ok(
    !JSON.stringify(confirmedEntry).includes("Ada Lovelace"),
    "the audit trail must not hold travellers' names"
  );

  console.log("groupBookingService: CRITERION 3 - the group booking is in the audit trail");

  // (b) THE BOOKING LOG. One row per member, so each traveller's own history
  // shows the trip they went on.
  const memberRows = getLoggedTransactions().filter(function (row) {
    return row.groupId === confirmed.groupId;
  });
  assert.strictEqual(memberRows.length, 3);
  assert.deepStrictEqual(
    memberRows
      .map(function (row) {
        return row.customerId;
      })
      .sort(),
    ["TRV-1", "TRV-2", "TRV-3"]
  );
  assert.ok(
    memberRows.every(function (row) {
      return row.status === "confirmed" && row.legs.flightId === "FL-100";
    }),
    "every member's row carries the confirmed status and the shared legs"
  );

  console.log("groupBookingService: CRITERION 3 - one booking-log row per member");

  // (c) THE BOOKS. ONE accounting entry for the group, against the organizer -
  // not one per traveller.
  const ledgerRows = getLedger().filter(function (row) {
    return row.transactionId === confirmed.groupId;
  });
  assert.strictEqual(ledgerRows.length, 1, "the group is one sale, not one per member");
  assert.strictEqual(ledgerRows[0].customerId, "ORG-1");
  assert.strictEqual(ledgerRows[0].amountCents, PER_PERSON_CENTS * 3);

  console.log("groupBookingService: CRITERION 3 - the group is one entry in the books");

  // (d) THE REGRESSION THAT MATTERS MOST HERE, and the reason the CRM row
  // carries a SHARE rather than the group total.
  //
  // crm/customerRecord.js sums amountCents across booking-log rows into a
  // lifetime value. Had each member's row carried the GROUP total, this
  // three-person safari would read as three full safaris sold - the group's
  // revenue multiplied by its size, on every sales dashboard that reads the
  // CRM. Each member is worth their own seat; the organizer's card carries the
  // whole charge, and that figure lives in the books above, not here.
  const traveller = getCustomerRecord({ customerId: "TRV-1" });
  assert.strictEqual(traveller.status, "ok");
  assert.strictEqual(traveller.customer.bookingCount, 1);
  assert.strictEqual(
    traveller.customer.lifetimeValueCents,
    PER_PERSON_CENTS,
    "a member's lifetime value is their own share, never the group total"
  );

  console.log("groupBookingService: a member's CRM value is their share, not the group total");

  // Scoped read: a stranger gets the same answer as for a group that does not
  // exist, so walking ids cannot map out the book.
  assert.ok(getGroupBooking({ groupId: confirmed.groupId, organizerId: "ORG-1" }));
  assert.strictEqual(getGroupBooking({ groupId: confirmed.groupId, organizerId: "ORG-OTHER" }), null);
  assert.strictEqual(getGroupBooking({ groupId: "group_nope", organizerId: "ORG-1" }), null);

  console.log("groupBookingService: a group read is scoped to its organizer");

  // ================================================== idempotency

  // A RETRY IS NOT A SECOND GROUP. The sharper version of the single-booking
  // rule: a retried group booking would charge five fares, not one.
  const ledgerBefore = getLedger().length;
  const replay = await bookGroupTrip(groupRequest());

  assert.strictEqual(replay.status, STATUSES.CONFIRMED);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.groupId, confirmed.groupId);
  assert.strictEqual(replay.totalCents, confirmed.totalCents);
  assert.strictEqual(
    getLoggedTransactions().filter(function (row) {
      return row.groupId === confirmed.groupId;
    }).length,
    3,
    "a replay must not add a second set of member rows"
  );
  assert.strictEqual(getLedger().length, ledgerBefore, "a replay must not post a second sale");

  console.log("groupBookingService: a retry replays the same group, with no second charge");

  // The same key for a DIFFERENT group is a conflict, not someone else's
  // booking handed back.
  const conflict = await bookGroupTrip(
    groupRequest({
      members: [
        { memberId: "TRV-8", fullName: "Someone Else" },
        { memberId: "TRV-9", fullName: "Another Person" },
      ],
    })
  );
  assert.strictEqual(conflict.status, STATUSES.IDEMPOTENCY_CONFLICT);

  console.log("groupBookingService: reusing a key for a different group is refused");

  // Member ORDER is not part of the group's identity. A client that does not
  // preserve list order must still be able to retry.
  const reordered = await bookGroupTrip(
    groupRequest({
      members: [
        { memberId: "TRV-3", fullName: "Katherine Johnson" },
        { memberId: "TRV-1", fullName: "Ada Lovelace" },
        { memberId: "TRV-2", fullName: "Grace Hopper" },
      ],
    })
  );
  assert.strictEqual(reordered.status, STATUSES.CONFIRMED);
  assert.strictEqual(reordered.replayed, true);
  assert.strictEqual(reordered.groupId, confirmed.groupId);

  console.log("groupBookingService: the same travellers in a different order is the same group");

  // No key at all, or one too short to be safe.
  for (const badKey of [undefined, "", "short", 12345, "x".repeat(200)]) {
    const rejected = await bookGroupTrip(groupRequest({ idempotencyKey: badKey }));
    assert.strictEqual(rejected.status, STATUSES.INVALID_IDEMPOTENCY_KEY);
  }

  console.log("groupBookingService: a group cannot be booked without a usable idempotency key");

  // ============================ CRITERION 2 / FAILURE: incomplete details

  const incomplete = await bookGroupTrip({
    organizerId: "ORG-2",
    itinerary: { flightId: "FL-100" },
    members: [{ memberId: "TRV-4" }],
    idempotencyKey: "group-key-0002",
  });

  assert.strictEqual(incomplete.status, STATUSES.INCOMPLETE_GROUP);
  assert.ok(Array.isArray(incomplete.missing));
  // THE PROMPT, not merely the refusal. An organizer who submitted three bad
  // things is told about three, in one pass.
  assert.ok(incomplete.missing.length >= 3, "the prompt must list everything that is missing");
  assert.ok(
    incomplete.missing.some(function (problem) {
      return problem.includes("itinerary.hotelId");
    })
  );
  assert.ok(
    incomplete.missing.some(function (problem) {
      return problem.includes("at least 2");
    })
  );

  console.log("groupBookingService: CRITERION 2 - an incomplete group prompts for what is missing");

  // NOTHING HAPPENED. A refused group charges nobody, books nobody and leaves
  // no row behind.
  assert.strictEqual(
    getLoggedTransactions().filter(function (row) {
      return row.customerId === "TRV-4";
    }).length,
    0
  );
  assert.strictEqual(getCustomerRecord({ customerId: "TRV-4" }).status, "not_found");

  // But the REFUSAL IS AUDITED - criterion 3 says all group booking
  // transactions are logged, and a refusal is one of them.
  const refusalEntry = findAuditEntry(
    deriveAuditKey("group-key-0002", "group_booking.refused.incomplete_group")
  );
  assert.ok(refusalEntry, "an incomplete group must still be audited");
  assert.strictEqual(refusalEntry.outcome, "failure");
  assert.strictEqual(refusalEntry.context.reason, STATUSES.INCOMPLETE_GROUP);
  // The audit records that three things were wrong, not WHAT was submitted -
  // a rejected group carries travellers' details and the trail is forever.
  assert.strictEqual(typeof refusalEntry.context.problemCount, "number");

  console.log("groupBookingService: a refused group is audited without storing the submission");

  // ==================================================== FAILURE: payment

  const declined = await bookGroupTrip(
    groupRequest({ organizerId: "CUST-DECLINED", idempotencyKey: "group-key-0003" })
  );

  assert.strictEqual(declined.status, STATUSES.PAYMENT_FAILED);
  assert.strictEqual(declined.replayed, false);
  // Nobody is booked on a card that did not clear.
  assert.strictEqual(
    getLoggedTransactions().filter(function (row) {
      return row.organizerId === "CUST-DECLINED";
    }).length,
    0
  );

  // AUDITED, AND DELIBERATELY NOT POSTED. A failed transaction is still a
  // transaction, so it is in the trail; it is not in the books, because the
  // money never moved. That is the split transactionRecorder.js exists for.
  const declinedGroupId = getAuditEntries()
    .filter(function (entry) {
      return entry.correlationId === "group-key-0003";
    })
    .map(function (entry) {
      return entry.resource;
    })[0];
  assert.ok(declinedGroupId, "a declined group booking must be audited");
  assert.strictEqual(
    getLedger().filter(function (row) {
      return row.transactionId === declinedGroupId;
    }).length,
    0,
    "a declined group must never reach the accounting software"
  );

  console.log("groupBookingService: FAILURE - a declined card is audited and never posted");

  // THE KEY IS NOT WEDGED. A declined card is retryable: the organizer fixes
  // payment and resubmits. Had the failure been stored against the key, that
  // key would be permanently unusable and the group could never be booked.
  const afterFixingPayment = await bookGroupTrip(
    groupRequest({ organizerId: "ORG-3", idempotencyKey: "group-key-0003" })
  );
  assert.strictEqual(afterFixingPayment.status, STATUSES.CONFIRMED);
  assert.strictEqual(afterFixingPayment.memberCount, 3);

  console.log("groupBookingService: a declined payment leaves the key usable for a retry");

  // ================================================ FAILURE: unavailable

  const unavailable = await bookGroupTrip(
    groupRequest({
      itinerary: { flightId: "FL-999", hotelId: "HT-200", safariId: "SF-300" },
      idempotencyKey: "group-key-0004",
    })
  );

  assert.strictEqual(unavailable.status, STATUSES.UNAVAILABLE);
  // Handed to a human. advisorRouting.js calls this the strongest case in the
  // system: a known customer actively trying to give us money, and an advisor
  // can find the other lodge.
  assert.ok(unavailable.advisor, "an unavailable group must reach an advisor");
  assert.strictEqual(unavailable.advisor.routed, true);

  console.log("groupBookingService: FAILURE - an unavailable leg is routed to an advisor");

  // ================================ FAILURE: booking confirmation failure

  // The dangerous, silent version: the store accepts the write and loses it.
  // Without the read-back in the write guard the organizer would be told eight
  // travellers are booked and the row would not be there.
  const notConfirmed = await bookGroupTrip(groupRequest({ idempotencyKey: "group-key-0005" }), {
    store: lostWriteStore(),
  });

  assert.strictEqual(notConfirmed.status, STATUSES.NOT_CONFIRMED);
  assert.ok(notConfirmed.message.includes("No member was booked"));
  // The message says nothing about WHICH component failed - that is not the
  // caller's business and not actionable by them.
  assert.ok(!notConfirmed.message.toLowerCase().includes("store"));

  console.log("groupBookingService: FAILURE - a write that does not persist confirms nobody");

  // A store that throws outright, rather than losing the write quietly.
  const throwingStore = Object.assign(inspectableStore(), {
    set: function () {
      throw Object.assign(new Error("disk full"), { errorClass: "UpstreamUnavailable" });
    },
  });
  const storeThrew = await bookGroupTrip(groupRequest({ idempotencyKey: "group-key-0006" }), {
    store: throwingStore,
  });
  assert.strictEqual(storeThrew.status, STATUSES.NOT_CONFIRMED);

  console.log("groupBookingService: FAILURE - a store that throws is a refusal, not a crash");

  // AN UNAUDITED GROUP MUST NOT EXIST. If the audit fails after the write, the
  // write is undone - otherwise there is a confirmed group trip with no record
  // of who arranged it or who is on it, which is the state the project's audit
  // guardrail exists to make impossible.
  const rollbackStore = inspectableStore();
  const unauditable = await bookGroupTrip(groupRequest({ idempotencyKey: "group-key-0007" }), {
    store: rollbackStore,
    audit: function () {
      throw Object.assign(new Error("audit log unavailable"), {
        errorClass: "UpstreamUnavailable",
      });
    },
  });

  assert.strictEqual(unauditable.status, STATUSES.NOT_CONFIRMED);
  assert.strictEqual(rollbackStore.size, 0, "an unauditable group must be rolled back, not kept");

  console.log("groupBookingService: FAILURE - an audit failure rolls the group back to nothing");

  // And the rollback is real rather than reported: booking again with that key
  // on a working audit produces a fresh confirmed group, which could not
  // happen if a half-written row were still sitting there.
  const afterRollback = await bookGroupTrip(groupRequest({ idempotencyKey: "group-key-0007" }), {
    store: rollbackStore,
  });
  assert.strictEqual(afterRollback.status, STATUSES.CONFIRMED);
  assert.strictEqual(afterRollback.replayed, false);
  assert.strictEqual(rollbackStore.size, 1);

  console.log("groupBookingService: a rolled-back group can be booked again cleanly");

  // ============================================== the trail, end to end

  // Every distinct outcome above left a trace. This is criterion 3 read as a
  // whole rather than one event at a time: confirmations AND refusals.
  const events = getAuditEntries().map(function (entry) {
    return entry.event;
  });
  assert.ok(events.includes("group_booking.confirmed"));
  assert.ok(events.includes("group_booking.refused"));
  assert.ok(events.includes("transaction.processed"));

  const confirmedGroupEvents = auditEventsFor(confirmed.groupId);
  assert.ok(confirmedGroupEvents.includes("group_booking.confirmed"));

  console.log("groupBookingService: CRITERION 3 - confirmations and refusals are both on record");

  console.log("groupBookingService: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
