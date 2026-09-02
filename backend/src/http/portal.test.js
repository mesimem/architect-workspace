// STORY-005 step 4: the portal login/logout boundary, tested over real HTTP.
//
// The service-level suite (portalLoginService.test.js) proves the decisions.
// This one proves the WIRING: that an anonymous caller can reach login and
// nothing else, that the token it returns actually opens the authenticated
// API, that an expired session is told to sign in again, and that each outcome
// maps to an honest status code.
//
// The tokens and passwords below are test fixtures. They exist only inside
// this process; the server reads its real tables from the environment.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { hashPassword } = require("../services/portal/portalCredentials");
const { clearFailureTracking, MAX_FAILED_ATTEMPTS } = require("../services/portal/portalLoginService");
const { getAuditEntries } = require("../services/audit/auditLog");
const { logTransaction } = require("../services/booking/crmTransactionLog");

const ADVISOR_TOKEN = "test-advisor-token-portal";
const TOKENS = ADVISOR_TOKEN + ":advisor:ADV-PORTAL-1";

const PASSWORD = "kilimanjaro-sunrise-2026";
const WRONG_PASSWORD = "kilimanjaro-sunset-2026";

async function main() {
  delete process.env.COLABERRY_DATA_DIR;

  const credentials = new Map([["CUST-PORTAL-1", await hashPassword(PASSWORD)]]);

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
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : options.body,
    });
  }

  function loginCall(body, headers) {
    return call("/api/portal/login", {
      method: "POST",
      body: JSON.stringify(body),
      headers: headers,
    });
  }

  try {
    // ------------------------------------------ login is reachable anonymously
    // Every other route needs a credential; this one cannot, because the
    // customer does not have one yet.
    clearFailureTracking();
    const res = await loginCall({ customerId: "CUST-PORTAL-1", password: PASSWORD });
    assert.strictEqual(res.status, 200);
    const authenticated = await res.json();

    assert.strictEqual(authenticated.status, "authenticated");
    assert.strictEqual(authenticated.customerId, "CUST-PORTAL-1");
    assert.strictEqual(authenticated.role, "customer");
    assert.ok(typeof authenticated.token === "string" && authenticated.token.length >= 40);
    // ISO strings, not epoch milliseconds - this is a published contract.
    assert.ok(!Number.isNaN(Date.parse(authenticated.expiresAt)));
    assert.ok(!Number.isNaN(Date.parse(authenticated.idleExpiresAt)));
    console.log("portalHttp: an anonymous caller can log in and receives a session token");

    // ---------------------------- CRITERION 1: the token opens the actual portal
    // "Then they access their portal" is only true if the token WORKS on an
    // authenticated route. A login endpoint that returns a token nothing
    // accepts would pass a weaker test than this.
    const browse = await call("/api/africa/destinations", { token: authenticated.token });
    assert.strictEqual(browse.status, 200, "the session token authenticates a real route");
    console.log("portalHttp: CRITERION 1 - the issued token opens an authenticated route");

    // The customer's role still applies. A session is not a promotion: the
    // advisor queue stays closed to them. (Full role work is STORY-006; this
    // only asserts the session did not widen what a customer may do.)
    const queue = await call("/api/advisor/reviews", { token: authenticated.token });
    assert.strictEqual(queue.status, 403, "a customer session is still only a customer");
    console.log("portalHttp: a session carries the customer role, not a wider one");

    // ------------------------------------- CRITERION 2: incorrect credentials
    clearFailureTracking();
    const denials = [
      ["wrong password", { customerId: "CUST-PORTAL-1", password: WRONG_PASSWORD }],
      ["unknown customer", { customerId: "CUST-NOBODY", password: PASSWORD }],
    ];
    for (const [label, body] of denials) {
      clearFailureTracking();
      const denied = await loginCall(body);
      assert.strictEqual(denied.status, 401, label + " must be 401");
      const payload = await denied.json();
      assert.strictEqual(payload.error, "invalid_credentials");
      assert.strictEqual(payload.message, "Invalid credentials.");
      assert.strictEqual(payload.token, undefined, "NO TOKEN ON A DENIED LOGIN");
    }
    console.log("portalHttp: CRITERION 2 - wrong password and unknown customer are both a flat 401");

    // A malformed submission is refused at the envelope with 400, which is a
    // different thing from a denied login and should read differently.
    for (const bad of [
      {},
      { customerId: "CUST-PORTAL-1" },
      { password: PASSWORD },
      { customerId: "", password: PASSWORD },
      { customerId: 7, password: PASSWORD },
      { customerId: "CUST-PORTAL-1", password: "x".repeat(1025) },
    ]) {
      const malformed = await loginCall(bad);
      assert.strictEqual(malformed.status, 400, "malformed login body must be 400");
      assert.strictEqual((await malformed.json()).error, "invalid_request_body");
    }
    const notJson = await call("/api/portal/login", { method: "POST", body: "{not json" });
    assert.strictEqual(notJson.status, 400);
    console.log("portalHttp: a malformed login body is a 400 at the envelope, not a 401");

    // ----------------------------------------------- lockout maps to 429 + Retry-After
    clearFailureTracking();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await loginCall({ customerId: "CUST-PORTAL-1", password: WRONG_PASSWORD });
    }
    const locked = await loginCall({ customerId: "CUST-PORTAL-1", password: WRONG_PASSWORD });
    assert.strictEqual(locked.status, 429);
    assert.strictEqual((await locked.json()).error, "locked_out");
    assert.ok(Number(locked.headers.get("retry-after")) > 0, "Retry-After tells a client when");
    console.log("portalHttp: a locked account is 429 with a Retry-After header");

    // ------------------------------------------------------------------ logout
    clearFailureTracking();
    const second = await (await loginCall({ customerId: "CUST-PORTAL-1", password: PASSWORD })).json();

    const loggedOut = await call("/api/portal/logout", { method: "POST", token: second.token });
    assert.strictEqual(loggedOut.status, 200);
    assert.deepStrictEqual(await loggedOut.json(), { status: "logged_out", endedSession: true });

    // The token must be dead everywhere, not just on the logout route.
    const afterLogout = await call("/api/africa/destinations", { token: second.token });
    assert.strictEqual(afterLogout.status, 401);
    assert.strictEqual((await afterLogout.json()).error, "unauthorized");
    console.log("portalHttp: logout kills the token for the whole API, not just for logout");

    // -------------------------------------------- viewing itineraries (REQ-007)
    // Two customers with a trip each. Only one of them is signing in.
    logTransaction({
      tripId: "TRIP-HTTP-MINE",
      customerId: "CUST-PORTAL-1",
      status: "confirmed",
      legs: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
      amountCents: 449000,
      currency: "USD",
      bookedAt: "2026-09-01T09:00:00.000Z",
    });
    logTransaction({
      tripId: "TRIP-HTTP-THEIRS",
      customerId: "CUST-SOMEONE-ELSE",
      status: "confirmed",
      legs: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
      amountCents: 449000,
      currency: "USD",
      bookedAt: "2026-09-01T09:00:00.000Z",
    });

    clearFailureTracking();
    const portal = await (await loginCall({ customerId: "CUST-PORTAL-1", password: PASSWORD })).json();

    const trips = await call("/api/portal/trips", { token: portal.token });
    assert.strictEqual(trips.status, 200);
    const listed = await trips.json();
    assert.strictEqual(listed.status, "ok");
    assert.ok(
      listed.itineraries.some(function (trip) {
        return trip.tripId === "TRIP-HTTP-MINE";
      }),
      "their own trip is listed"
    );
    assert.ok(
      !listed.itineraries.some(function (trip) {
        return trip.tripId === "TRIP-HTTP-THEIRS";
      }),
      "SOMEONE ELSE'S TRIP IS NOT LISTED"
    );
    console.log("portalHttp: a signed-in customer sees their own itineraries and no others");

    const mine = await call("/api/portal/trips/TRIP-HTTP-MINE", { token: portal.token });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual((await mine.json()).itinerary.tripId, "TRIP-HTTP-MINE");

    // The failure path the story calls "unauthorized access". 404, not 403 -
    // a 403 would confirm the trip exists, and walking trip ids would then map
    // every booking in the business. Both answers must be identical.
    const theirs = await call("/api/portal/trips/TRIP-HTTP-THEIRS", { token: portal.token });
    const invented = await call("/api/portal/trips/TRIP-NOPE", { token: portal.token });
    assert.strictEqual(theirs.status, 404, "another customer's trip is 404, NOT 403");
    assert.strictEqual(invented.status, 404);
    assert.deepStrictEqual(
      await theirs.json(),
      await invented.json(),
      "a stranger's trip and a nonexistent one are byte-identical over HTTP too"
    );
    console.log("portalHttp: another customer's trip is a 404 identical to a nonexistent trip");

    // An itinerary route is not reachable without a session at all...
    const anonymousTrips = await call("/api/portal/trips");
    assert.strictEqual(anonymousTrips.status, 401);
    // ...and an advisor's API token does not open the customer portal. Viewing
    // a customer's trips on their behalf is a permission, and permissions are
    // STORY-006's work.
    const advisorTrips = await call("/api/portal/trips", { token: ADVISOR_TOKEN });
    assert.strictEqual(advisorTrips.status, 403);
    console.log("portalHttp: the itinerary routes need a customer session - anonymous 401, advisor 403");

    // Logging out closes the itinerary view too, not just the logout route.
    await call("/api/portal/logout", { method: "POST", token: portal.token });
    const afterSignOut = await call("/api/portal/trips", { token: portal.token });
    assert.strictEqual(afterSignOut.status, 401);
    console.log("portalHttp: after signing out, the itineraries are no longer reachable");

    // --------------------------------------- session timeout is distinguishable
    // A revoked or invented token is an opaque "unauthorized". An EXPIRED one
    // says so, because the customer needs to know to sign in again - and only
    // the holder of a token we really issued can ever see that message.
    const expiring = createServer({
      principals: loadPrincipals(TOKENS),
      credentials: credentials,
    });
    await new Promise(function (resolve) {
      expiring.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = expiring.address().port;
      const third = await (
        await fetch("http://127.0.0.1:" + port + "/api/portal/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId: "CUST-PORTAL-1", password: PASSWORD }),
        })
      ).json();

      // Reach into the session store and age the session past its deadline -
      // the honest alternative is waiting 30 minutes.
      const sessions = require("../services/portal/portalSessions");
      const stale = sessions.verifySession(third.token, Date.now());
      assert.strictEqual(stale.ok, true, "alive before we age it");

      const expired = await fetch("http://127.0.0.1:" + port + "/api/africa/destinations", {
        headers: { Authorization: "Bearer " + third.token },
      });
      assert.strictEqual(expired.status, 200, "still fine right now");

      // Now push the clock past the absolute lifetime by expiring the row.
      sessions.purgeExpiredSessions(Date.now() + sessions.ABSOLUTE_LIFETIME_MS + 1);
      const afterTimeout = await fetch("http://127.0.0.1:" + port + "/api/africa/destinations", {
        headers: { Authorization: "Bearer " + third.token },
      });
      assert.strictEqual(afterTimeout.status, 401);
      // The row is gone, so this reads as an unknown token - which is the
      // honest answer once a purge has run. The DISTINGUISHED case is a
      // session still in the store whose deadline has passed, covered below.
      assert.strictEqual((await afterTimeout.json()).error, "unauthorized");

      const fourth = await (
        await fetch("http://127.0.0.1:" + port + "/api/portal/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId: "CUST-PORTAL-1", password: PASSWORD }),
        })
      ).json();
      // Age it without purging: verifySession finds the row, sees the deadline
      // has passed, and reports the timeout.
      const timedOut = sessions.verifySession(
        fourth.token,
        Date.now() + sessions.ABSOLUTE_LIFETIME_MS + 1
      );
      assert.strictEqual(timedOut.ok, false);
      assert.strictEqual(timedOut.reason, sessions.REASONS.ABSOLUTE_TIMEOUT);
      console.log("portalHttp: an expired session is refused, and expiry is reported as its own reason");
    } finally {
      await new Promise(function (resolve) {
        expiring.close(resolve);
      });
    }

    // -------------------------------- an unconfigured portal refuses every login
    // Fail closed. No credential table must mean "nobody can sign in", never
    // "anybody can".
    const unconfigured = createServer({
      principals: loadPrincipals(TOKENS),
      credentials: null,
    });
    await new Promise(function (resolve) {
      unconfigured.listen(0, "127.0.0.1", resolve);
    });
    try {
      const refused = await fetch(
        "http://127.0.0.1:" + unconfigured.address().port + "/api/portal/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId: "CUST-PORTAL-1", password: PASSWORD }),
        }
      );
      assert.strictEqual(refused.status, 503);
      const body = await refused.json();
      assert.strictEqual(body.error, "portal_login_unconfigured");
      assert.strictEqual(body.token, undefined, "AND CERTAINLY NO TOKEN");
      console.log("portalHttp: with no credential table configured, every login is refused with 503");
    } finally {
      await new Promise(function (resolve) {
        unconfigured.close(resolve);
      });
    }

    // ------------------------------------- public means login, and only login
    // The reordering that let login skip authentication must not have opened
    // anything else, and an anonymous request to a path that does not exist
    // must still be 401 rather than 404 - or an attacker can map the API.
    for (const [method, path] of [
      ["GET", "/api/africa/destinations"],
      ["GET", "/api/advisor/reviews"],
      ["POST", "/api/requests/triage"],
      ["POST", "/api/portal/logout"],
      ["GET", "/api/portal/login"], // right path, wrong method
      ["GET", "/api/does-not-exist"],
    ]) {
      const anonymous = await call(path, { method: method, body: method === "POST" ? "{}" : undefined });
      assert.strictEqual(anonymous.status, 401, method + " " + path + " must be 401 anonymously");
    }
    console.log("portalHttp: login is the ONLY public route, and unknown paths still 401 anonymously");

    // -------------------------------------------------- the audit trail, over HTTP
    // Criterion 3 end to end: the attempts made through the boundary in this
    // suite are on record, with no password or token anywhere in them.
    const loginEntries = getAuditEntries().filter(function (entry) {
      return entry.event.startsWith("portal.login") || entry.event === "portal.logout";
    });
    assert.ok(loginEntries.length >= 10, "every attempt above is on record");
    const serialised = JSON.stringify(loginEntries);
    assert.ok(!serialised.includes(PASSWORD), "NO PASSWORD IN THE TRAIL");
    assert.ok(!serialised.includes(WRONG_PASSWORD));
    assert.ok(!serialised.includes(authenticated.token), "NO TOKEN IN THE TRAIL");
    assert.ok(
      loginEntries.some(function (entry) {
        return entry.event === "portal.login.blocked";
      }),
      "including the ones we refused to even check"
    );
    console.log(
      "portalHttp: CRITERION 3 - " +
        loginEntries.length +
        " login/logout attempts audited over HTTP, no secrets in any of them"
    );

    console.log("portalHttp: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
}

main();
