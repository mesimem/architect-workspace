// STORY-011: payments, tested over real HTTP.
//
// customerPaymentService.test.js proves the DECISIONS (including the injected
// processor failures - timeout, charged-but-not-recorded). This suite proves
// the WIRING: that each route enforces the permission it declares, that a
// customer can only ever reach their own account, that each outcome reaches the
// client as the right status, and that the audit entries are readable through
// the admin API rather than only in a unit test.
//
// The real mock processor declines customer "CUST-DECLINED", which is how a
// payment failure is produced end to end here with no injection.
//
// The tokens are test fixtures. They exist only in this process.

process.env.COLABERRY_ACCOUNTING_API_TOKEN = "test-token-not-a-secret";

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");

const FINANCE_TOKEN = "test-finance-token-payments";
const CUSTOMER_TOKEN = "test-customer-token-payments";
const OTHER_CUSTOMER_TOKEN = "test-other-customer-token-payments";
const DECLINED_TOKEN = "test-declined-token-payments";
const ADVISOR_TOKEN = "test-advisor-token-payments";
const ADMIN_TOKEN = "test-admin-token-payments";

const TOKENS = [
  FINANCE_TOKEN + ":finance:FIN-PAY-1",
  CUSTOMER_TOKEN + ":customer:CUST-PAY-1",
  OTHER_CUSTOMER_TOKEN + ":customer:CUST-PAY-2",
  DECLINED_TOKEN + ":customer:CUST-DECLINED",
  ADVISOR_TOKEN + ":advisor:ADV-PAY-1",
  ADMIN_TOKEN + ":admin:ADMIN-PAY-1",
].join(",");

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();

  const server = createServer({ principals: loadPrincipals(TOKENS), credentials: new Map() });
  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;

  async function call(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (options.token) headers.Authorization = "Bearer " + options.token;
    const res = await fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : JSON.parse(text) };
  }

  function openAccount(customerId, tripRef, totalCents, token = FINANCE_TOKEN) {
    return call("/api/finance/payment-accounts", {
      method: "POST",
      token: token,
      body: { customerId: customerId, tripRef: tripRef, totalCents: totalCents },
    });
  }

  function pay(accountId, paymentId, amountCents, token = CUSTOMER_TOKEN) {
    return call("/api/portal/payments/" + accountId, {
      method: "POST",
      token: token,
      body: { paymentId: paymentId, amountCents: amountCents },
    });
  }

  async function auditEntries() {
    const res = await call("/api/admin/audit", { token: ADMIN_TOKEN });
    assert.strictEqual(res.status, 200);
    return res.body.entries;
  }

  // The original console.error is kept so a failure is still printed; the
  // services' structured logs are quietened to keep the output readable.
  const originalError = console.error;
  console.error = function () {};

  try {
    // Finance opens a $5,000.00 account for CUST-PAY-1.
    const opened = await openAccount("CUST-PAY-1", "TRIP-KENYA-1", 500000);
    assert.strictEqual(opened.status, 201);
    const accountId = opened.body.account.accountId;
    assert.strictEqual(opened.body.account.openedBy, "FIN-PAY-1"); // from the principal
    assert.strictEqual((await openAccount("CUST-PAY-1", "TRIP-KENYA-1", 500000)).status, 200);
    assert.strictEqual((await openAccount("CUST-PAY-1", "TRIP-KENYA-1", 1)).status, 409);
    assert.strictEqual((await openAccount("CUST-PAY-1", "TRIP-X", 10.5)).status, 400);
    assert.strictEqual(
      (await call("/api/finance/payment-accounts", { method: "POST", token: FINANCE_TOKEN, body: [1] })).status,
      400
    );
    originalError("payments http: finance opens an account, idempotently");

    // ================================================= ACCEPTANCE CRITERION 1
    // "Given a payment is made, when processed, then the system updates the
    // balance." Proven by READING the balance back, not by the POST echoing it.
    const paid = await pay(accountId, "PAY-HTTP-1", 150000);
    assert.strictEqual(paid.status, 201);
    assert.strictEqual(paid.body.balanceCents, 350000);
    const mine = await call("/api/portal/payments", { token: CUSTOMER_TOKEN });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.count, 1);
    assert.strictEqual(mine.body.accounts[0].balanceCents, 350000);
    assert.strictEqual(mine.body.accounts[0].paidCents, 150000);
    assert.strictEqual(mine.body.accounts[0].openedBy, undefined); // no staff ids
    const financeView = await call("/api/finance/payment-accounts/" + accountId, { token: FINANCE_TOKEN });
    assert.strictEqual(financeView.body.account.balanceCents, 350000);

    // A retried request with the same paymentId: 200, nothing charged twice.
    const replay = await pay(accountId, "PAY-HTTP-1", 150000);
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body.status, "already_paid");
    assert.strictEqual(replay.body.balanceCents, 350000);
    originalError("payments http: AC1 - a processed payment updates the balance");

    // ================================================= ACCEPTANCE CRITERION 2
    // "Given a payment fails, when retried, then the system processes it again
    // or shows an error." The mock processor declines CUST-DECLINED.
    const declinedOpen = await openAccount("CUST-DECLINED", "TRIP-TZ-1", 200000);
    const declinedAccount = declinedOpen.body.account.accountId;
    const firstTry = await pay(declinedAccount, "PAY-HTTP-D", 50000, DECLINED_TOKEN);
    assert.strictEqual(firstTry.status, 402);
    assert.strictEqual(firstTry.body.error, "payment_failed");
    assert.strictEqual(firstTry.body.retryable, true);
    assert.ok(firstTry.body.message.length > 0);
    assert.strictEqual(firstTry.body.balanceCents, 200000);
    const retry = await pay(declinedAccount, "PAY-HTTP-D", 50000, DECLINED_TOKEN);
    assert.strictEqual(retry.status, 402, "the retry is processed again and shows an error");
    const declinedMine = await call("/api/portal/payments", { token: DECLINED_TOKEN });
    assert.strictEqual(declinedMine.body.accounts[0].balanceCents, 200000);
    // The processed-again-and-succeeds half is proven in customerPaymentService.test.js
    // with an injected processor; the mock declines this customer every time.
    originalError("payments http: AC2 - a failed payment, retried, shows an error and leaves the balance");

    // ================================================= TRUST CRITERION
    // "The system logs all payment transactions." Read through the admin API.
    const entries = await auditEntries();
    const processed = entries.filter(function (e) {
      return e.event === "transaction.processed";
    });
    assert.strictEqual(processed.filter((e) => e.outcome === "success" && e.actor === "CUST-PAY-1").length, 1);
    assert.strictEqual(processed.filter((e) => e.outcome === "failure" && e.actor === "CUST-DECLINED").length, 2);
    assert.ok(entries.some((e) => e.event === "payments.account.opened" && e.resource === accountId));
    assert.ok(entries.some((e) => e.event === "accounting.post" && e.outcome === "success"));
    originalError("payments http: TRUST - every payment attempt and account opening is in the audit trail");

    // ================================================= AUTHORIZATION
    // Someone else's account is "not found" - and nothing is charged.
    const intruder = await pay(accountId, "PAY-HTTP-X", 100, OTHER_CUSTOMER_TOKEN);
    assert.strictEqual(intruder.status, 404);
    assert.strictEqual((await call("/api/portal/payments", { token: OTHER_CUSTOMER_TOKEN })).body.count, 0);
    // No token: 401.
    assert.strictEqual((await call("/api/portal/payments")).status, 401);
    assert.strictEqual((await pay(accountId, "PAY-HTTP-Y", 100, null)).status, 401);
    // Wrong role: 403 on every route.
    assert.strictEqual((await openAccount("CUST-PAY-1", "TRIP-Z", 100, CUSTOMER_TOKEN)).status, 403);
    assert.strictEqual((await call("/api/finance/payment-accounts/" + accountId, { token: CUSTOMER_TOKEN })).status, 403);
    assert.strictEqual((await openAccount("CUST-PAY-1", "TRIP-Z", 100, ADMIN_TOKEN)).status, 403);
    assert.strictEqual((await openAccount("CUST-PAY-1", "TRIP-Z", 100, ADVISOR_TOKEN)).status, 403);
    assert.strictEqual((await pay(accountId, "PAY-HTTP-Z", 100, FINANCE_TOKEN)).status, 403);
    assert.strictEqual((await call("/api/portal/payments", { token: FINANCE_TOKEN })).status, 403);
    // The balance is exactly where AC1 left it.
    assert.strictEqual((await call("/api/portal/payments", { token: CUSTOMER_TOKEN })).body.accounts[0].balanceCents, 350000);
    originalError("payments http: only the owner pays, only finance opens, everyone else is refused");

    // ================================================= INPUT
    assert.strictEqual((await pay(accountId, "PAY-HTTP-O", 350001)).status, 400); // over balance
    assert.strictEqual((await pay(accountId, "PAY-HTTP-F", 1.5)).status, 400);
    assert.strictEqual((await pay(accountId, "bad id!", 100)).status, 400);
    assert.strictEqual((await pay(accountId, "PAY-HTTP-1", 999)).status, 409); // id reused, new amount
    assert.strictEqual((await pay("PA-NOPE-NOPE", "PAY-HTTP-N", 100)).status, 404);
    assert.strictEqual(
      (await call("/api/portal/payments/" + accountId, { method: "POST", token: CUSTOMER_TOKEN, body: "x" })).status,
      400
    );
    originalError("payments http: malformed, over-balance and reused payments are refused");

    originalError("payments http: all tests passed");
  } finally {
    console.error = originalError;
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
