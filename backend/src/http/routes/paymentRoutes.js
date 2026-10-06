// STORY-011: payment accounts and customer payments over HTTP.
//
// PLUMBING ONLY, same rule as supplierRoutes.js. What is payable, what is
// owed, when a retry is safe and what gets audited all live in
// ../../services/payments/; this file maps a request onto a service call and a
// result onto a status code.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES one and http/server.js
// enforces it before the handler runs, auditing every refusal. Customers hold
// portal.payments.*, finance holds payments.accounts.* (authz/permissions.js).
// What the table cannot express - "only YOUR account" - is enforced in the
// service, keyed on the resolved principal, never on anything in the body.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service status maps to an explicit
//     HTTP status via the tables below; an unmapped status is a 500, because
//     an unrecognised outcome is our bug and should read like one.
//  2. Will it retry? Nothing here retries. Both POSTs are safe for the CALLER
//     to retry: opening dedups on (customer, trip), paying on paymentId - and
//     the status code says whether it was new (201) or a replay (200).
//  3. Recovery path? 402/502 leave the balance untouched and say so; 503
//     (balance_not_updated) tells the customer to retry with the same
//     paymentId, which finishes the payment without charging again.
//  4. Handled: non-object bodies, malformed ids in the path, another
//     customer's account, every service refusal. NOT handled: pagination
//     (a customer has a handful of accounts), refunds, and staff paying on a
//     customer's behalf - deliberately absent, see the finance role.

const { PERMISSIONS } = require("../../services/authz/permissions");
const store = require("../../services/payments/paymentAccountStore");
const { makePayment } = require("../../services/payments/customerPaymentService");

// Account ids are "PA-" + two 1-64 character safe ids; the alphabet needs no
// percent-decoding, so a malformed path simply does not match the route.
const ACCOUNT_ID = "(PA-[A-Za-z0-9_-]{3,132})";

const OPEN_STATUS = Object.freeze({
  opened: 201,
  already_open: 200,
  invalid: 400,
  conflict: 409,
  write_failed: 503,
});

const PAYMENT_STATUS = Object.freeze({
  paid: 201,
  already_paid: 200,
  invalid: 400,
  // 402 Payment Required: the card was declined. Retryable by the customer.
  payment_failed: 402,
  not_found: 404,
  conflict: 409,
  // The processor timed out or failed - an upstream fault, not the caller's.
  payment_error: 502,
  // Charged, but the balance write failed. Retry with the same paymentId.
  balance_not_updated: 503,
  account_error: 503,
});

function isObjectBody(body) {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

function badBody() {
  return { status: 400, body: { error: "invalid_request_body", problems: ["body must be a JSON object"] } };
}

// What a customer sees of their own account: no staff ids, nothing internal.
function customerView(account) {
  return {
    accountId: account.accountId,
    tripRef: account.tripRef,
    currency: account.currency,
    totalCents: account.totalCents,
    paidCents: account.paidCents,
    balanceCents: account.balanceCents,
    payments: account.payments.map(function (p) {
      return { paymentId: p.paymentId, amountCents: p.amountCents, status: p.status, processedAt: p.processedAt };
    }),
  };
}

const paymentRoutes = [
  {
    method: "POST",
    pattern: /^\/api\/finance\/payment-accounts$/,
    permission: PERMISSIONS.PAYMENTS_ACCOUNTS_WRITE,
    handler: async function (context) {
      if (!isObjectBody(context.body)) return badBody();
      const result = store.openAccount({
        customerId: context.body.customerId,
        tripRef: context.body.tripRef,
        totalCents: context.body.totalCents,
        currency: context.body.currency,
        // Who opened it comes from the principal, never from the body.
        openedBy: context.principal.userId,
        correlationId: context.correlationId,
      });
      return {
        status: OPEN_STATUS[result.status] || 500,
        body: result.ok
          ? { status: result.status, account: result.account }
          : { error: result.status, problems: result.problems || [] },
      };
    },
  },
  {
    method: "GET",
    pattern: new RegExp("^/api/finance/payment-accounts/" + ACCOUNT_ID + "$"),
    permission: PERMISSIONS.PAYMENTS_ACCOUNTS_READ,
    handler: async function (context) {
      const account = store.getAccount(context.params[0]);
      if (!account) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: { account: account } };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/portal\/payments$/,
    permission: PERMISSIONS.PORTAL_PAYMENTS_READ,
    handler: async function (context) {
      const accounts = store.listAccountsForCustomer(context.principal.userId).map(customerView);
      return { status: 200, body: { count: accounts.length, accounts: accounts } };
    },
  },
  {
    method: "POST",
    pattern: new RegExp("^/api/portal/payments/" + ACCOUNT_ID + "$"),
    permission: PERMISSIONS.PORTAL_PAYMENTS_WRITE,
    handler: async function (context) {
      if (!isObjectBody(context.body)) return badBody();
      const result = await makePayment({
        accountId: context.params[0],
        customerId: context.principal.userId,
        paymentId: context.body.paymentId,
        amountCents: context.body.amountCents,
        correlationId: context.correlationId,
      });
      const status = PAYMENT_STATUS[result.status] || 500;
      if (result.ok) {
        return {
          status: status,
          body: {
            status: result.status,
            paymentId: result.paymentId,
            amountCents: result.amountCents,
            balanceCents: result.balanceCents,
            transactionLogged: result.transactionLogged,
            account: customerView(result.account),
          },
        };
      }
      return {
        status: status,
        body: {
          error: result.status,
          message: result.message,
          retryable: Boolean(result.retryable) || result.status === "balance_not_updated",
          charged: Boolean(result.charged),
          balanceCents: typeof result.balanceCents === "number" ? result.balanceCents : null,
          transactionLogged: typeof result.transactionLogged === "boolean" ? result.transactionLogged : null,
        },
      };
    },
  },
];

module.exports = { paymentRoutes };
