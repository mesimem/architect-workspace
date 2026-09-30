// STORY-013: trip proposals, tested over real HTTP.
//
// The service suites prove the DECISIONS - proposalClock.test.js that the
// thirty-minute boundary is right, proposalStore.test.js that a late proposal
// still issues and a retry does not restart the clock, proposals.audit.test.js
// that an unauditable proposal is not left behind, proposalDelayNotifier.test.js
// that an advisor is paged once and only once. This suite proves the WIRING:
// that the permission each route declares is the one enforced, that the SLA an
// advisor sees over the API is the one the service computed, and that the audit
// entries are really readable afterwards THROUGH the API rather than only in a
// unit test.
//
// HOW A THIRTY-MINUTE BREACH IS TESTED IN A SUITE THAT RUNS IN MILLISECONDS.
// The routes take no `at` and no `startedAt` - the clock is the server's, on
// purpose, because an SLA the measured party can edit is not an SLA. So this
// file does not ask the API to pretend: it SEEDS a genuinely 100-minute-old
// draft by calling the service directly with a controlled clock, writing to the
// same store the routes read, and then exercises the real endpoints against it
// with the real clock. Nothing in the production path is loosened to make this
// testable.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const {
  startProposal,
  __resetProposalsForTests,
} = require("../services/proposals/proposalStore");
const { getOutbox, __clearOutboxForTests } = require("../services/proposals/proposalDelayNotifier");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");

const ADVISOR_TOKEN = "test-advisor-token-proposals";
const OTHER_ADVISOR_TOKEN = "test-advisor2-token-proposals";
const CUSTOMER_TOKEN = "test-customer-token-proposals";
const ADMIN_TOKEN = "test-admin-token-proposals";
const SALES_TOKEN = "test-sales-token-proposals";

const ADVISOR_USER = "ADV-PROP-1";
const CUSTOMER_USER = "CUST-PROP-1";

const TOKENS = [
  ADVISOR_TOKEN + ":advisor:" + ADVISOR_USER,
  OTHER_ADVISOR_TOKEN + ":advisor:ADV-PROP-2",
  CUSTOMER_TOKEN + ":customer:" + CUSTOMER_USER,
  ADMIN_TOKEN + ":admin:ADMIN-PROP-1",
  SALES_TOKEN + ":sales:SALES-PROP-1",
].join(",");

// Safari at cost $4,200 sold at $5,000 for two, plus a transfer at cost $140
// sold at $200. Subtotal $10,200, cost $8,540, margin $1,660.
function tripBody(overrides = {}) {
  return {
    title: "Ten days in Tanzania",
    lines: [
      { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
      { label: "Airport transfer", unitCostCents: 14000, unitSellCents: 20000, quantity: 1 },
    ],
    currency: "USD",
    customerNote: "Prices hold for 14 days.",
    internalNotes: "Supplier may discount if confirmed by Friday.",
    ...overrides,
  };
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetProposalsForTests();
  __resetAssignmentsForTests();
  __clearOutboxForTests();

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
  // about an entry EXISTING, and reading it back through the API is a stronger
  // proof than reading the module's own store.
  async function auditEntries() {
    const res = await call("/api/admin/audit", { token: ADMIN_TOKEN });
    assert.strictEqual(res.status, 200);
    return (await res.json()).entries;
  }

  function entriesFor(entries, event, resource) {
    return entries.filter(function (entry) {
      return entry.event === event && entry.resource === resource;
    });
  }

  try {
    // =========================================================== OPEN A DRAFT
    const opened = await call("/api/proposals", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: { customerId: CUSTOMER_USER, tripReference: "TRIP-13", title: "Tanzania" },
    });
    assert.strictEqual(opened.status, 201);
    const openedBody = await opened.json();
    const proposalId = openedBody.proposal.proposalId;
    assert.strictEqual(openedBody.status, "opened");
    assert.strictEqual(opened.headers.get("Location"), "/api/proposals/" + proposalId);
    assert.strictEqual(openedBody.proposal.status, "drafting");
    assert.strictEqual(openedBody.proposal.openedBy, ADVISOR_USER, "the session is the advisor");
    assert.strictEqual(openedBody.proposal.pricing, null, "a draft has no price yet");
    console.log("proposals http: an advisor opens a proposal and gets its id back");

    // AC-1, THE VISIBLE HALF. The advisor is told when this is due and where
    // they stand - a thirty-minute target nobody can see is not a target.
    assert.strictEqual(openedBody.proposal.slaMinutes, 30);
    assert.strictEqual(
      openedBody.proposal.deadlineAt,
      new Date(Date.parse(openedBody.proposal.startedAt) + 1800000).toISOString(),
      "the deadline is thirty minutes after the start the SERVER stamped"
    );
    assert.strictEqual(openedBody.proposal.slaPosition.breached, false);
    assert.ok(openedBody.proposal.slaPosition.remainingMs > 1700000, "nearly the whole budget left");
    console.log("proposals http: the response carries the deadline and the time remaining");

    // A RESUBMITTED FORM DOES NOT OPEN A SECOND PROPOSAL. Same correlation id,
    // so the server recognises the retry - and two clocks for one trip request
    // is the failure this prevents.
    const replayed = await call("/api/proposals", {
      method: "POST",
      token: ADVISOR_TOKEN,
      correlationId: "fixed-correlation-for-replay",
      body: { customerId: CUSTOMER_USER, title: "First" },
    });
    const replayedAgain = await call("/api/proposals", {
      method: "POST",
      token: ADVISOR_TOKEN,
      correlationId: "fixed-correlation-for-replay",
      body: { customerId: CUSTOMER_USER, title: "Second" },
    });
    assert.strictEqual(replayed.status, 201);
    assert.strictEqual(replayedAgain.status, 200, "200, not 201 - nothing was created this time");
    const firstBody = await replayed.json();
    const secondBody = await replayedAgain.json();
    assert.strictEqual(secondBody.status, "replayed");
    assert.strictEqual(secondBody.proposal.proposalId, firstBody.proposal.proposalId);
    assert.strictEqual(secondBody.proposal.startedAt, firstBody.proposal.startedAt, "same clock");
    console.log("proposals http: a resubmitted open replays instead of starting a second clock");

    // ================================================================= ISSUE
    const issued = await call("/api/proposals/" + proposalId + "/complete", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: tripBody(),
    });
    assert.strictEqual(issued.status, 200);
    const issuedBody = await issued.json();
    assert.strictEqual(issuedBody.status, "issued");
    assert.strictEqual(issuedBody.proposal.status, "issued");
    assert.strictEqual(issuedBody.proposal.version, 2);
    assert.strictEqual(issuedBody.proposal.completedBy, ADVISOR_USER);
    // The advisor's own response is the costed version - a proposal is an
    // internal working document and there is no customer route to this data.
    assert.strictEqual(issuedBody.proposal.pricing.totalCents, 1020000);
    assert.strictEqual(issuedBody.proposal.pricing.internal.costTotalCents, 854000);
    assert.strictEqual(issuedBody.proposal.pricing.internal.marginCents, 166000);
    console.log("proposals http: an advisor issues the proposal and gets back the costed version");

    // AC-1 OVER HTTP. Opened and issued inside the same second, so it is within
    // the budget, and nobody was paged.
    assert.strictEqual(issuedBody.proposal.sla.breached, false);
    assert.strictEqual(issuedBody.proposal.sla.state, "within_sla");
    assert.ok(issuedBody.proposal.sla.elapsedMs < 1800000);
    assert.strictEqual(issuedBody.delayNotification, null, "on time, so no page");
    console.log("proposals http: a proposal completed within 30 minutes reports no breach");

    // Re-issuing is a 409, not a 400: the request was fine, the resource state
    // was not. A 400 would send the advisor hunting for a mistake in their form.
    const reissued = await call("/api/proposals/" + proposalId + "/complete", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: tripBody(),
    });
    assert.strictEqual(reissued.status, 409);
    assert.strictEqual((await reissued.json()).error, "already_issued");
    console.log("proposals http: re-issuing an issued proposal is a 409, not a 400");

    // ================================================================== READ
    const read = await call("/api/proposals/" + proposalId, { token: ADVISOR_TOKEN });
    assert.strictEqual(read.status, 200);
    const readBody = await read.json();
    assert.strictEqual(readBody.proposal.proposalId, proposalId);
    // THE RECORDED DURATION DOES NOT GROW ON READ. Read a second time and it is
    // the same figure - the property that stops an on-time proposal looking
    // breached by the following morning.
    assert.strictEqual(readBody.proposal.sla.elapsedMs, issuedBody.proposal.sla.elapsedMs);
    assert.strictEqual(readBody.proposal.slaPosition.elapsedMs, issuedBody.proposal.sla.elapsedMs);
    console.log("proposals http: reading an issued proposal returns the duration it actually took");

    const missing = await call("/api/proposals/proposal_does_not_exist", { token: ADVISOR_TOKEN });
    assert.strictEqual(missing.status, 404);
    console.log("proposals http: an unknown proposal is a 404");

    // ============================================= FAILURE: BAD TRIP DETAILS
    const fresh = await call("/api/proposals", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: { customerId: CUSTOMER_USER, title: "To be fixed" },
    });
    const fixableId = (await fresh.json()).proposal.proposalId;

    const badDetails = await call("/api/proposals/" + fixableId + "/complete", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: tripBody({ lines: [{ label: "Safari", unitCostCents: 1, unitSellCents: 2, quantity: -4 }] }),
    });
    assert.strictEqual(badDetails.status, 400);
    const badBody = await badDetails.json();
    assert.strictEqual(badBody.error, "invalid_details");
    assert.ok(badBody.problems.length > 0, "every problem at once, so the form is fixed in one pass");

    // THE DRAFT SURVIVED, which is the part that matters to the advisor: their
    // work is still on their desk and the clock is still the original one.
    const stillOpen = await call("/api/proposals/" + fixableId, { token: ADVISOR_TOKEN });
    const stillOpenBody = await stillOpen.json();
    assert.strictEqual(stillOpenBody.proposal.status, "drafting");
    assert.strictEqual(stillOpenBody.proposal.pricing, null);
    console.log("proposals http: trip details that do not price are a 400, and the draft survives");

    // A body that is not a JSON object at all is a 400 with a clear code, not a
    // 500 and not a confusing pricing complaint.
    const arrayBody = await call("/api/proposals", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: [1, 2, 3],
    });
    assert.strictEqual(arrayBody.status, 400);
    assert.strictEqual((await arrayBody.json()).error, "invalid_request_body");

    const noCustomer = await call("/api/proposals", { method: "POST", token: ADVISOR_TOKEN, body: {} });
    assert.strictEqual(noCustomer.status, 400);
    assert.strictEqual((await noCustomer.json()).error, "invalid_request");
    console.log("proposals http: a malformed or incomplete open request is a 400");

    // ============================================== ACCEPTANCE CRITERION 3
    // "Trust: Given any trip proposal, when it is created, then an audit log
    // entry must be created."
    //
    // Read back through the admin API, because an entry only a unit test can
    // see is not an audit trail.
    const entries = await auditEntries();
    const openEntries = entriesFor(entries, "proposal.opened", proposalId);
    const issueEntries = entriesFor(entries, "proposal.issued", proposalId);
    assert.strictEqual(openEntries.length, 1, "opening is audited");
    assert.strictEqual(issueEntries.length, 1, "issuing is audited");
    assert.strictEqual(openEntries[0].actor, ADVISOR_USER);
    assert.strictEqual(openEntries[0].context.slaMinutes, 30);
    assert.strictEqual(issueEntries[0].context.slaBreached, false);
    assert.strictEqual(issueEntries[0].context.totalCents, 1020000);
    console.log("proposals http: opening and issuing are both in the audit trail, via the API");

    // And the refusal above is in there too. A trail that records only
    // successes cannot answer what happened to the proposal that is missing.
    assert.ok(
      entriesFor(entries, "proposal.refused", fixableId).length >= 1,
      "the refused completion is in the trail"
    );
    // No customer prose anywhere in it.
    const trailText = JSON.stringify(entries);
    assert.ok(!trailText.includes("Prices hold for 14 days"), "no customer note in the trail");
    assert.ok(!trailText.includes("Supplier may discount"), "no internal note either");
    console.log("proposals http: refusals are audited, and no note text reaches the trail");

    // ============================================== ACCEPTANCE CRITERION 2
    // "Given a trip proposal, when it exceeds 30 minutes, then the advisor
    // should be notified of the delay."
    //
    // Seeded, not faked - see the header. This draft was really opened 100
    // minutes ago as far as the store is concerned.
    const hundredMinutesAgo = new Date(Date.now() - 100 * 60 * 1000).toISOString();
    const seeded = startProposal(
      {
        customerId: CUSTOMER_USER,
        tripReference: "TRIP-LATE",
        title: "Abandoned at lunchtime",
        actor: ADVISOR_USER,
        correlationId: "seeded-late-draft-0001",
      },
      { now: function () { return hundredMinutesAgo; } }
    );
    assert.strictEqual(seeded.ok, true);
    const lateId = seeded.proposal.proposalId;

    // The dashboard query: which open drafts are late? Reading this pages
    // nobody, which is why it is a separate endpoint from the sweep.
    const breaches = await call("/api/proposals/sla/breaches", { token: ADVISOR_TOKEN });
    assert.strictEqual(breaches.status, 200);
    const breachBody = await breaches.json();
    const breachIds = breachBody.proposals.map(function (p) {
      return p.proposalId;
    });
    assert.ok(breachIds.includes(lateId), "the 100-minute-old draft is listed as late");
    assert.ok(!breachIds.includes(fixableId), "the draft opened seconds ago is not");
    assert.strictEqual(breachBody.slaMinutes, 30);
    const listedLate = breachBody.proposals.find(function (p) {
      return p.proposalId === lateId;
    });
    assert.strictEqual(listedLate.slaPosition.breached, true);
    assert.ok(listedLate.slaPosition.overdueMs > 69 * 60 * 1000, "about seventy minutes over");
    assert.strictEqual(getOutbox().length, 0, "and looking at the list paged nobody");
    console.log("proposals http: the breach list shows a late open draft, and pages nobody");

    // The sweep: page the advisors behind them.
    const swept = await call("/api/proposals/sla/notify", { method: "POST", token: ADVISOR_TOKEN, body: {} });
    assert.strictEqual(swept.status, 200);
    const sweptBody = await swept.json();
    assert.strictEqual(sweptBody.notified, 1);
    assert.strictEqual(sweptBody.failed, 0);
    const outbox = getOutbox();
    assert.strictEqual(outbox.length, 1, "exactly one advisor was paged");
    assert.strictEqual(outbox[0].proposalId, lateId);
    assert.strictEqual(outbox[0].advisor, ADVISOR_USER);
    assert.ok(outbox[0].overdueMinutes >= 70, "and told how late, in minutes");
    // Ids and figures only. Even the title stays out: it is advisor-typed free
    // text that can name the customer, and the advisor reads the proposal
    // itself anyway.
    assert.ok(!JSON.stringify(outbox[0]).includes("lunchtime"), "no free text in the page");
    console.log("proposals http: the sweep pages the advisor behind a late draft");

    // THE SWEEP IS SAFE ON A SCHEDULE. Run it again immediately: nobody is
    // paged twice. This is the property that lets a cron fire it every minute.
    const sweptAgain = await call("/api/proposals/sla/notify", { method: "POST", token: ADVISOR_TOKEN, body: {} });
    const againBody = await sweptAgain.json();
    assert.strictEqual(againBody.notified, 0);
    assert.strictEqual(againBody.alreadyNotified, 1);
    assert.strictEqual(getOutbox().length, 1, "still one page, not two");
    console.log("proposals http: running the sweep twice pages nobody twice");

    // A CALLER CANNOT MOVE THE CLOCK. A body-supplied `at` is not a parameter
    // this endpoint has - if it were, any advisor could page every colleague in
    // the company about proposals that are not late.
    const forged = await call("/api/proposals/sla/notify", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: { at: "2027-01-01T00:00:00.000Z", proposals: ["everything"] },
    });
    assert.strictEqual(forged.status, 200);
    const forgedBody = await forged.json();
    assert.strictEqual(forgedBody.notified, 0, "a forged future time paged nobody new");
    assert.strictEqual(getOutbox().length, 1);
    console.log("proposals http: a caller cannot move the clock or the queue with a request body");

    // ISSUING THE LATE ONE REPORTS THE BREACH - and pages nobody again, because
    // this advisor has already been told this proposal is late. One page per
    // proposal, not one per event.
    const lateIssue = await call("/api/proposals/" + lateId + "/complete", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: tripBody(),
    });
    assert.strictEqual(lateIssue.status, 200, "a late proposal still issues");
    const lateIssueBody = await lateIssue.json();
    assert.strictEqual(lateIssueBody.proposal.sla.breached, true);
    assert.strictEqual(lateIssueBody.proposal.sla.state, "sla_breached");
    assert.ok(lateIssueBody.proposal.sla.overdueMs > 69 * 60 * 1000);
    assert.strictEqual(lateIssueBody.delayNotification.status, "already_notified");
    assert.strictEqual(lateIssueBody.delayNotification.notified, true, "the advisor HAS been told");
    assert.strictEqual(getOutbox().length, 1, "and was not told a second time");
    console.log("proposals http: a late proposal issues, reports its breach, and re-pages nobody");

    // The breach is in the audit trail, not only on the record.
    const afterLate = await auditEntries();
    const lateIssueEntry = entriesFor(afterLate, "proposal.issued", lateId)[0];
    assert.strictEqual(lateIssueEntry.context.slaBreached, true);
    assert.strictEqual(entriesFor(afterLate, "proposal.delay_notified", lateId).length, 1);
    console.log("proposals http: the breach and the page are both in the audit trail");

    // It is no longer an OPEN breach, because it is no longer open.
    const afterBreaches = await call("/api/proposals/sla/breaches", { token: ADVISOR_TOKEN });
    const afterIds = (await afterBreaches.json()).proposals.map(function (p) {
      return p.proposalId;
    });
    assert.ok(!afterIds.includes(lateId), "an issued proposal is not an open breach");
    console.log("proposals http: once issued, a late proposal leaves the open-breach list");

    // ============================================================ PERMISSIONS
    // Each route DECLARES a permission and server.js enforces it. What is
    // proved here is that the declared one is the intended one - the mistake
    // that a service-level test cannot catch.
    const writeDenied = [
      ["customer", CUSTOMER_TOKEN],
      ["admin", ADMIN_TOKEN],
      ["sales", SALES_TOKEN],
    ];
    for (const [role, token] of writeDenied) {
      const res = await call("/api/proposals", {
        method: "POST",
        token: token,
        body: { customerId: CUSTOMER_USER },
      });
      assert.strictEqual(res.status, 403, role + " must not open a proposal");

      const readRes = await call("/api/proposals/" + proposalId, { token: token });
      assert.strictEqual(readRes.status, 403, role + " must not read a proposal");

      const sweepRes = await call("/api/proposals/sla/notify", { method: "POST", token: token, body: {} });
      assert.strictEqual(sweepRes.status, 403, role + " must not page advisors");
    }
    console.log("proposals http: customer, admin and sales are all refused on every route");

    // A customer must not reach a proposal even by guessing its id - and the
    // refusal is a 403 from the permission layer, before any handler runs, so
    // no proposal is read to produce it.
    const noToken = await call("/api/proposals/" + proposalId);
    assert.strictEqual(noToken.status, 401);
    const badToken = await call("/api/proposals/" + proposalId, { token: "not-a-real-token" });
    assert.strictEqual(badToken.status, 401);
    console.log("proposals http: an unauthenticated or unknown caller gets a 401");

    // ANOTHER ADVISOR CAN READ AND COMPLETE. Stated as a test because it is a
    // real decision, not an oversight: proposals are desk work that colleagues
    // cover for each other, and STORY-013 says nothing about ownership. The day
    // a requirement says "only the advisor who opened it", this test is the one
    // that has to change - which is the point of writing it down.
    const colleague = await call("/api/proposals/" + proposalId, { token: OTHER_ADVISOR_TOKEN });
    assert.strictEqual(colleague.status, 200);
    console.log("proposals http: a second advisor may read a colleague's proposal (deliberate)");

    // A malformed percent sequence in the path is a 400, not a 500.
    const malformed = await call("/api/proposals/%/complete", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: tripBody(),
    });
    assert.ok(malformed.status === 400 || malformed.status === 404, "status " + malformed.status);
    assert.notStrictEqual(malformed.status, 500, "a bad URL is never a 500");
    console.log("proposals http: a malformed id in the path is never a 500");

    console.log("proposals http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetProposalsForTests();
    __clearOutboxForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
