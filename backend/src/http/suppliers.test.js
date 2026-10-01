// STORY-010: the supplier book, tested over real HTTP.
//
// The service suites prove the DECISIONS - supplierContracts.test.js that a
// data mismatch is caught, supplierStore.test.js that a change is stored,
// audited and immediately readable. This suite proves the WIRING, which is
// where an access-control bug actually lives: that the permission each route
// DECLARES is the one enforced, that no other role can read or alter the
// supplier book however it presents itself, and that the audit entry a change
// writes is really readable afterwards through the API rather than only in a
// unit test.
//
// All three acceptance criteria are marked below.
//
// THE AUTHORIZATION CASE THAT MATTERS MOST HERE IS THE CUSTOMER READ. A
// supplier record carries the rate card - what the agency PAYS - so a customer
// who could GET /api/suppliers would be reading the cost base behind every
// quote they have been issued. That is a worse leak than anything the product
// routes expose, and unlike the advisor-vs-product_manager split it cannot be
// caught by a test that only checks the write path. So every role except the
// advisor is checked against every route, read and write alike.
//
// The tokens and passwords are test fixtures. They exist only in this process.

const assert = require("assert");

const { createServer } = require("./server");
const { loadPrincipals } = require("./auth");
const { hashPassword } = require("../services/portal/portalCredentials");
const { clearFailureTracking } = require("../services/portal/portalLoginService");
const { __resetAssignmentsForTests } = require("../services/authz/roleAssignments");
const { __resetSuppliersForTests } = require("../services/suppliers/supplierStore");

const ADVISOR_TOKEN = "test-advisor-token-suppliers";
const PM_TOKEN = "test-pm-token-suppliers";
const CUSTOMER_TOKEN = "test-customer-token-suppliers";
const SALES_TOKEN = "test-sales-token-suppliers";
const ADMIN_TOKEN = "test-admin-token-suppliers";

const ADVISOR_USER = "ADV-SUPPLIERS-1";

const TOKENS = [
  ADVISOR_TOKEN + ":advisor:" + ADVISOR_USER,
  PM_TOKEN + ":product_manager:PM-SUPPLIERS-1",
  CUSTOMER_TOKEN + ":customer:CUST-SUPPLIERS-1",
  SALES_TOKEN + ":sales:SALES-SUPPLIERS-1",
  ADMIN_TOKEN + ":admin:ADMIN-SUPPLIERS-1",
].join(",");

const SESSION_CUSTOMER = "CUST-SUPPLIERS-SESSION";
const PASSWORD = "ngorongoro-crater-2026";

function sampleSupplier(overrides) {
  return Object.assign(
    {
      name: "Serengeti Serena Safari Lodge",
      country: "Tanzania",
      supplierType: "lodge",
      contactEmail: "reservations@serena.example",
      contactPhone: "+255 27 254 0000",
      contracts: [
        {
          contractRef: "TZ-SERENA-2026",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          currency: "USD",
          status: "active",
        },
      ],
      rates: [
        {
          contractRef: "TZ-SERENA-2026",
          description: "Standard double room, full board",
          currency: "USD",
          amountCents: 48000,
          unit: "per_person_per_night",
        },
      ],
    },
    overrides || {}
  );
}

async function main() {
  delete process.env.COLABERRY_DATA_DIR;
  __resetAssignmentsForTests();
  __resetSuppliersForTests();
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

  const bodies = [];
  async function readBody(res) {
    const text = await res.text();
    bodies.push(text);
    return text === "" ? null : JSON.parse(text);
  }

  try {
    // ================================================= ACCEPTANCE CRITERION 1
    // "Given a supplier is added, when details are saved, then it appears in
    // the supplier list."
    const createRes = await call("/api/suppliers", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: sampleSupplier(),
    });
    assert.strictEqual(createRes.status, 201, "a new supplier is recorded, so 201");
    const created = await readBody(createRes);
    assert.strictEqual(created.replayed, false);
    const supplierId = created.supplier.supplierId;
    assert.ok(supplierId.startsWith("supplier_"));
    // The advisor who sent the request is the recorded author - taken from the
    // resolved principal, not from the body.
    assert.strictEqual(created.supplier.createdBy, ADVISOR_USER);

    // IT APPEARS IN THE LIST. The criterion's actual words, so the list route
    // is what proves it - not the POST response echoing itself back.
    const listRes = await call("/api/suppliers", { token: ADVISOR_TOKEN });
    assert.strictEqual(listRes.status, 200);
    const list = await readBody(listRes);
    assert.strictEqual(list.count, 1);
    assert.strictEqual(list.suppliers[0].supplierId, supplierId);
    // REQ-012's "including contracts and rates" survives the round trip, which
    // a response shaped only from the identity fields would not.
    assert.strictEqual(list.suppliers[0].contracts[0].contractRef, "TZ-SERENA-2026");
    assert.strictEqual(list.suppliers[0].rates[0].amountCents, 48000);
    // The editable allow-list ships with the list so a client never hardcodes
    // its own copy to fall out of step.
    assert.ok(list.editable.includes("contracts"));
    assert.ok(!list.editable.includes("supplierId"));

    const readRes = await call("/api/suppliers/" + supplierId, { token: ADVISOR_TOKEN });
    assert.strictEqual(readRes.status, 200);
    assert.strictEqual((await readBody(readRes)).supplier.supplierId, supplierId);
    console.log("suppliers http: criterion 1 - a saved supplier appears in the list");

    // IDEMPOTENT OVER HTTP. A retry of the same submission is 200, not 201, and
    // does not add a second row - so a client that lost the first response can
    // tell what happened instead of creating a duplicate.
    const replayRes = await call("/api/suppliers", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: sampleSupplier(),
    });
    assert.strictEqual(replayRes.status, 200, "a replay is 200, not 201");
    assert.strictEqual((await readBody(replayRes)).replayed, true);
    assert.strictEqual((await (await call("/api/suppliers", { token: ADVISOR_TOKEN })).json()).count, 1);
    console.log("suppliers http: a resubmitted supplier is 200 and adds no second row");

    // ================================================= ACCEPTANCE CRITERION 2
    // "Given a supplier is updated, when changes are saved, then the system
    // reflects the updates."
    const patchRes = await call("/api/suppliers/" + supplierId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: {
        contactPhone: "+255 27 254 9999",
        rates: [
          {
            contractRef: "TZ-SERENA-2026",
            description: "Standard double room, full board",
            currency: "USD",
            amountCents: 52000,
            unit: "per_person_per_night",
          },
        ],
      },
    });
    assert.strictEqual(patchRes.status, 200);
    const patched = await readBody(patchRes);
    assert.deepStrictEqual(patched.changed.slice().sort(), ["contactPhone", "rates"]);
    assert.strictEqual(patched.unchanged, false);

    // THE SYSTEM REFLECTS IT - checked with a fresh GET, not the PATCH body. A
    // route that returns the new record while persisting the old one passes a
    // weaker test than this.
    const afterPatch = await readBody(
      await call("/api/suppliers/" + supplierId, { token: ADVISOR_TOKEN })
    );
    assert.strictEqual(afterPatch.supplier.contactPhone, "+255 27 254 9999");
    assert.strictEqual(afterPatch.supplier.rates[0].amountCents, 52000);
    assert.strictEqual(afterPatch.supplier.version, 2);
    assert.strictEqual(afterPatch.supplier.updatedBy, ADVISOR_USER);
    console.log("suppliers http: criterion 2 - an update is reflected on the next read");

    // ================================================= ACCEPTANCE CRITERION 3
    // "Trust: the system logs all supplier data changes."
    // Read through the admin audit API, which is a stronger proof than the
    // store's own lookup: it shows the entry is really on the trail an auditor
    // would consult.
    const entries = await auditEntries();
    const createdEntry = findEntry(entries, "suppliers.created", supplierId);
    assert.ok(createdEntry, "the create must be on the audit trail");
    assert.strictEqual(createdEntry.outcome, "success");
    assert.strictEqual(createdEntry.actor, ADVISOR_USER);

    const updatedEntry = findEntry(entries, "suppliers.updated", supplierId);
    assert.ok(updatedEntry, "the update must be on the audit trail");
    assert.deepStrictEqual(
      updatedEntry.context.fields.slice().sort(),
      ["contactPhone", "rates"]
    );
    // The before/after pair is what makes the trail answer "what changed?"
    // rather than merely "something did".
    assert.strictEqual(updatedEntry.context.before.contactPhone, "+255 27 254 0000");
    assert.strictEqual(updatedEntry.context.after.contactPhone, "+255 27 254 9999");
    assert.deepStrictEqual(updatedEntry.context.ratesChanged, ["TZ-SERENA-2026"]);
    console.log("suppliers http: criterion 3 - changes are on the trail an admin reads");

    // A REFUSED CHANGE IS ALSO ON THE TRAIL. This is the reason the route does
    // not validate contracts itself: a 400 raised here would lose this entry,
    // and "the supplier was not added" would become invisible.
    const refusedRes = await call("/api/suppliers", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: sampleSupplier({
        name: "Orphan Rate Lodge",
        rates: [
          {
            contractRef: "TZ-NOT-SIGNED",
            description: "Room, full board",
            currency: "USD",
            amountCents: 48000,
            unit: "per_person_per_night",
          },
        ],
      }),
    });
    assert.strictEqual(refusedRes.status, 400);
    const refused = await readBody(refusedRes);
    assert.strictEqual(refused.error, "invalid_supplier");
    assert.ok(
      refused.problems.some(function (problem) {
        return problem.includes("no contract on this supplier matches the reference");
      }),
      "the problem list should reach the caller so the form is fixed in one pass"
    );
    assert.ok(
      (await auditEntries()).some(function (entry) {
        return entry.event === "suppliers.refused";
      }),
      "a refused supplier must leave a trace"
    );
    console.log("suppliers http: a refused supplier returns 400 and is still audited");

    // ===================================================== AUTHORIZATION
    // The permission each route declares is the one enforced. The advisor is
    // the ONLY role that reaches any of this, so every other role is checked
    // against every route - read AND write.

    const ROUTES = [
      { method: "GET", path: "/api/suppliers" },
      { method: "GET", path: "/api/suppliers/" + supplierId },
      { method: "POST", path: "/api/suppliers", body: sampleSupplier({ name: "Hijack Lodge" }) },
      { method: "PATCH", path: "/api/suppliers/" + supplierId, body: { notes: "hijacked" } },
    ];

    for (const token of [CUSTOMER_TOKEN, SALES_TOKEN, ADMIN_TOKEN, PM_TOKEN]) {
      for (const route of ROUTES) {
        const res = await call(route.path, {
          method: route.method,
          token: token,
          body: route.body,
        });
        assert.strictEqual(
          res.status,
          403,
          route.method + " " + route.path + " should be 403 for this role, got " + res.status
        );
        await readBody(res);
      }
    }
    console.log("suppliers http: every role except the advisor is refused on every route");

    // No token at all, and a token that is not a token. 401, not 403: the
    // caller has not been identified, which is a different answer from "we know
    // who you are and you may not".
    for (const route of ROUTES) {
      const anonymous = await call(route.path, { method: route.method, body: route.body });
      assert.strictEqual(anonymous.status, 401, route.path + " should be 401 without a token");
      await readBody(anonymous);

      const bogus = await call(route.path, {
        method: route.method,
        token: "not-a-real-token",
        body: route.body,
      });
      assert.strictEqual(bogus.status, 401, route.path + " should be 401 with a bogus token");
      await readBody(bogus);
    }
    console.log("suppliers http: an unidentified caller gets 401, not 403");

    // NOTHING THOSE ATTEMPTS TRIED TO DO HAPPENED. Checking the status code is
    // not enough - a route that 403s after calling the service would pass every
    // assertion above and still have written the row.
    const afterRefusals = await readBody(await call("/api/suppliers", { token: ADVISOR_TOKEN }));
    assert.strictEqual(afterRefusals.count, 1, "a refused caller created a supplier anyway");
    assert.strictEqual(
      afterRefusals.suppliers[0].notes,
      null,
      "a refused caller edited a supplier anyway"
    );
    assert.strictEqual(afterRefusals.suppliers[0].version, 2, "a refused caller bumped the version");
    console.log("suppliers http: a refused request changed nothing, not just its status code");

    // THE COST BASE NEVER REACHED A CUSTOMER. The broadest form of the check:
    // across every response body this suite collected, no rate figure appears
    // in anything a non-advisor was handed. Asserted over the raw text, because
    // a leak through a key nobody thought to check is the kind that ships.
    const customerFacing = [];
    for (const route of ROUTES) {
      const res = await call(route.path, {
        method: route.method,
        token: CUSTOMER_TOKEN,
        body: route.body,
      });
      customerFacing.push(await res.text());
    }
    const customerPayload = customerFacing.join("\n");
    assert.ok(!customerPayload.includes("48000"), "a supplier rate reached a customer");
    assert.ok(!customerPayload.includes("52000"), "a supplier rate reached a customer");
    assert.ok(!customerPayload.includes("TZ-SERENA-2026"), "a contract ref reached a customer");
    assert.ok(!/amountCents|contractRef|rates/i.test(customerPayload), "a supplier key leaked");
    console.log("suppliers http: no rate, contract or cost figure reaches a customer");

    // ===================================================== MALFORMED REQUESTS
    // Everything here must be a 4xx, never a 500. A 500 on a crafted URL is
    // how a scanner finds the interesting part of an API.

    const badBody = await call("/api/suppliers", {
      method: "POST",
      token: ADVISOR_TOKEN,
      body: ["not", "an", "object"],
    });
    assert.strictEqual(badBody.status, 400);
    assert.strictEqual((await readBody(badBody)).error, "invalid_request_body");

    // decodeURIComponent THROWS on a bare "%". Unguarded this is a 500.
    const badId = await call("/api/suppliers/%", { token: ADVISOR_TOKEN });
    assert.strictEqual(badId.status, 400, "a malformed path parameter must be 400, never 500");
    assert.strictEqual((await readBody(badId)).error, "invalid_supplier_id");

    const unknownId = await call("/api/suppliers/supplier_nope", { token: ADVISOR_TOKEN });
    assert.strictEqual(unknownId.status, 404);
    assert.strictEqual((await readBody(unknownId)).error, "unknown_supplier");

    const unknownPatch = await call("/api/suppliers/supplier_nope", {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: { notes: "x" },
    });
    assert.strictEqual(unknownPatch.status, 404);

    // 409, not 400: well-formed, but it collided with a supplier that exists.
    const kenya = await readBody(
      await call("/api/suppliers", {
        method: "POST",
        token: ADVISOR_TOKEN,
        body: sampleSupplier({
          country: "Kenya",
          contracts: [
            {
              contractRef: "KE-SERENA-2026",
              startDate: "2026-01-01",
              endDate: "2026-12-31",
              currency: "USD",
              status: "active",
            },
          ],
          rates: [],
        }),
      })
    );
    const collision = await call("/api/suppliers/" + kenya.supplier.supplierId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: { country: "Tanzania" },
    });
    assert.strictEqual(collision.status, 409, "a duplicate is 409, distinguishable from a 400");
    assert.strictEqual((await readBody(collision)).error, "duplicate_supplier");

    // A patch naming nothing editable, and one naming a field that is not.
    const emptyPatch = await call("/api/suppliers/" + supplierId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: {},
    });
    assert.strictEqual(emptyPatch.status, 400);
    assert.strictEqual((await readBody(emptyPatch)).error, "empty_update");

    const notEditable = await call("/api/suppliers/" + supplierId, {
      method: "PATCH",
      token: ADVISOR_TOKEN,
      body: { createdBy: "ADV-9" },
    });
    assert.strictEqual(notEditable.status, 400);
    assert.strictEqual((await readBody(notEditable)).error, "unknown_fields");
    console.log("suppliers http: malformed and conflicting requests are 4xx, never 500");

    // NO RESPONSE THIS SUITE SAW CARRIED A SECRET. A blanket check over every
    // body collected, because a token echoed into an error message is the kind
    // of leak that ships.
    const everything = bodies.join("\n");
    assert.ok(!everything.includes(ADVISOR_TOKEN), "an auth token was echoed in a response");
    assert.ok(!everything.includes(ADMIN_TOKEN), "an auth token was echoed in a response");
    assert.ok(!everything.includes(PASSWORD), "a password was echoed in a response");
    console.log("suppliers http: no token or password appears in any response body");

    console.log("suppliers http: all tests passed");
  } finally {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
    __resetSuppliersForTests();
    __resetAssignmentsForTests();
  }
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
