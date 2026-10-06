// STORY-012 at the HTTP boundary: the dashboard endpoint, who may reach it,
// and the failure path "dashboard error".
//
// Access is tested through the REAL server, so the permission table and the
// route table are proved to agree. The two 503 cases call the route handler
// built with a failing source / audit store, because neither failure can be
// produced by booking trips properly.

process.env.COLABERRY_ACCOUNTING_API_TOKEN = "test-token-not-a-secret";

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { createAnalyticsRoutes } = require("./routes/analyticsRoutes");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { bookTrip } = require("../services/booking/bookTripService");
const { findAuditEntry } = require("../services/audit/auditLog");
const { AUDIT_EVENT } = require("../services/analytics/analyticsService");

const ADMIN_TOKEN = "test-admin-token-analytics";
const FINANCE_TOKEN = "test-finance-token-analytics";
const CUSTOMER_TOKEN = "test-customer-token-analytics";
const ADVISOR_TOKEN = "test-advisor-token-analytics";
const SALES_TOKEN = "test-sales-token-analytics";

const TOKENS = [
  ADMIN_TOKEN + ":admin:ADMIN-AN-1",
  FINANCE_TOKEN + ":finance:FIN-AN-1",
  CUSTOMER_TOKEN + ":customer:CUST-AN-1",
  ADVISOR_TOKEN + ":advisor:ADV-AN-1",
  SALES_TOKEN + ":sales:SALES-AN-1",
].join(",");

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();

  const booked = await bookTrip({
    customerId: "CUST-AN-1",
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
    idempotencyKey: "analytics-http-booking-0001",
  });
  assert.strictEqual(booked.status, "confirmed", JSON.stringify(booked));

  const server = createServer({ principals: loadPrincipals(TOKENS), credentials: new Map() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  async function get(token, correlationId) {
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    if (correlationId) headers["X-Correlation-ID"] = correlationId;
    const res = await fetch(base + "/api/analytics/revenue", { headers });
    return { status: res.status, body: await res.json() };
  }

  try {
    // AC1 over HTTP: admin and finance see revenue and booking trends.
    for (const token of [ADMIN_TOKEN, FINANCE_TOKEN]) {
      const res = await get(token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const { analytics } = res.body;
      assert.strictEqual(analytics.status, "complete");
      assert.strictEqual(analytics.totals.bookings, 1);
      assert.strictEqual(analytics.totals.revenueCents, booked.amountCents);
      assert.deepStrictEqual(analytics.trend, [
        { month: booked.bookedAt.slice(0, 7), bookings: 1, revenueCents: booked.amountCents },
      ]);
    }
    console.log("analytics http: admin and finance see the revenue trend");

    // AC3 over HTTP: the request's correlation id keys the audit entry.
    const traced = await get(FINANCE_TOKEN, "trace-analytics-0001");
    assert.strictEqual(traced.status, 200);
    const entry = findAuditEntry("analytics-revenue:trace-analytics-0001");
    assert.strictEqual(entry.event, AUDIT_EVENT);
    assert.strictEqual(entry.actor, "FIN-AN-1");
    console.log("analytics http: the dashboard request is audited under its correlation id");

    // Access control: everyone else is refused, and no token is a 401.
    for (const token of [CUSTOMER_TOKEN, ADVISOR_TOKEN, SALES_TOKEN]) {
      const res = await get(token);
      assert.strictEqual(res.status, 403, "expected 403 for " + token);
      assert.strictEqual(res.body.analytics, undefined);
    }
    const anonymous = await get(null);
    assert.strictEqual(anonymous.status, 401);
    assert.strictEqual(anonymous.body.analytics, undefined);
    console.log("analytics http: other roles get 403, no token gets 401");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Failure path "dashboard error": a clear 503, never empty figures.
  const context = { principal: { userId: "FIN-AN-1" }, correlationId: "corr-http-fail-0001" };
  const [unreadable] = createAnalyticsRoutes({
    readBookings: () => {
      throw new Error("disk unavailable");
    },
  });
  const sourceDown = await unreadable.handler(context);
  assert.strictEqual(sourceDown.status, 503);
  assert.strictEqual(sourceDown.body.error, "source_unavailable");
  assert.match(sourceDown.body.message, /could not be generated/);
  assert.strictEqual(sourceDown.body.analytics, undefined);

  const [unauditable] = createAnalyticsRoutes({
    recordAudit: () => {
      throw new Error("audit store full");
    },
  });
  const auditDown = await unauditable.handler(
    Object.assign({}, context, { correlationId: "corr-http-fail-0002" })
  );
  assert.strictEqual(auditDown.status, 503);
  assert.strictEqual(auditDown.body.error, "audit_unavailable");
  assert.strictEqual(auditDown.body.analytics, undefined);
  console.log("analytics http: a failed generation is a 503 with a message, not empty figures");

  console.log("analytics http: all tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
