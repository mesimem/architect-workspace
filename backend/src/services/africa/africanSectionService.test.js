const assert = require("assert");
const { listAfricanDestinations } = require("./africanSectionService");
const { getSafariDetails } = require("./safariDetailsService");
const { getLoggedInteractions } = require("./interactionLog");

function loggedFor(key) {
  return getLoggedInteractions().filter(function (i) {
    return i.interactionKey === key;
  });
}

async function main() {
  // Happy path: navigating to the section lists every African destination as a
  // summary row, and the visit is logged.
  const listed = await listAfricanDestinations({
    customerId: "CUST-1",
    interactionKey: "SECTION-TEST-1",
  });

  assert.strictEqual(listed.status, "ok");
  assert.strictEqual(listed.destinations.length, 2);

  const serengeti = listed.destinations.find(function (d) {
    return d.destinationId === "SF-300";
  });
  assert.strictEqual(serengeti.name, "Serengeti Migration Safari");
  assert.strictEqual(serengeti.country, "Tanzania");
  assert.strictEqual(serengeti.detailsComplete, true);
  // Summary only - full detail is getSafariDetails()'s job, not the list's.
  assert.strictEqual(serengeti.priceUSD, undefined);

  const logged = loggedFor("SECTION-TEST-1");
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].outcome, "browsed");
  assert.strictEqual(logged[0].action, "browse_section");
  assert.strictEqual(logged[0].destinationCount, 2);

  console.log("africanSectionService: happy path (browse the section) test passed");

  // A destination whose record is unfinished is still listed, but flagged, so
  // the caller can warn before the customer clicks into it.
  const kilimanjaro = listed.destinations.find(function (d) {
    return d.destinationId === "SF-301";
  });
  assert.strictEqual(kilimanjaro.detailsComplete, false);

  console.log("africanSectionService: incomplete destination is flagged, not hidden");

  // The two surfaces agree: a row flagged detailsComplete:false is exactly the
  // row whose detail view returns "incomplete". This is the join the customer
  // actually walks - browse the section, then select a safari.
  const detail = await getSafariDetails({
    customerId: "CUST-1",
    destinationId: kilimanjaro.destinationId,
    interactionKey: "SECTION-TEST-2",
  });
  assert.strictEqual(detail.status, "incomplete");

  const completeDetail = await getSafariDetails({
    customerId: "CUST-1",
    destinationId: serengeti.destinationId,
    interactionKey: "SECTION-TEST-3",
  });
  assert.strictEqual(completeDetail.status, "ok");

  console.log("africanSectionService: list flag agrees with the detail view");

  // The returned list must not be a window into the catalog.
  listed.destinations[0].name = "MUTATED";
  const reread = await listAfricanDestinations({
    customerId: "CUST-1",
    interactionKey: "SECTION-TEST-4",
  });
  assert.ok(
    reread.destinations.every(function (d) {
      return d.name !== "MUTATED";
    })
  );

  console.log("africanSectionService: returned rows are copies, not catalog references");

  // Idempotency: the same interactionKey logs once, not twice.
  await listAfricanDestinations({ customerId: "CUST-1", interactionKey: "SECTION-TEST-1" });
  assert.strictEqual(loggedFor("SECTION-TEST-1").length, 1);

  console.log("africanSectionService: interaction logging idempotency test passed");

  // Boundary: an empty catalog is a real state, not an error. Status stays ok,
  // the list is empty, and the customer gets an explanation instead of a blank.
  const emptyList = await listAfricanDestinations({
    customerId: "CUST-2",
    interactionKey: "SECTION-TEST-5",
    source: async function () {
      return [];
    },
  });

  assert.strictEqual(emptyList.status, "ok");
  assert.deepStrictEqual(emptyList.destinations, []);
  assert.strictEqual(
    emptyList.message,
    "No African destinations are listed right now — contact an advisor to plan a trip."
  );
  assert.strictEqual(loggedFor("SECTION-TEST-5")[0].destinationCount, 0);

  console.log("africanSectionService: empty-catalog boundary test passed");

  // Failure path: system timeout. Retried once, capped, then handed to an
  // advisor - and never a partial list.
  let hangingCalls = 0;
  const timedOut = await listAfricanDestinations({
    customerId: "CUST-3",
    interactionKey: "SECTION-TEST-6",
    source: function () {
      hangingCalls += 1;
      return new Promise(function () {}); // never settles
    },
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(timedOut.status, "timeout");
  assert.strictEqual(timedOut.destinations, undefined);
  assert.strictEqual(hangingCalls, 2);
  assert.strictEqual(loggedFor("SECTION-TEST-6")[0].outcome, "timeout");

  console.log("africanSectionService: system-timeout failure path test passed");

  // Failure path: a source that throws is not retried and reads as unavailable.
  let brokenCalls = 0;
  const unavailable = await listAfricanDestinations({
    customerId: "CUST-4",
    interactionKey: "SECTION-TEST-7",
    source: function () {
      brokenCalls += 1;
      return Promise.reject(new Error("connection refused"));
    },
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(unavailable.status, "unavailable");
  assert.strictEqual(brokenCalls, 1);
  assert.strictEqual(loggedFor("SECTION-TEST-7")[0].outcome, "unavailable");

  console.log("africanSectionService: broken-source (no retry) failure path test passed");

  // A source that resolves to a non-array must fail loudly rather than render
  // as an empty section.
  const wrongShape = await listAfricanDestinations({
    customerId: "CUST-5",
    interactionKey: "SECTION-TEST-8",
    source: async function () {
      return { destinations: "oops" };
    },
  });

  assert.strictEqual(wrongShape.status, "unavailable");
  assert.strictEqual(wrongShape.destinations, undefined);
  assert.strictEqual(loggedFor("SECTION-TEST-8")[0].outcome, "unavailable");

  console.log("africanSectionService: wrong-shape source is rejected, not shown as empty");

  // Browsing is refused too when the interaction cannot be audited - checked
  // before the catalog is read, so no list is produced off the record.
  let listSourceCalls = 0;
  const countBefore = getLoggedInteractions().length;

  const refused = await listAfricanDestinations({
    customerId: "CUST-6",
    interactionKey: undefined,
    source: function () {
      listSourceCalls += 1;
      return Promise.resolve([]);
    },
  });

  assert.strictEqual(refused.status, "invalid_request");
  assert.strictEqual(refused.destinations, undefined);
  assert.strictEqual(listSourceCalls, 0);
  assert.strictEqual(getLoggedInteractions().length, countBefore);

  console.log("africanSectionService: invalid interaction key is refused before any read");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
