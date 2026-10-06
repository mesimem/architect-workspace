// STORY-019 at the HTTP boundary, through the REAL server, real bookings and
// the real stores: a sales manager defines a segment, records contact
// preferences, sends a campaign, and sends it again.
process.env.COLABERRY_ACCOUNTING_API_TOKEN = "test-token-not-a-secret";
process.env.COLABERRY_MAIL_API_TOKEN = "test-mail-token-not-a-secret";

const assert = require("assert");
const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { bookTrip } = require("../services/booking/bookTripService");
const { findAuditEntry, getAuditEntries } = require("../services/audit/auditLog");
const { getOutbox } = require("../services/marketing/mailClient");

const SALES = "test-sales-token-marketing";
const OTHERS = {
  admin: "test-admin-token-marketing",
  advisor: "test-advisor-token-marketing",
  customer: "test-customer-token-marketing",
  manager: "test-manager-token-marketing",
  finance: "test-finance-token-marketing",
};
const TOKENS = [SALES + ":sales:SALES-MK-1"]
  .concat(Object.keys(OTHERS).map((role) => OTHERS[role] + ":" + role + ":" + role.toUpperCase() + "-MK-1"))
  .join(",");

async function book(customerId, key) {
  const booked = await bookTrip({ customerId, flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300", idempotencyKey: key });
  assert.strictEqual(booked.status, "confirmed", JSON.stringify(booked));
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  // Two repeat travellers and one single booking.
  await book("CUST-MK-REPEAT-A", "marketing-http-0001");
  await book("CUST-MK-REPEAT-A", "marketing-http-0002");
  await book("CUST-MK-REPEAT-B", "marketing-http-0003");
  await book("CUST-MK-REPEAT-B", "marketing-http-0004");
  await book("CUST-MK-ONCE", "marketing-http-0005");

  const server = createServer({ principals: loadPrincipals(TOKENS), credentials: new Map() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  async function call(method, path, token, body, correlationId) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (correlationId) headers["X-Correlation-ID"] = correlationId;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  try {
    // Access first, so a refusal cannot be an accident of ordering.
    for (const [method, path, body] of [
      ["GET", "/api/marketing/segments"],
      ["POST", "/api/marketing/segments", { name: "Anything" }],
      ["PUT", "/api/marketing/contacts/CUST-MK-ONCE", { optedOut: true }],
      ["POST", "/api/marketing/campaigns", { campaignId: "never-sent-0001", segmentId: "x", subject: "s", body: "b" }],
    ]) {
      assert.strictEqual((await call(method, path, null, body)).status, 401, method + " " + path + " anonymous");
      for (const role of Object.keys(OTHERS)) {
        assert.strictEqual((await call(method, path, OTHERS[role], body)).status, 403, role + " on " + method + " " + path);
      }
    }
    assert.strictEqual(getOutbox().length, 0, "no refused request sent anything");
    console.log("marketing http: anonymous callers get 401 and every role but sales gets 403");

    // AC1: a sales manager defines a segment and sees who matches it.
    const defined = await call("POST", "/api/marketing/segments", SALES, { name: "Repeat safari travellers", criteria: { minBookings: 2 } }, "corr-mk-segment-01");
    assert.strictEqual(defined.status, 201, JSON.stringify(defined.body));
    const members = defined.body.members.map((m) => m.customerId).sort();
    assert.deepStrictEqual(members, ["CUST-MK-REPEAT-A", "CUST-MK-REPEAT-B"]);
    assert.strictEqual(defined.body.members[0].bookingCount, 2);
    const segmentId = defined.body.segment.segmentId;
    const read = await call("GET", "/api/marketing/segments/" + segmentId, SALES);
    assert.deepStrictEqual(read.body.members.map((m) => m.customerId).sort(), members, "the segment reads back with the same members");
    assert.ok(findAuditEntry(segmentId + ":marketing.segment.defined.v1"), "defining a segment is audited");
    const replay = await call("POST", "/api/marketing/segments", SALES, { name: "Repeat safari travellers", criteria: { minBookings: 2 } });
    assert.strictEqual(replay.status, 200, "same name and rule is a replay");
    const clash = await call("POST", "/api/marketing/segments", SALES, { name: "Repeat safari travellers", criteria: { minBookings: 3 } });
    assert.strictEqual(clash.status, 409, "same name, different rule is refused");
    assert.strictEqual((await call("POST", "/api/marketing/segments", SALES, { name: "Typo", criteria: { minBooking: 2 } })).status, 400);
    assert.strictEqual((await call("GET", "/api/marketing/segments/SEG-NOPE", SALES)).status, 404);
    assert.strictEqual((await call("GET", "/api/marketing/segments/%E0%A4%A", SALES)).status, 400, "a malformed id is a 400, not a 500");
    console.log("marketing http: a sales manager defines a segment and sees who matches");

    // Contact preferences: A has an address, B has opted out.
    assert.strictEqual((await call("PUT", "/api/marketing/contacts/CUST-MK-REPEAT-A", SALES, { email: "A@Example.com" })).status, 200);
    const optOut = await call("PUT", "/api/marketing/contacts/CUST-MK-REPEAT-B", SALES, { email: "b@example.com", optedOut: true });
    assert.strictEqual(optOut.body.contact.optedOut, true);
    const newAddress = await call("PUT", "/api/marketing/contacts/CUST-MK-REPEAT-B", SALES, { email: "b2@example.com" });
    assert.strictEqual(newAddress.body.contact.optedOut, true, "a new address does not clear an opt-out");
    assert.strictEqual((await call("PUT", "/api/marketing/contacts/CUST-MK-REPEAT-A", SALES, { email: "a@example.com" })).body.changed, false, "the same change twice writes nothing");
    assert.strictEqual((await call("PUT", "/api/marketing/contacts/NOBODY-MK", SALES, { email: "x@example.com" })).status, 404, "only customers");
    assert.strictEqual((await call("PUT", "/api/marketing/contacts/CUST-MK-ONCE", SALES, { email: "not-an-address" })).status, 400);
    assert.strictEqual((await call("PUT", "/api/marketing/contacts/CUST-MK-ONCE", SALES, {})).status, 400);
    console.log("marketing http: contact preferences record addresses and opt-outs, and opt-out sticks");

    // Failure before sending: mail not configured sends nothing.
    const campaign = { campaignId: "repeat-safari-oct", segmentId: segmentId, subject: "New Mara lodges", body: "Your next safari is waiting." };
    const token = process.env.COLABERRY_MAIL_API_TOKEN;
    delete process.env.COLABERRY_MAIL_API_TOKEN;
    const off = await call("POST", "/api/marketing/campaigns", SALES, campaign, "corr-mk-campaign-00");
    process.env.COLABERRY_MAIL_API_TOKEN = token;
    assert.strictEqual(off.status, 503);
    assert.strictEqual(off.body.error, "mail_not_configured");
    assert.strictEqual(getOutbox().length, 0);
    console.log("marketing http: with mail unconfigured, the campaign is refused before anything is sent");

    // AC2: send - A is emailed, B is skipped as opted out, with the reason.
    const sent = await call("POST", "/api/marketing/campaigns", SALES, campaign, "corr-mk-campaign-01");
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.report.recipients, 2);
    assert.deepStrictEqual(sent.body.report.sent.map((s) => s.customerId), ["CUST-MK-REPEAT-A"]);
    assert.deepStrictEqual(sent.body.report.skipped.map((s) => [s.customerId, s.reason]), [["CUST-MK-REPEAT-B", "opted_out"]]);
    assert.deepStrictEqual(getOutbox().map((m) => m.to), ["a@example.com"], "only the consenting customer was emailed");
    console.log("marketing http: a campaign emails the segment and skips the opted-out customer, saying why");

    // AC3: the send is in the audit trail, readable as the trail records it.
    const entry = findAuditEntry("repeat-safari-oct:CUST-MK-REPEAT-A:sent");
    assert.ok(entry, "the send is audited");
    assert.strictEqual(entry.actor, "SALES-MK-1");
    assert.strictEqual(entry.correlationId, "corr-mk-campaign-01");
    assert.ok(findAuditEntry("repeat-safari-oct:CUST-MK-REPEAT-B:skipped.opted_out"), "the skip is audited");

    // AC3: re-sending never emails the same customer twice.
    const before = getAuditEntries().length;
    const again = await call("POST", "/api/marketing/campaigns", SALES, campaign, "corr-mk-campaign-02");
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.replayed, true);
    assert.strictEqual(again.body.report.sent.length, 0);
    assert.deepStrictEqual(again.body.report.skipped.map((s) => s.reason).sort(), ["already_sent", "opted_out"]);
    assert.strictEqual(getOutbox().length, 1, "still exactly one email");
    assert.ok(findAuditEntry("repeat-safari-oct:CUST-MK-REPEAT-A:skipped.already_sent"), "the refused repeat is audited");
    await call("POST", "/api/marketing/campaigns", SALES, campaign, "corr-mk-campaign-03");
    assert.strictEqual(getOutbox().length, 1, "a third send emails no one");
    assert.strictEqual(getAuditEntries().length, before + 1, "repeats of the same outcome add no further audit entries");
    console.log("marketing http: re-sending the campaign never emails the same customer twice, and is audited");

    const reused = await call("POST", "/api/marketing/campaigns", SALES, Object.assign({}, campaign, { subject: "Something else" }));
    assert.strictEqual(reused.status, 409, "a campaign id cannot be reused for different content");
    assert.strictEqual((await call("POST", "/api/marketing/campaigns", SALES, Object.assign({}, campaign, { segmentId: "SEG-NOPE", campaignId: "other-campaign-01" }))).status, 404);
    assert.strictEqual((await call("POST", "/api/marketing/campaigns", SALES, [])).status, 400);
    console.log("marketing http: reused ids, unknown segments and malformed bodies are refused");
    console.log("marketing http: all tests passed");
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
