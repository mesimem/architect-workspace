const assert = require("assert");
const { getSafariDetails } = require("./safariDetailsService");
const {
  getLoggedInteractions,
  logInteraction,
  InvalidInteractionKeyError,
} = require("./interactionLog");

// getSafariDetails is async as of the timeout boundary, so the whole suite
// runs inside one async main() rather than at module top level.
async function main() {
  // Happy path: known destination -> full safari details returned and logged.
  const result = await getSafariDetails({
    customerId: "CUST-1",
    destinationId: "SF-300",
    interactionKey: "INTERACTION-TEST-1",
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.details.name, "Serengeti Migration Safari");
  assert.strictEqual(result.details.destinationId, "SF-300");

  const loggedOk = getLoggedInteractions().filter(function (i) {
    return i.interactionKey === "INTERACTION-TEST-1";
  });
  assert.strictEqual(loggedOk.length, 1);
  assert.strictEqual(loggedOk[0].outcome, "viewed");

  console.log("safariDetailsService: happy path test passed");

  // Failure path: unsupported destination -> contact-advisor message, still logged.
  const unsupported = await getSafariDetails({
    customerId: "CUST-2",
    destinationId: "SF-DOES-NOT-EXIST",
    interactionKey: "INTERACTION-TEST-2",
  });

  assert.strictEqual(unsupported.status, "unsupported");
  assert.strictEqual(unsupported.message, "Contact an advisor for this destination.");
  assert.strictEqual(unsupported.details, undefined);

  const loggedUnsupported = getLoggedInteractions().filter(function (i) {
    return i.interactionKey === "INTERACTION-TEST-2";
  });
  assert.strictEqual(loggedUnsupported.length, 1);
  assert.strictEqual(loggedUnsupported[0].outcome, "unsupported");

  console.log("safariDetailsService: unsupported-destination failure path test passed");

  // Idempotency: logging the same interactionKey twice does not duplicate it.
  await getSafariDetails({
    customerId: "CUST-1",
    destinationId: "SF-300",
    interactionKey: "INTERACTION-TEST-1",
  });
  const loggedAgain = getLoggedInteractions().filter(function (i) {
    return i.interactionKey === "INTERACTION-TEST-1";
  });
  assert.strictEqual(loggedAgain.length, 1);

  console.log("safariDetailsService: interaction logging idempotency test passed");

  // Failure path: destination exists but details are incomplete -> flagged, not partial data.
  const incomplete = await getSafariDetails({
    customerId: "CUST-3",
    destinationId: "SF-301",
    interactionKey: "INTERACTION-TEST-3",
  });

  assert.strictEqual(incomplete.status, "incomplete");
  assert.strictEqual(
    incomplete.message,
    "Details for this destination are being finalized — contact an advisor."
  );
  assert.strictEqual(incomplete.details, undefined);

  const loggedIncomplete = getLoggedInteractions().filter(function (i) {
    return i.interactionKey === "INTERACTION-TEST-3";
  });
  assert.strictEqual(loggedIncomplete.length, 1);
  assert.strictEqual(loggedIncomplete[0].outcome, "incomplete");

  console.log("safariDetailsService: missing-safari-details failure path test passed");

  // Failure path: system timeout. A source that never resolves must not hang
  // the customer - it is abandoned after timeoutMs, retried once, then turned
  // into a contact-advisor answer. Short timeout so the test stays fast.
  let hangingCalls = 0;
  const hangingSource = function () {
    hangingCalls += 1;
    return new Promise(function () {}); // never settles
  };

  const timedOut = await getSafariDetails({
    customerId: "CUST-4",
    destinationId: "SF-300",
    interactionKey: "INTERACTION-TEST-4",
    source: hangingSource,
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(timedOut.status, "timeout");
  assert.strictEqual(
    timedOut.message,
    "We couldn't load safari details just now — please try again or contact an advisor."
  );
  assert.strictEqual(timedOut.details, undefined);
  assert.strictEqual(hangingCalls, 2); // retried exactly once, then capped

  const loggedTimeout = getLoggedInteractions().filter(function (i) {
    return i.interactionKey === "INTERACTION-TEST-4";
  });
  assert.strictEqual(loggedTimeout.length, 1);
  assert.strictEqual(loggedTimeout[0].outcome, "timeout");

  console.log("safariDetailsService: system-timeout failure path test passed");

  // Retry actually recovers: first attempt hangs, second answers. The customer
  // sees a normal result, so a single slow read is not a visible failure.
  let flakyCalls = 0;
  const flakySource = function (destinationId) {
    flakyCalls += 1;
    if (flakyCalls === 1) {
      return new Promise(function () {});
    }
    return Promise.resolve({
      destinationId: destinationId,
      name: "Serengeti Migration Safari",
      country: "Tanzania",
      durationDays: 7,
      priceUSD: 4200,
      description: "Follow the wildebeest migration across the Serengeti plains.",
    });
  };

  const recovered = await getSafariDetails({
    customerId: "CUST-5",
    destinationId: "SF-300",
    interactionKey: "INTERACTION-TEST-5",
    source: flakySource,
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(recovered.status, "ok");
  assert.strictEqual(recovered.details.name, "Serengeti Migration Safari");
  assert.strictEqual(flakyCalls, 2);

  console.log("safariDetailsService: timeout-then-retry recovery test passed");

  // A source that THROWS is a different failure from a slow one: it is not
  // retried, and it reports "unavailable" rather than "timeout".
  let brokenCalls = 0;
  const brokenSource = function () {
    brokenCalls += 1;
    return Promise.reject(new Error("connection refused"));
  };

  const unavailable = await getSafariDetails({
    customerId: "CUST-6",
    destinationId: "SF-300",
    interactionKey: "INTERACTION-TEST-6",
    source: brokenSource,
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(unavailable.status, "unavailable");
  assert.strictEqual(
    unavailable.message,
    "Safari details are temporarily unavailable — contact an advisor."
  );
  assert.strictEqual(unavailable.details, undefined);
  assert.strictEqual(brokenCalls, 1); // NOT retried

  const loggedUnavailable = getLoggedInteractions().filter(function (i) {
    return i.interactionKey === "INTERACTION-TEST-6";
  });
  assert.strictEqual(loggedUnavailable.length, 1);
  assert.strictEqual(loggedUnavailable[0].outcome, "unavailable");

  console.log("safariDetailsService: broken-source (no retry) failure path test passed");

  // An interaction we cannot audit is not served. A missing, too-short or
  // non-string key is refused BEFORE the catalog is touched, so nothing is
  // read, nothing is logged, and the customer is not shown data that left no
  // trace. Before this guard, `undefined` was an acceptable key: the first
  // call logged, and every later one silently replayed that entry.
  const badKeys = [undefined, "", "short", 12345678, {}];
  const countBefore = getLoggedInteractions().length;

  for (const badKey of badKeys) {
    let sourceCalls = 0;
    const refused = await getSafariDetails({
      customerId: "CUST-7",
      destinationId: "SF-300",
      interactionKey: badKey,
      source: function () {
        sourceCalls += 1;
        return Promise.resolve({});
      },
    });

    assert.strictEqual(refused.status, "invalid_request");
    assert.strictEqual(
      refused.message,
      "Something went wrong on our side — please try again or contact an advisor."
    );
    assert.strictEqual(refused.details, undefined);
    assert.strictEqual(sourceCalls, 0); // refused before any read
  }

  assert.strictEqual(getLoggedInteractions().length, countBefore); // nothing logged

  console.log("safariDetailsService: invalid interaction key is refused before any read");

  // Last line of defence: a caller that skips the service and logs directly
  // with a bad key gets a loud, classified error rather than a corrupted log.
  assert.throws(
    function () {
      logInteraction(undefined, { customerId: "CUST-7" });
    },
    function (error) {
      return (
        error instanceof InvalidInteractionKeyError && error.errorClass === "ValidationError"
      );
    }
  );

  console.log("safariDetailsService: logInteraction itself rejects a bad key");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
