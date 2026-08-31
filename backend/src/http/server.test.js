const assert = require("assert");
const { createServer } = require("./server");
const { loadPrincipals, AuthConfigError } = require("./auth");

// Test tokens, defined here and nowhere else. They are not secrets: they exist
// only inside this process, and the server reads its real tokens from the
// environment. Nothing is hardcoded in shipped code.
const CUSTOMER_TOKEN = "test-customer-token-1";
const ADVISOR_TOKEN = "test-advisor-token-1";
const TOKENS =
  CUSTOMER_TOKEN + ":customer:CUST-HTTP-1," + ADVISOR_TOKEN + ":advisor:ADV-HTTP-1";

function completeRequestBody(requestId, overrides) {
  return Object.assign(
    {
      requestId: requestId,
      customerId: "CUST-HTTP-1",
      destination: "Tanzania",
      travelDates: { depart: "2026-10-12", return: "2026-10-23" },
      partySize: 2,
      notes: "Serengeti migration safari with a private guide.",
    },
    overrides
  );
}

async function main() {
  // An unset token table must stop the server starting. An auth layer that
  // degrades to "allow everyone" when misconfigured is worse than none.
  const saved = process.env.COLABERRY_API_TOKENS;
  delete process.env.COLABERRY_API_TOKENS;
  assert.throws(function () {
    loadPrincipals();
  }, AuthConfigError);
  assert.throws(function () {
    loadPrincipals("token-only-no-role");
  }, AuthConfigError);
  assert.throws(function () {
    loadPrincipals("a-token:wizard:USER-1");
  }, AuthConfigError); // unknown role
  if (saved !== undefined) {
    process.env.COLABERRY_API_TOKENS = saved;
  }

  console.log("httpApi: a missing or malformed token table refuses to start");

  const server = createServer({ principals: loadPrincipals(TOKENS) });
  await new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;

  function call(path, options = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (options.token) {
      headers.Authorization = "Bearer " + options.token;
    }
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : options.body,
    });
  }

  try {
    // AUTHENTICATION. Every failure mode looks identical from outside.
    for (const attempt of [
      { label: "no header", options: {} },
      { label: "wrong scheme", options: { headers: { Authorization: "Basic abc123" } } },
      { label: "unknown token", options: { token: "not-a-real-token-at-all" } },
      { label: "empty token", options: { headers: { Authorization: "Bearer " } } },
    ]) {
      const res = await call("/api/africa/destinations", attempt.options);
      assert.strictEqual(res.status, 401, attempt.label + " should be 401");
      const body = await res.json();
      assert.strictEqual(body.error, "unauthorized");
      assert.ok(body.correlationId, "every response carries a correlation id");
      // The response must not hint at which part was wrong.
      assert.ok(!JSON.stringify(body).includes("token-"), "no token material in the response");
    }

    console.log("httpApi: no credential, wrong scheme and bad token all return an opaque 401");

    // AUTHORISATION. The advisor queue is advisor-only.
    const customerAtQueue = await call("/api/advisor/reviews", { token: CUSTOMER_TOKEN });
    assert.strictEqual(customerAtQueue.status, 403);
    assert.strictEqual((await customerAtQueue.json()).error, "forbidden");

    const advisorAtQueue = await call("/api/advisor/reviews", { token: ADVISOR_TOKEN });
    assert.strictEqual(advisorAtQueue.status, 200);
    const queueBody = await advisorAtQueue.json();
    assert.ok(Array.isArray(queueBody.reviews));

    console.log("httpApi: a customer is refused the advisor queue, an advisor is allowed");

    // A customer may not submit a request in another customer's name.
    const impersonation = await call("/api/requests/triage", {
      method: "POST",
      token: CUSTOMER_TOKEN,
      body: JSON.stringify(completeRequestBody("HTTP-IMPERSONATE-1", { customerId: "CUST-SOMEONE-ELSE" })),
    });
    assert.strictEqual(impersonation.status, 403);

    console.log("httpApi: a customer cannot submit a request as another customer");

    // HAPPY PATH: a clear request comes back clear.
    const clear = await call("/api/requests/triage", {
      method: "POST",
      token: CUSTOMER_TOKEN,
      body: JSON.stringify(completeRequestBody("HTTP-CLEAR-0001")),
    });
    assert.strictEqual(clear.status, 200);
    assert.strictEqual((await clear.json()).status, "clear");

    // An unclear one is flagged - and the advisor can then see it in the queue.
    const flagged = await call("/api/requests/triage", {
      method: "POST",
      token: CUSTOMER_TOKEN,
      body: JSON.stringify(
        completeRequestBody("HTTP-FLAGGED-001", {
          travelDates: { depart: "", return: "" },
          notes: "Not sure when, somewhere warm.",
        })
      ),
    });
    assert.strictEqual(flagged.status, 200);
    assert.strictEqual((await flagged.json()).status, "flagged");

    const queueAfter = await (await call("/api/advisor/reviews", { token: ADVISOR_TOKEN })).json();
    assert.ok(
      queueAfter.reviews.some(function (r) {
        return r.requestId === "HTTP-FLAGGED-001";
      }),
      "the flagged request must appear in the advisor's queue"
    );

    console.log("httpApi: triage over HTTP flags an unclear request and the advisor sees it");

    // MALFORMED INPUT is rejected at the boundary, before business logic.
    const badJson = await call("/api/requests/triage", {
      method: "POST",
      token: CUSTOMER_TOKEN,
      body: "{ not json",
    });
    assert.strictEqual(badJson.status, 400);
    assert.strictEqual((await badJson.json()).error, "invalid_json");

    const badShape = await call("/api/requests/triage", {
      method: "POST",
      token: CUSTOMER_TOKEN,
      body: JSON.stringify({ requestId: "short", customerId: "", partySize: "two" }),
    });
    assert.strictEqual(badShape.status, 400);
    const shapeBody = await badShape.json();
    assert.strictEqual(shapeBody.error, "invalid_request_body");
    assert.strictEqual(shapeBody.problems.length, 3);

    const oversized = await call("/api/requests/triage", {
      method: "POST",
      token: CUSTOMER_TOKEN,
      body: JSON.stringify(completeRequestBody("HTTP-HUGE-00001", { notes: "x".repeat(100 * 1024) })),
    });
    assert.strictEqual(oversized.status, 413);

    console.log("httpApi: malformed, wrong-shaped and oversized bodies are refused at the boundary");

    // ROUTING. Unknown path is 404; known path with the wrong method is 405.
    assert.strictEqual((await call("/api/nope", { token: CUSTOMER_TOKEN })).status, 404);
    assert.strictEqual(
      (await call("/api/advisor/reviews", { method: "POST", token: ADVISOR_TOKEN, body: "{}" })).status,
      405
    );

    console.log("httpApi: unknown paths are 404 and wrong methods are 405");

    // The African section over HTTP, including the outcome-to-status mapping.
    const listed = await call("/api/africa/destinations", { token: CUSTOMER_TOKEN });
    assert.strictEqual(listed.status, 200);
    assert.ok((await listed.json()).destinations.length >= 2);

    const detail = await call("/api/africa/destinations/SF-300", { token: CUSTOMER_TOKEN });
    assert.strictEqual(detail.status, 200);
    assert.strictEqual((await detail.json()).details.destinationId, "SF-300");

    const missing = await call("/api/africa/destinations/SF-NOT-REAL", { token: CUSTOMER_TOKEN });
    assert.strictEqual(missing.status, 404); // we do not sell it - not a server error
    assert.strictEqual((await missing.json()).status, "unsupported");

    const unfinished = await call("/api/africa/destinations/SF-301", { token: CUSTOMER_TOKEN });
    assert.strictEqual(unfinished.status, 409);

    console.log("httpApi: African section outcomes map to honest HTTP status codes");

    // A supplied correlation id is echoed so a trace can span services; a
    // junk one is replaced rather than trusted into the logs.
    const traced = await call("/api/africa/destinations", {
      token: CUSTOMER_TOKEN,
      headers: { "X-Correlation-ID": "trace-abc-123456" },
    });
    assert.strictEqual(traced.headers.get("x-correlation-id"), "trace-abc-123456");

    const junkTrace = await call("/api/africa/destinations", {
      token: CUSTOMER_TOKEN,
      headers: { "X-Correlation-ID": "<script>alert(1)</script>" },
    });
    assert.notStrictEqual(junkTrace.headers.get("x-correlation-id"), "<script>alert(1)</script>");

    console.log("httpApi: correlation ids are echoed when valid and replaced when not");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
