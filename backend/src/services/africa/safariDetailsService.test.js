const assert = require("assert");
const { getSafariDetails } = require("./safariDetailsService");
const { getLoggedInteractions } = require("./interactionLog");

// Happy path: known destination -> full safari details returned and logged.
const result = getSafariDetails({
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
const unsupported = getSafariDetails({
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
getSafariDetails({ customerId: "CUST-1", destinationId: "SF-300", interactionKey: "INTERACTION-TEST-1" });
const loggedAgain = getLoggedInteractions().filter(function (i) {
  return i.interactionKey === "INTERACTION-TEST-1";
});
assert.strictEqual(loggedAgain.length, 1);

console.log("safariDetailsService: interaction logging idempotency test passed");

// Failure path: destination exists but details are incomplete -> flagged, not partial data.
const incomplete = getSafariDetails({
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
