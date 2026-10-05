// STORY-018: the operations booking board, tested over real HTTP.
//
// The service suites prove the DECISIONS - bookingStatusLifecycle.test.js that
// an illegal transition is refused, bookingStatusStore.test.js that a change is
// stored, audited and rolled back when it cannot be, opsBookingBoard.test.js
// that a new booking appears on the board and a saved status is reflected on
// it. This suite proves the WIRING, which is where an access-control bug
// actually lives: that the permission each route DECLARES is the one enforced,
// that no other role can read the agency's whole booking book or move a booking
// however it presents itself, and that the audit entry a status change writes
// is really readable afterwards through the API rather than only in a unit test.
//
// "UNAUTHORIZED ACCESS TO BOOKING MANAGEMENT FEATURES" - the story's third
// failure path - is tested here and only here, because it is a property of the
// boundary, not of the services.
//
// The sharpest cases are the two an over-broad grant would silently allow. A
// SALES manager holds customer bookings already, so handing them this board
// looks almost reasonable - and is not: the board is EVERY customer's booking
// at once, not the ones they hold a relationship with. An ADMIN holds the audit
// trail, and granting them the write would mean the role that reads the record
// of who cancelled a booking is also the role that can cancel one. A suite that
// only checked "customer gets 403" would pass even if ops.bookings.write had
// been handed to everyone who can log in.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { __resetBookingStatusesForTests } = require("../services/booking/bookingStatusStore");
const { bookTrip } = require("../services/booking/bookTripService");

const OPS_TOKEN = "test-ops-token-bookings";
const ADVISOR_TOKEN = "test-advisor-token-bookings";
const CUSTOMER_TOKEN = "test-customer-token-bookings";
const SALES_TOKEN = "test-sales-token-bookings";
const ADMIN_TOKEN = "test-admin-token-bookings";
const PM_TOKEN = "test-pm-token-bookings";

const OPS_USER = "OPS-BOOKINGS-1";

const TOKENS = [
  OPS_TOKEN + ":operations_manager:" + OPS_USER,
  ADVISOR_TOKEN + ":advisor:ADV-BOOKINGS-1",
  CUSTOMER_TOKEN + ":customer:CUST-BOOKINGS-1",
  SALES_TOKEN + ":sales:SALES-BOOKINGS-1",
  ADMIN_TOKEN + ":admin:ADMIN-BOOKINGS-1",
  PM_TOKEN + ":product_manager:PM-BOOKINGS-1",
].join(",");

// Every role that must NOT reach the board, with the reason it is listed. Each
// is asserted individually below rather than only through this table, but the
// table is what makes a newly added role an obvious omission.
const FORBIDDEN_ROLES = [
  { name: "customer", token: CUSTOMER_TOKEN, why: "would read every other customer's trips" },
  { name: "advisor", token: ADVISOR_TOKEN, why: "sells trips, does not arrange them" },
  { name: "sales", token: SALES_TOKEN, why: "holds relationships, not the whole book" },
  { name: "admin", token: ADMIN_TOKEN, why: "reads the trail that records these changes" },
  { name: "product_manager", token: PM_TOKEN, why: "authors inventory, not deliveries" },
];

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  __resetBookingStatusesForTests();
  clearFailureTracking();

  const server = createServer({
    principals: loadPrincipals(TOKENS),
    credentials: new Map(),
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

  // The audit trail as an admin can actually read it. The trust criterion is
  // about entries EXISTING, and reading them back through the API is a stronger
  // proof than reading the module's own store.
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
    // =================================================================
    // A REAL BOOKING, made the way the application makes one.
    // =================================================================

    const booked = await bookTrip({
      customerId: "CUST-HTTP-1",
      flightId: "FL-100",
      hotelId: "HT-200",
      safariId: "SF-300",
      idempotencyKey: "ops-http-key-0001",
    });
    assert.strictEqual(booked.status, "confirmed");
    const tripId = booked.tripId;

    // =================================================================
    // FAILURE PATH: unauthorized access to booking management features.
    //
    // Asserted FIRST, before any successful call, so that a 403 below
    // cannot be an accident of ordering or of state left by a passing
    // test.
    // =================================================================

    // No credential at all. 401, not 403 - the caller has not said who they
    // are, which is a different answer from "you may not".
    for (const path of [
      "/api/ops/bookings",
      "/api/ops/bookings/" + tripId,
    ]) {
      assert.strictEqual((await call(path)).status, 401);
    }
    assert.strictEqual(
      (
        await call("/api/ops/bookings/" + tripId + "/status", {
          method: "PATCH",
          body: { status: "in_progress" },
        })
      ).status,
      401
    );
    console.log("ops bookings http: an anonymous caller is refused with 401 on every route");

    // A token that is not in the directory at all. Also 401 - an invented
    // bearer token must not be treated as an anonymous caller OR as a valid
    // one.
    assert.strictEqual(
      (await call("/api/ops/bookings", { token: "not-a-real-token" })).status,
      401
    );
    console.log("ops bookings http: an unknown token is refused with 401");

    // EVERY OTHER ROLE, on EVERY route. Written out per role rather than only
    // through the loop's table, because "no other role has this" is the claim
    // being made, and the two that matter most - sales and admin - deserve to
    // be readable as individual lines in this file rather than as an entry in
    // a fixture somebody could quietly edit.
    for (const role of FORBIDDEN_ROLES) {
      const list = await call("/api/ops/bookings", { token: role.token });
      assert.strictEqual(list.status, 403, role.name + " must not read the board: " + role.why);
      assert.strictEqual((await list.json()).error, "forbidden");

      const one = await call("/api/ops/bookings/" + tripId, { token: role.token });
      assert.strictEqual(one.status, 403, role.name + " must not read one booking");

      const patch = await call("/api/ops/bookings/" + tripId + "/status", {
        method: "PATCH",
        token: role.token,
        body: { status: "cancelled" },
      });
      assert.strictEqual(patch.status, 403, role.name + " must not change a booking status");
    }
    console.log("ops bookings http: no other role reads the board or moves a booking");

    // The two sharpest cases, stated individually so they read as the rules
    // they are and survive someone editing the table above.
    assert.strictEqual((await call("/api/ops/bookings", { token: SALES_TOKEN })).status, 403);
    assert.strictEqual((await call("/api/ops/bookings", { token: ADMIN_TOKEN })).status, 403);
    assert.strictEqual(
      (
        await call("/api/ops/bookings/" + tripId + "/status", {
          method: "PATCH",
          token: ADMIN_TOKEN,
          body: { status: "cancelled" },
        })
      ).status,
      403,
      "an admin reads the trail recording these changes and must not be able to make one"
    );
    console.log("ops bookings http: sales holds relationships and admin holds the trail - neither holds the board");

    // A refused request CHANGED NOTHING. Proved by asking as the one role that
    // may look: the booking is still confirmed, untouched.
    const afterDenials = await call("/api/ops/bookings", { token: OPS_TOKEN });
    assert.strictEqual(afterDenials.status, 200);
    const deniedBoard = await afterDenials.json();
    assert.strictEqual(deniedBoard.bookings[0].status, "confirmed");
    assert.strictEqual(deniedBoard.bookings[0].statusVersion, 0);
    console.log("ops bookings http: none of the refused requests moved the booking");

    // And the denials are on the record. server.js audits every refusal
    // centrally, which is why this file does not have to.
    const denialTrail = await auditEntries();
    assert.ok(
      denialTrail.some(function (entry) {
        return entry.event === "authz.access.denied";
      }),
      "a denied request must be audited"
    );
    console.log("ops bookings http: refused requests are recorded in the audit trail");

    // =================================================================
    // CRITERION 1: a new booking is displayed with its current status.
    // =================================================================

    const listed = await call("/api/ops/bookings", { token: OPS_TOKEN });
    assert.strictEqual(listed.status, 200);
    const board = await listed.json();

    assert.strictEqual(board.total, 1);
    assert.strictEqual(board.shown, 1);
    assert.strictEqual(board.unlistable, 0);
    assert.deepStrictEqual(board.countsByStatus, { confirmed: 1 });
    // The vocabulary ships with the board so a client builds its controls from
    // the server's list rather than a hardcoded copy.
    assert.deepStrictEqual(board.statuses, ["confirmed", "in_progress", "completed", "cancelled"]);

    const row = board.bookings[0];
    assert.strictEqual(row.tripId, tripId);
    assert.strictEqual(row.customerId, "CUST-HTTP-1");
    assert.strictEqual(row.status, "confirmed");
    assert.strictEqual(row.statusIsManaged, true);
    assert.deepStrictEqual(row.allowedNextStatuses, ["in_progress", "cancelled"]);
    assert.strictEqual(row.statusVersion, 0);
    assert.strictEqual(row.statusChangedBy, null);
    console.log("ops bookings http: CRITERION 1 - a new booking is on the board with its status");

    // The same booking on its own, which is the row a detail view opens.
    const single = await call("/api/ops/bookings/" + tripId, { token: OPS_TOKEN });
    assert.strictEqual(single.status, 200);
    assert.strictEqual((await single.json()).booking.status, "confirmed");
    console.log("ops bookings http: one booking reads back on its own");

    // =================================================================
    // CRITERION 2: a saved status change is reflected on the dashboard.
    // =================================================================

    const saved = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "in_progress" },
      correlationId: "ops-http-corr-0001",
    });
    assert.strictEqual(saved.status, 200);
    const savedBody = await saved.json();
    assert.strictEqual(savedBody.changed, true);
    assert.strictEqual(savedBody.booking.status, "in_progress");
    // Who changed it came from the authenticated principal, not from the body.
    assert.strictEqual(savedBody.booking.statusChangedBy, OPS_USER);
    assert.strictEqual(savedBody.booking.statusVersion, 1);

    // Reflected on the DASHBOARD, asked for again rather than inferred from the
    // PATCH's own response.
    const reread = await (await call("/api/ops/bookings", { token: OPS_TOKEN })).json();
    assert.strictEqual(reread.bookings[0].status, "in_progress");
    assert.strictEqual(reread.bookings[0].previousStatus, "confirmed");
    assert.deepStrictEqual(reread.bookings[0].allowedNextStatuses, ["completed", "cancelled"]);
    assert.deepStrictEqual(reread.countsByStatus, { in_progress: 1 });
    console.log("ops bookings http: CRITERION 2 - the saved status is reflected on the dashboard");

    // =================================================================
    // TRUST CRITERION: the change is in the audit trail, read through the
    // API by the role that is allowed to read it.
    // =================================================================

    const trail = await auditEntries();
    const changeEntry = findEntry(trail, "booking.status.changed", tripId);
    assert.ok(changeEntry, "the status change must be in the audit trail");
    assert.strictEqual(changeEntry.outcome, "success");
    assert.strictEqual(changeEntry.actor, OPS_USER);
    assert.strictEqual(changeEntry.context.from, "confirmed");
    assert.strictEqual(changeEntry.context.to, "in_progress");
    // The correlation id the CLIENT sent, so a change can be traced from the
    // request that caused it.
    assert.strictEqual(changeEntry.correlationId, "ops-http-corr-0001");
    console.log("ops bookings http: the status change is readable in the audit trail");

    // =================================================================
    // IDEMPOTENCY over HTTP: the double-clicked button.
    // =================================================================

    const entriesBefore = (await auditEntries()).length;
    const replayed = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "in_progress" },
      correlationId: "ops-http-corr-0002",
    });
    // 200, not an error: the booking IS in the state the caller asked for.
    assert.strictEqual(replayed.status, 200);
    const replayedBody = await replayed.json();
    // But `changed` says they did not cause it, which is what lets a client
    // show "saved" honestly instead of claiming an edit it did not make.
    assert.strictEqual(replayedBody.changed, false);
    assert.strictEqual(replayedBody.booking.statusVersion, 1);
    // Nothing new in the trail. A second entry would claim the status changed
    // twice.
    assert.strictEqual((await auditEntries()).length, entriesBefore);
    console.log("ops bookings http: a replayed PATCH is a 200 that changed and audited nothing");

    // =================================================================
    // FAILURE PATH: booking status fails to update. The status codes.
    // =================================================================

    // 409, not 400: the request was well-formed and named a real status. It
    // collided with the STATE the booking is in, and a client can tell those
    // apart and should.
    const skipped = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "confirmed" },
      correlationId: "ops-http-corr-0003",
    });
    assert.strictEqual(skipped.status, 409);
    const skippedBody = await skipped.json();
    assert.strictEqual(skippedBody.error, "illegal_transition");
    // The message names what WOULD work, so an operator can act on it.
    assert.ok(
      skippedBody.problems.some(function (problem) {
        return problem.includes("completed") && problem.includes("cancelled");
      }),
      "an illegal transition must say which statuses are legal instead"
    );
    console.log("ops bookings http: an illegal transition is a 409 that names the legal moves");

    // 400, not 409: the caller named a status that does not exist. Their typo,
    // and a different thing to fix.
    const typo = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "in_progres" },
      correlationId: "ops-http-corr-0004",
    });
    assert.strictEqual(typo.status, 400);
    assert.strictEqual((await typo.json()).error, "unknown_target_status");
    console.log("ops bookings http: an unrecognised status is a 400, not a 409");

    // A missing status field, and a status of the wrong type - both the same
    // refusal, because neither names a status.
    for (const body of [{}, { status: null }, { status: 42 }, { status: ["cancelled"] }]) {
      const res = await call("/api/ops/bookings/" + tripId + "/status", {
        method: "PATCH",
        token: OPS_TOKEN,
        body: body,
        correlationId: "ops-http-corr-0005",
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).error, "unknown_target_status");
    }
    console.log("ops bookings http: a missing or wrongly-typed status is refused at 400");

    // A non-object body is stopped at the envelope, before any decision is
    // reached - which is the one class of nonsense the boundary IS allowed to
    // refuse on its own.
    const badBody = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: [],
      correlationId: "ops-http-corr-0006",
    });
    assert.strictEqual(badBody.status, 400);
    assert.strictEqual((await badBody.json()).error, "invalid_request_body");
    console.log("ops bookings http: a non-object body is refused at the envelope");

    // 404 for a booking that does not exist, on both the read and the write.
    assert.strictEqual(
      (await call("/api/ops/bookings/TRIP-NOPE", { token: OPS_TOKEN })).status,
      404
    );
    const ghost = await call("/api/ops/bookings/TRIP-NOPE/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "cancelled" },
      correlationId: "ops-http-corr-0007",
    });
    assert.strictEqual(ghost.status, 404);
    assert.strictEqual((await ghost.json()).error, "unknown_booking");
    console.log("ops bookings http: a booking that does not exist is a 404 on read and on write");

    // A malformed percent-encoded id is a 400, not the 500 an unguarded
    // decodeURIComponent would produce on a URL a scanner finds within the hour.
    assert.strictEqual((await call("/api/ops/bookings/%", { token: OPS_TOKEN })).status, 400);
    assert.strictEqual(
      (
        await call("/api/ops/bookings/%/status", {
          method: "PATCH",
          token: OPS_TOKEN,
          body: { status: "cancelled" },
          correlationId: "ops-http-corr-0008",
        })
      ).status,
      400
    );
    console.log("ops bookings http: a malformed trip ID is a 400, not a 500");

    // Every refusal above left the booking exactly where it was.
    const stillInProgress = await (await call("/api/ops/bookings", { token: OPS_TOKEN })).json();
    assert.strictEqual(stillInProgress.bookings[0].status, "in_progress");
    assert.strictEqual(stillInProgress.bookings[0].statusVersion, 1);
    console.log("ops bookings http: no refused request moved the booking");

    // =================================================================
    // THE REST OF THE LIFECYCLE, and the terminal refusal, over HTTP.
    // =================================================================

    const completed = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "completed" },
      correlationId: "ops-http-corr-0009",
    });
    assert.strictEqual(completed.status, 200);
    const completedBody = await completed.json();
    assert.strictEqual(completedBody.booking.status, "completed");
    assert.strictEqual(completedBody.booking.statusVersion, 2);
    // Terminal: the dashboard is told there is nothing further to offer.
    assert.deepStrictEqual(completedBody.booking.allowedNextStatuses, []);
    console.log("ops bookings http: a booking can be carried to completed");

    // BOTH changes are in the trail, not just the first - the first-write-wins
    // trap the version keying exists to avoid, proved through the API.
    const fullTrail = await auditEntries();
    const changeEntries = fullTrail.filter(function (entry) {
      return entry.event === "booking.status.changed" && entry.resource === tripId;
    });
    assert.strictEqual(changeEntries.length, 2);
    assert.deepStrictEqual(
      changeEntries
        .map(function (entry) {
          return entry.context.from + "->" + entry.context.to;
        })
        .sort(),
      ["confirmed->in_progress", "in_progress->completed"]
    );
    console.log("ops bookings http: every status change is in the trail, not only the first");

    // 409: a trip that has been travelled cannot be un-travelled.
    const reopen = await call("/api/ops/bookings/" + tripId + "/status", {
      method: "PATCH",
      token: OPS_TOKEN,
      body: { status: "in_progress" },
      correlationId: "ops-http-corr-0010",
    });
    assert.strictEqual(reopen.status, 409);
    assert.strictEqual((await reopen.json()).error, "terminal_status");
    console.log("ops bookings http: a completed booking cannot be reopened");

    // The refused attempt is itself on the record, under its own event.
    const refusalTrail = await auditEntries();
    assert.ok(
      findEntry(refusalTrail, "booking.status.change_refused", tripId),
      "a refused status change must be audited"
    );
    console.log("ops bookings http: a refused status change is audited under its own event");

    // And the booking is still completed.
    const finalBoard = await (await call("/api/ops/bookings", { token: OPS_TOKEN })).json();
    assert.strictEqual(finalBoard.bookings[0].status, "completed");
    assert.deepStrictEqual(finalBoard.countsByStatus, { completed: 1 });
    console.log("ops bookings http: the board ends where the lifecycle says it should");

    console.log("ops bookings http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetBookingStatusesForTests();
    __resetAssignmentsForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
