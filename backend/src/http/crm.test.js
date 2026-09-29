// STORY-014: the CRM, tested over real HTTP.
//
// The service suites prove the DECISIONS - leadStore.test.js that a lead is
// validated, deduped and audited, customerRecord.test.js that a completed
// booking becomes booking history. This suite proves the WIRING, which is
// where an access-control bug actually lives: that the permission each route
// DECLARES is the one enforced, that no other role can reach the lead book
// however it presents itself, and that the audit entry a change writes is
// really readable afterwards through the API rather than only in a unit test.
//
// All three acceptance criteria are marked below, as is each of the story's
// three named failure paths. "Unauthorized data access" is tested here and
// only here, because it is a property of the boundary, not of the services.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { hashPassword } = require("../services/portal/portalCredentials");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { __resetLeadsForTests } = require("../services/crm/leadStore");
const { bookTrip } = require("../services/booking/bookTripService");

const SALES_TOKEN = "test-sales-token-crm";
const CUSTOMER_TOKEN = "test-customer-token-crm";
const ADVISOR_TOKEN = "test-advisor-token-crm";
const ADMIN_TOKEN = "test-admin-token-crm";

const SALES_USER = "SALES-CRM-1";
const CUSTOMER_USER = "CUST-CRM-USER";

const TOKENS = [
  SALES_TOKEN + ":sales:" + SALES_USER,
  CUSTOMER_TOKEN + ":customer:" + CUSTOMER_USER,
  ADVISOR_TOKEN + ":advisor:ADV-CRM-1",
  ADMIN_TOKEN + ":admin:ADMIN-CRM-1",
].join(",");

const SESSION_CUSTOMER = "CUST-CRM-SESSION";
const PASSWORD = "kilimanjaro-sunrise-2026";

// The customer whose booking history the CRM reads. Booked through the real
// booking service below, not seeded.
const BOOKED_CUSTOMER = "CUST-CRM-HTTP-1";
const TRIP = { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" };
const TRIP_TOTAL_CENTS = 128000 + 76000 + 245000;

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  __resetLeadsForTests();
  clearFailureTracking();

  const credentials = new Map([[SESSION_CUSTOMER, await hashPassword(PASSWORD)]]);

  const server = createServer({
    principals: loadPrincipals(TOKENS),
    credentials: credentials,
  });
  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;

  function call(path, options = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (options.token) {
      headers.Authorization = "Bearer " + options.token;
    }
    if (options.correlationId) {
      headers["X-Correlation-ID"] = options.correlationId;
    }
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  // The audit trail as an admin can actually read it. Criterion 3 is about an
  // entry EXISTING, and reading it back through the API is a stronger proof
  // than reading the module's own store.
  async function auditEntries() {
    const res = await call("/api/admin/audit", { token: ADMIN_TOKEN });
    assert.strictEqual(res.status, 200);
    return (await res.json()).entries;
  }

  function findEntry(entries, event, resource) {
    return (
      entries.find(function (entry) {
        return entry.event === event && entry.resource === resource;
      }) || null
    );
  }

  try {
    // ================================================= ACCEPTANCE CRITERION 1
    // "Given a new lead, when it is added to the CRM, then it should be
    // visible in the lead list."
    const createRes = await call("/api/crm/leads", {
      method: "POST",
      token: SALES_TOKEN,
      body: {
        fullName: "Ada Mensah",
        email: "ada@example.com",
        source: "web",
        notes: "Asked about a 10-day Tanzania safari in June.",
      },
    });
    assert.strictEqual(createRes.status, 201, "a new lead is created, so 201");
    const created = await createRes.json();
    assert.strictEqual(created.replayed, false);
    assert.strictEqual(created.lead.status, "new");
    // Captured by the RESOLVED principal, not by anything in the body.
    assert.strictEqual(created.lead.createdBy, SALES_USER);

    const listRes = await call("/api/crm/leads", { token: SALES_TOKEN });
    assert.strictEqual(listRes.status, 200);
    const listed = await listRes.json();
    assert.strictEqual(listed.count, 1);
    assert.strictEqual(listed.leads[0].leadId, created.lead.leadId);
    assert.strictEqual(listed.leads[0].email, "ada@example.com");
    // The pickers' vocabulary ships with the list, so a client needs no copy.
    assert.ok(listed.sources.includes("web"));
    assert.ok(listed.statuses.includes("qualified"));
    console.log("crm http: a lead posted to the CRM is visible in the lead list");

    // ================================================= ACCEPTANCE CRITERION 3
    // "Given any CRM entry, when it is modified, then an audit log entry must
    // be created." Read back through GET /api/admin/audit.
    const afterCreate = await auditEntries();
    const createEntry = findEntry(afterCreate, "crm.lead.created", created.lead.leadId);
    assert.ok(createEntry, "capturing a lead over HTTP must write a readable audit entry");
    assert.strictEqual(createEntry.outcome, "success");
    assert.strictEqual(createEntry.actor, SALES_USER);
    console.log("crm http: the capture is in the audit trail, readable through the API");

    // A modification, with a correlationId we choose so the entry is findable.
    const editCorrelation = "crm-http-edit-0001";
    const patchRes = await call("/api/crm/leads/" + created.lead.leadId, {
      method: "PATCH",
      token: SALES_TOKEN,
      correlationId: editCorrelation,
      body: { status: "contacted" },
    });
    assert.strictEqual(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.deepStrictEqual(patched.changed, ["status"]);
    assert.strictEqual(patched.unchanged, false);
    assert.strictEqual(patched.lead.status, "contacted");

    const afterEdit = await auditEntries();
    const editEntry = findEntry(afterEdit, "crm.lead.updated", created.lead.leadId);
    assert.ok(editEntry, "modifying a lead must write an audit entry");
    assert.strictEqual(editEntry.correlationId, editCorrelation);
    assert.deepStrictEqual(editEntry.context.fields, ["status"]);
    assert.deepStrictEqual(editEntry.context.before, { status: "new" });
    assert.deepStrictEqual(editEntry.context.after, { status: "contacted" });
    console.log("crm http: a modification is audited with its before and after");

    // ================================================= ACCEPTANCE CRITERION 2
    // "Given a customer booking, when it is completed, then it should update
    // the customer's booking history." The booking goes through the real
    // booking service; the CRM reads it back over HTTP.
    const emptyRes = await call("/api/crm/customers/" + BOOKED_CUSTOMER, { token: SALES_TOKEN });
    assert.strictEqual(emptyRes.status, 404, "before booking, there is no such customer");

    const booking = await bookTrip({
      customerId: BOOKED_CUSTOMER,
      ...TRIP,
      idempotencyKey: "crm-http-first-booking",
    });
    assert.strictEqual(booking.status, "confirmed");

    const recordRes = await call("/api/crm/customers/" + BOOKED_CUSTOMER, { token: SALES_TOKEN });
    assert.strictEqual(recordRes.status, 200);
    const record = await recordRes.json();
    assert.strictEqual(record.bookings.length, 1);
    assert.strictEqual(record.bookings[0].tripId, booking.tripId);
    assert.strictEqual(record.bookings[0].amountCents, TRIP_TOTAL_CENTS);
    assert.strictEqual(record.customer.bookingCount, 1);
    assert.strictEqual(record.customer.lifetimeValueCents, TRIP_TOTAL_CENTS);

    const rosterRes = await call("/api/crm/customers", { token: SALES_TOKEN });
    assert.strictEqual(rosterRes.status, 200);
    const roster = await rosterRes.json();
    assert.ok(
      roster.customers.some(function (customer) {
        return customer.customerId === BOOKED_CUSTOMER;
      }),
      "a customer appears on the roster as soon as their booking confirms"
    );
    console.log("crm http: a completed booking is visible as that customer's booking history");

    // ====================================== FAILURE PATH: lead duplication
    const duplicateRes = await call("/api/crm/leads", {
      method: "POST",
      token: SALES_TOKEN,
      body: {
        fullName: "Ada Mensah (again)",
        email: "ADA@example.com ", // the same person, spelled differently
        source: "web",
      },
    });
    assert.strictEqual(duplicateRes.status, 200, "a replay is 200, not 201 - nothing was created");
    const duplicate = await duplicateRes.json();
    assert.strictEqual(duplicate.replayed, true);
    assert.strictEqual(duplicate.lead.leadId, created.lead.leadId);
    assert.strictEqual(duplicate.lead.fullName, "Ada Mensah", "the first row wins");
    assert.strictEqual((await (await call("/api/crm/leads", { token: SALES_TOKEN })).json()).count, 1);
    console.log("crm http: a duplicate capture returns the original lead and adds no row");

    // ====================================== FAILURE PATH: data entry error
    // A body that is not an object never reached a decision, so it is refused
    // at the envelope.
    for (const body of [[], "a string", 42]) {
      const res = await call("/api/crm/leads", { method: "POST", token: SALES_TOKEN, body: body });
      assert.strictEqual(res.status, 400, JSON.stringify(body) + " is not a lead");
      assert.strictEqual((await res.json()).error, "invalid_request_body");
    }

    // A malformed FIELD did reach a decision, so the service refuses it and
    // the refusal is audited - see the note at the top of crmRoutes.js.
    const badRes = await call("/api/crm/leads", {
      method: "POST",
      token: SALES_TOKEN,
      correlationId: "crm-http-badlead-001",
      body: { fullName: "   ", email: "not-an-email", source: "carrier-pigeon" },
    });
    assert.strictEqual(badRes.status, 400);
    const bad = await badRes.json();
    assert.strictEqual(bad.error, "invalid_lead");
    assert.strictEqual(bad.problems.length, 3, "every problem at once, not just the first");
    assert.ok(
      (await auditEntries()).some(function (entry) {
        return entry.event === "crm.lead.refused" && entry.correlationId === "crm-http-badlead-001";
      }),
      "a refused capture must be in the audit trail, not silently dropped"
    );
    assert.strictEqual((await (await call("/api/crm/leads", { token: SALES_TOKEN })).json()).count, 1);
    console.log("crm http: a malformed lead is refused, audited, and not written");

    // Edit-side refusals, each with its own status.
    const unknownRes = await call("/api/crm/leads/lead_nope", {
      method: "PATCH",
      token: SALES_TOKEN,
      body: { status: "lost" },
    });
    assert.strictEqual(unknownRes.status, 404);
    assert.strictEqual((await unknownRes.json()).error, "unknown_lead");

    const tamperRes = await call("/api/crm/leads/" + created.lead.leadId, {
      method: "PATCH",
      token: SALES_TOKEN,
      body: { createdBy: "someone-else" },
    });
    assert.strictEqual(tamperRes.status, 400);
    assert.strictEqual((await tamperRes.json()).error, "unknown_fields");

    const emptyPatchRes = await call("/api/crm/leads/" + created.lead.leadId, {
      method: "PATCH",
      token: SALES_TOKEN,
      body: {},
    });
    assert.strictEqual(emptyPatchRes.status, 400);
    assert.strictEqual((await emptyPatchRes.json()).error, "empty_update");

    // A percent-sequence that cannot be decoded is a 400, not a 500.
    const malformedIdRes = await call("/api/crm/leads/%E0%A4%A", {
      method: "PATCH",
      token: SALES_TOKEN,
      body: { status: "lost" },
    });
    assert.strictEqual(malformedIdRes.status, 400);
    assert.strictEqual((await malformedIdRes.json()).error, "invalid_lead_id");
    console.log("crm http: each edit refusal returns its own status, and a bad path id is a 400");

    // ================================ FAILURE PATH: unauthorized data access
    // Every CRM route, against every role that must not reach it. Passing one
    // route proves nothing about the others: each declares its own permission.
    const CRM_CALLS = [
      { method: "GET", path: "/api/crm/leads" },
      { method: "POST", path: "/api/crm/leads", body: { fullName: "X", email: "x@y.co", source: "web" } },
      { method: "PATCH", path: "/api/crm/leads/" + created.lead.leadId, body: { status: "lost" } },
      { method: "GET", path: "/api/crm/customers" },
      { method: "GET", path: "/api/crm/customers/" + BOOKED_CUSTOMER },
    ];

    for (const crmCall of CRM_CALLS) {
      // No credential at all is a 401 - we do not know who you are.
      const anonymous = await call(crmCall.path, { method: crmCall.method, body: crmCall.body });
      assert.strictEqual(anonymous.status, 401, "anonymous " + crmCall.method + " " + crmCall.path);

      // A known caller without the permission is a 403 - we know who you are
      // and the answer is still no. Admin is in this list deliberately: an
      // admin administers the system and does not get the customer book as a
      // perk of the job.
      for (const token of [CUSTOMER_TOKEN, ADVISOR_TOKEN, ADMIN_TOKEN]) {
        const res = await call(crmCall.path, {
          method: crmCall.method,
          token: token,
          body: crmCall.body,
        });
        assert.strictEqual(
          res.status,
          403,
          crmCall.method + " " + crmCall.path + " must be 403 for this role"
        );
      }
    }
    // And none of that leaked a row or wrote one.
    assert.strictEqual((await (await call("/api/crm/leads", { token: SALES_TOKEN })).json()).count, 1);
    console.log("crm http: no role but sales reaches any CRM route - 401 unknown, 403 known");

    // A refused attempt is on the record, so "who tried to read the lead book?"
    // is an answerable question.
    assert.ok(
      (await auditEntries()).some(function (entry) {
        return entry.event === "authz.access.denied";
      }),
      "a 403 must be audited"
    );
    console.log("crm http: a refused CRM request is audited as a denial");

    // No credential is ever in a CRM response body.
    const bodies = [
      JSON.stringify(await (await call("/api/crm/leads", { token: SALES_TOKEN })).json()),
      JSON.stringify(await (await call("/api/crm/customers", { token: SALES_TOKEN })).json()),
      JSON.stringify(
        await (await call("/api/crm/customers/" + BOOKED_CUSTOMER, { token: SALES_TOKEN })).json()
      ),
    ].join("");
    for (const secret of [SALES_TOKEN, CUSTOMER_TOKEN, ADVISOR_TOKEN, ADMIN_TOKEN, PASSWORD]) {
      assert.ok(!bodies.includes(secret), "a credential leaked into a CRM response");
    }
    console.log("crm http: no credential appears in any CRM response");

    // ============================================= the role model integrates
    // A role change takes effect on the CRM without a restart: the same
    // customer token that was 403 above reaches the lead book once an admin
    // grants it sales, and is 403 again when it is taken away. This is why the
    // routes name a permission rather than a role.
    //
    // Done LAST, because it changes a principal the assertions above rely on.
    const grant = await call("/api/admin/roles", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { userId: CUSTOMER_USER, role: "sales", reason: "STORY-014 wiring test" },
    });
    assert.ok(grant.status === 200 || grant.status === 201, "the grant must be accepted");
    assert.strictEqual((await call("/api/crm/leads", { token: CUSTOMER_TOKEN })).status, 200);

    const revoke = await call("/api/admin/roles", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { userId: CUSTOMER_USER, role: "customer", reason: "STORY-014 wiring test, undo" },
    });
    assert.ok(revoke.status === 200 || revoke.status === 201);
    assert.strictEqual((await call("/api/crm/leads", { token: CUSTOMER_TOKEN })).status, 403);
    console.log("crm http: granting and revoking sales opens and closes the CRM with no restart");

    console.log("crm http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetLeadsForTests();
    __resetAssignmentsForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
