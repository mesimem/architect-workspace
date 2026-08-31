const assert = require("assert");

const {
  postTransaction,
  validateTransaction,
  defaultAccountingPoster,
  getLedger,
  findPosted,
  AccountingAuthError,
} = require("./accountingClient");

const TOKEN = "test-accounting-token";

// Short timeout and a real (small) retry budget so the timeout path is exercised
// properly without the suite taking seconds.
const FAST = { timeoutMs: 20, maxAttempts: 2 };

function validTransaction(overrides) {
  return Object.assign(
    {
      transactionId: "txn-0000-0001",
      customerId: "CUST-1",
      entryType: "sale",
      amountCents: 249900,
      currency: "USD",
      occurredAt: "2026-09-01T12:00:00.000Z",
      memo: "Trip TRIP-1",
    },
    overrides
  );
}

function countingPoster() {
  const spy = async function (payload) {
    spy.calls += 1;
    spy.lastPayload = payload;
    return defaultAccountingPoster(payload);
  };
  spy.calls = 0;
  spy.lastPayload = null;
  return spy;
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;

  // HAPPY PATH: a completed transaction reaches the books and comes back with a
  // reference we can cite.
  const poster = countingPoster();
  const posted = await postTransaction(
    Object.assign({ transaction: validTransaction(), post: poster, token: TOKEN }, FAST)
  );

  assert.strictEqual(posted.status, "posted");
  assert.strictEqual(posted.posted, true);
  assert.strictEqual(posted.replayed, false);
  assert.ok(posted.reference.startsWith("ACCT-"));
  assert.strictEqual(posted.attempts, 1);
  assert.strictEqual(poster.calls, 1);

  const ledgerRow = getLedger().find(function (r) {
    return r.transactionId === "txn-0000-0001";
  });
  assert.strictEqual(ledgerRow.amountCents, 249900);
  assert.strictEqual(ledgerRow.currency, "USD");
  assert.strictEqual(findPosted("txn-0000-0001").reference, posted.reference);

  console.log("accountingClient: a completed transaction is posted to the accounting software");

  // THE CREDENTIAL IS PRESENTED BUT NEVER LEAKED. It must reach the transport
  // and appear nowhere in what we hand back to a caller.
  assert.strictEqual(poster.lastPayload.credentials.token, TOKEN);
  assert.strictEqual(poster.lastPayload.idempotencyKey, "txn-0000-0001");
  assert.ok(!JSON.stringify(posted).includes(TOKEN));
  assert.ok(!JSON.stringify(getLedger()).includes(TOKEN));
  assert.ok(!JSON.stringify(findPosted("txn-0000-0001")).includes(TOKEN));

  console.log("accountingClient: the credential reaches the transport and leaks into nothing else");

  // IDEMPOTENCY: the same transaction twice does not double-post, and the
  // second attempt does not even reach the API.
  const ledgerSizeBefore = getLedger().length;
  const replay = await postTransaction(
    Object.assign({ transaction: validTransaction(), post: poster, token: TOKEN }, FAST)
  );

  assert.strictEqual(replay.status, "already_posted");
  assert.strictEqual(replay.posted, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.reference, posted.reference);
  assert.strictEqual(poster.calls, 1, "a replay must not reach the accounting API at all");
  assert.strictEqual(getLedger().length, ledgerSizeBefore);

  console.log("accountingClient: re-posting the same transaction cannot duplicate it in the books");

  // FAILURE PATH - INCORRECT TRANSACTION DATA FORMAT. Malformed data is refused
  // before the wire, so it costs nothing and cannot half-land.
  const malformed = [
    [{ transactionId: "short" }, "transactionId"],
    [{ customerId: "" }, "customerId"],
    [{ entryType: "invoice" }, "entryType"],
    [{ amountCents: 12.5 }, "amountCents"], // a float amount is a rounding defect
    [{ amountCents: 0 }, "amountCents"],
    [{ amountCents: -100 }, "amountCents"],
    [{ amountCents: "249900" }, "amountCents"],
    [{ currency: "dollars" }, "currency"],
    [{ currency: "usd" }, "currency"],
    [{ occurredAt: "last tuesday" }, "occurredAt"],
    [{ memo: "m".repeat(201) }, "memo"],
  ];

  const rejector = countingPoster();
  for (let i = 0; i < malformed.length; i += 1) {
    const [override, expectedField] = malformed[i];
    const outcome = await postTransaction(
      Object.assign(
        { transaction: validTransaction(override), post: rejector, token: TOKEN },
        FAST
      )
    );
    assert.strictEqual(outcome.status, "invalid_transaction", "case " + i);
    assert.strictEqual(outcome.posted, false, "case " + i);
    assert.strictEqual(outcome.errorClass, "ValidationError", "case " + i);
    assert.ok(
      outcome.errors.some(function (e) {
        return e.field === expectedField;
      }),
      "case " + i + " should name " + expectedField
    );
  }

  // A transaction that is not an object at all is refused the same way.
  const notAnObject = await postTransaction(
    Object.assign({ transaction: null, post: rejector, token: TOKEN }, FAST)
  );
  assert.strictEqual(notAnObject.status, "invalid_transaction");

  assert.strictEqual(rejector.calls, 0, "malformed data must never reach the accounting API");
  assert.strictEqual(getLedger().length, ledgerSizeBefore);

  console.log("accountingClient: malformed transaction data is refused before it reaches the API");

  // The validator is exported and usable on its own - the recorder checks the
  // shape before it decides anything.
  assert.deepStrictEqual(validateTransaction(validTransaction()), []);

  // FAILURE PATH - UNAUTHORIZED ACCESS ATTEMPT. A rejected credential is not
  // retried: it will not fix itself, and hammering it is how you get an account
  // locked out.
  const unauthorizedPoster = countingPoster();
  const rejecting = async function (payload) {
    unauthorizedPoster.calls += 1;
    void payload;
    throw new AccountingAuthError();
  };
  const unauthorized = await postTransaction(
    Object.assign(
      {
        transaction: validTransaction({ transactionId: "txn-0000-0002" }),
        post: rejecting,
        token: "wrong-token",
      },
      FAST
    )
  );

  assert.strictEqual(unauthorized.status, "unauthorized");
  assert.strictEqual(unauthorized.posted, false);
  assert.strictEqual(unauthorized.errorClass, "AuthError");
  assert.strictEqual(unauthorized.attempts, 1, "a rejected credential must not be retried");
  assert.strictEqual(unauthorizedPoster.calls, 1);
  // Not in the books, and not marked as posted - so it can be tried again once
  // the credential is fixed.
  assert.strictEqual(findPosted("txn-0000-0002"), null);
  assert.ok(!JSON.stringify(unauthorized).includes("wrong-token"));

  console.log("accountingClient: a rejected credential fails once, is not retried, and posts nothing");

  // No credential configured at all is a deployment fault. We refuse loudly
  // rather than skipping the books quietly.
  const unconfiguredPoster = countingPoster();
  const unconfigured = await postTransaction(
    Object.assign(
      {
        transaction: validTransaction({ transactionId: "txn-0000-0003" }),
        post: unconfiguredPoster,
        token: null,
      },
      FAST
    )
  );

  assert.strictEqual(unconfigured.status, "not_configured");
  assert.strictEqual(unconfigured.posted, false);
  assert.strictEqual(unconfigured.errorClass, "ConfigError");
  assert.strictEqual(unconfiguredPoster.calls, 0);

  console.log("accountingClient: a missing credential refuses loudly instead of skipping the books");

  // FAILURE PATH - API CONNECTION FAILURE, the broken flavour. A transport that
  // throws is reported, not retried.
  let brokenCalls = 0;
  const broken = async function () {
    brokenCalls += 1;
    throw new Error("ECONNREFUSED");
  };
  const unavailable = await postTransaction(
    Object.assign(
      { transaction: validTransaction({ transactionId: "txn-0000-0004" }), post: broken, token: TOKEN },
      FAST
    )
  );

  assert.strictEqual(unavailable.status, "unavailable");
  assert.strictEqual(unavailable.posted, false);
  assert.strictEqual(unavailable.errorClass, "UpstreamUnavailable");
  assert.strictEqual(brokenCalls, 1);
  assert.strictEqual(findPosted("txn-0000-0004"), null);

  console.log("accountingClient: an unreachable API is reported as unavailable and posts nothing");

  // FAILURE PATH - API CONNECTION FAILURE, the slow flavour. A hang IS retried,
  // up to the cap, and then gives up rather than waiting forever.
  let hangCalls = 0;
  const hangs = function () {
    hangCalls += 1;
    return new Promise(function () {});
  };
  const timedOut = await postTransaction(
    Object.assign(
      { transaction: validTransaction({ transactionId: "txn-0000-0005" }), post: hangs, token: TOKEN },
      FAST
    )
  );

  assert.strictEqual(timedOut.status, "timeout");
  assert.strictEqual(timedOut.posted, false);
  assert.strictEqual(timedOut.errorClass, "TimeoutError");
  assert.strictEqual(timedOut.attempts, FAST.maxAttempts, "a timeout is retried up to the cap");
  assert.strictEqual(hangCalls, FAST.maxAttempts);
  assert.strictEqual(findPosted("txn-0000-0005"), null);

  console.log("accountingClient: a hanging API times out, retries to the cap, then gives up");

  // BREAK CASE from CLAUDE.md: the transport reports success in the wrong
  // shape. We record it as posted anyway - a duplicate in the books is worse
  // than an entry we cannot cite - and say plainly that it needs reconciling.
  let shapelessCalls = 0;
  const shapeless = async function () {
    shapelessCalls += 1;
    return { ok: true }; // no reference
  };
  const unverified = await postTransaction(
    Object.assign(
      {
        transaction: validTransaction({ transactionId: "txn-0000-0006" }),
        post: shapeless,
        token: TOKEN,
      },
      FAST
    )
  );

  assert.strictEqual(unverified.status, "posted_unverified");
  assert.strictEqual(unverified.posted, true);
  assert.strictEqual(unverified.reference, null);
  assert.strictEqual(unverified.errorClass, "ContractViolation");
  assert.strictEqual(findPosted("txn-0000-0006").unverified, true);

  // And it is still deduped, so the retry that would double-post cannot happen.
  const unverifiedReplay = await postTransaction(
    Object.assign(
      {
        transaction: validTransaction({ transactionId: "txn-0000-0006" }),
        post: shapeless,
        token: TOKEN,
      },
      FAST
    )
  );
  assert.strictEqual(unverifiedReplay.status, "already_posted");
  assert.strictEqual(shapelessCalls, 1);

  console.log("accountingClient: success in the wrong shape is flagged for reconciliation, not duplicated");

  // Nothing that failed ended up in the books. This is acceptance criterion 2
  // stated directly against the ledger.
  const ledgerIds = getLedger().map(function (r) {
    return r.transactionId;
  });
  ["txn-0000-0002", "txn-0000-0003", "txn-0000-0004", "txn-0000-0005"].forEach(function (id) {
    assert.ok(!ledgerIds.includes(id), id + " failed and must not be in the accounting software");
  });

  console.log("accountingClient: no failed transaction reached the accounting software");
  console.log("accountingClient: all tests passed");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
