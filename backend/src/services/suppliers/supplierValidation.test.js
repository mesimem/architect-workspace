// STORY-010, the identity half and the whole-record orchestration.
//
// TWO THINGS ARE TESTED HERE. First, supplier identity: name, country, type,
// and the rule that a supplier must have at least one way to be contacted.
// Second - and this is the part worth the file - that validateSupplier actually
// RUNS the commercial checks that supplierContracts.js owns. Those checks are
// tested on their own in supplierContracts.test.js; the tests below re-assert a
// representative fault of each kind THROUGH a whole supplier record, because a
// correct check that is never called passes its own unit test and still ships
// the bug.
//
// The story's "data mismatch" failure path is therefore covered twice on
// purpose, at two different altitudes. The other two failure paths are
// properties of storage and of the boundary: "supplier not added" and "update
// failure" are tested in supplierStore.test.js and http/suppliers.test.js,
// where they live.

const assert = require("assert");

const { validateSupplier, looksLikeEmail, MAX_NAME_LENGTH } = require("./supplierValidation");

// A realistic lodge supplier: one active 2026 contract, two rates under it.
function sampleSupplier() {
  return {
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
      {
        contractRef: "TZ-SERENA-2026",
        description: "Airport transfer, Seronera airstrip",
        currency: "USD",
        amountCents: 12000,
        unit: "per_transfer",
      },
    ],
  };
}

// Finds the one problem matching a fragment, and asserts exactly one matched.
// Asserting on the COUNT as well as the presence is what catches a check that
// fires twice for one fault - which is how a problem list stops being readable.
function onlyProblem(problems, fragment) {
  const matching = problems.filter(function (problem) {
    return problem.includes(fragment);
  });
  assert.strictEqual(
    matching.length,
    1,
    "expected exactly one problem containing " +
      JSON.stringify(fragment) +
      ", got " +
      JSON.stringify(problems)
  );
  return matching[0];
}

function main() {
  // HAPPY PATH: a complete supplier has no problems at all.
  assert.deepStrictEqual(validateSupplier(sampleSupplier()), []);
  console.log("supplierValidation: a complete supplier validates clean");

  // DETERMINISM. No clock, no store, no randomness - the same supplier
  // validates the same way on a retry and in a year, which is what lets a
  // refusal be reproduced from the submitted body alone.
  assert.deepStrictEqual(validateSupplier(sampleSupplier()), validateSupplier(sampleSupplier()));
  console.log("supplierValidation: the same supplier always validates the same way");

  // ----- THE COMMERCIAL CHECKS ARE ACTUALLY WIRED IN -----------------------
  // One representative fault of each kind, driven through a whole record. The
  // checks themselves are proved in supplierContracts.test.js; these prove
  // validateSupplier calls them.

  const inverted = sampleSupplier();
  inverted.contracts[0].endDate = "2025-01-01";
  onlyProblem(validateSupplier(inverted), "endDate must be after startDate");
  console.log("supplierValidation: an inverted contract fails the whole record");

  const duplicateRef = sampleSupplier();
  duplicateRef.contracts.push({
    contractRef: "tz-serena-2026 ",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
    currency: "USD",
    status: "draft",
  });
  onlyProblem(
    validateSupplier(duplicateRef),
    "more than one contract uses the reference TZ-SERENA-2026"
  );
  console.log("supplierValidation: a duplicate contract reference fails the whole record");

  const orphan = sampleSupplier();
  orphan.rates[1].contractRef = "TZ-SERENA-2025";
  onlyProblem(
    validateSupplier(orphan),
    "no contract on this supplier matches the reference TZ-SERENA-2025"
  );
  console.log("supplierValidation: an orphan rate fails the whole record");

  const currencyClash = sampleSupplier();
  currencyClash.contracts[0].currency = "EUR";
  onlyProblem(
    validateSupplier(currencyClash),
    "rates: currency does not match the contract it is quoted under for TZ-SERENA-2026"
  );
  console.log("supplierValidation: a rate disagreeing with its contract fails the whole record");

  // A supplier renewing for a second season holds two contracts at once. That
  // is normal, and a validator that called it a conflict would be the bug.
  const twoContracts = sampleSupplier();
  twoContracts.contracts.push({
    contractRef: "TZ-SERENA-2027",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
    currency: "USD",
    status: "draft",
  });
  assert.deepStrictEqual(validateSupplier(twoContracts), []);
  console.log("supplierValidation: a supplier may hold two contracts at once");

  // A contract signed before its rate card is agreed is a real, ordinary state.
  const noRates = sampleSupplier();
  noRates.rates = [];
  assert.deepStrictEqual(validateSupplier(noRates), []);
  // Absent is a different thing from empty: one is "no rates agreed", the other
  // is a caller who forgot the field, and treating them alike hides a bug.
  const missingRates = sampleSupplier();
  delete missingRates.rates;
  onlyProblem(validateSupplier(missingRates), "rates must be an array of rate entries");
  console.log("supplierValidation: no rates yet is allowed, a missing rates field is not");

  // ----- THE PROBLEM LIST IS COMPLETE, NOT FIRST-FAULT ---------------------
  // The whole reason validateSupplier returns a list: an advisor fixing a
  // supplier with faults in all three parts should need one round trip. This
  // also proves the three validators' outputs are concatenated, not replaced.

  const manyFaults = sampleSupplier();
  manyFaults.name = "   ";
  manyFaults.contracts[0].endDate = "2025-01-01";
  manyFaults.rates[0].amountCents = 0;
  manyFaults.rates[1].contractRef = "NOPE-2026";
  const manyProblems = validateSupplier(manyFaults);
  onlyProblem(manyProblems, "name is required");
  onlyProblem(manyProblems, "endDate must be after startDate");
  onlyProblem(manyProblems, "rates[0]: amountCents must be a whole number of cents above 0");
  onlyProblem(manyProblems, "no contract on this supplier matches the reference NOPE-2026");
  console.log("supplierValidation: identity, contract and rate faults all report in one pass");

  // ----- IDENTITY ----------------------------------------------------------

  const blankCountry = sampleSupplier();
  blankCountry.country = "  ";
  onlyProblem(validateSupplier(blankCountry), "country is required and must not be blank");
  console.log("supplierValidation: a blank country is refused");

  const badType = sampleSupplier();
  badType.supplierType = "Lodge";
  onlyProblem(validateSupplier(badType), "supplierType must be one of");
  console.log("supplierValidation: supplierType is an allow-list, not free text");

  const longName = sampleSupplier();
  longName.name = "a".repeat(MAX_NAME_LENGTH + 1);
  onlyProblem(validateSupplier(longName), "name must be at most");
  console.log("supplierValidation: an over-long name is refused");

  // AT LEAST ONE CONTACT. A supplier nobody can reach cannot be chased when a
  // booking goes wrong, which is the entire reason an advisor opens the record.
  const noContact = sampleSupplier();
  delete noContact.contactEmail;
  delete noContact.contactPhone;
  onlyProblem(
    validateSupplier(noContact),
    "at least one of contactEmail or contactPhone is required"
  );
  console.log("supplierValidation: a supplier with no way to reach them is refused");

  // Either one alone is enough - a lodge that only answers the phone is real.
  const phoneOnly = sampleSupplier();
  delete phoneOnly.contactEmail;
  assert.deepStrictEqual(validateSupplier(phoneOnly), []);
  const emailOnly = sampleSupplier();
  delete emailOnly.contactPhone;
  assert.deepStrictEqual(validateSupplier(emailOnly), []);
  console.log("supplierValidation: either contact method alone is enough");

  // The fault that actually happens: a phone number typed into the email box.
  const phoneInEmail = sampleSupplier();
  phoneInEmail.contactEmail = "+255 27 254 0000";
  onlyProblem(validateSupplier(phoneInEmail), "contactEmail must look like an email address");
  console.log("supplierValidation: a non-address in the email field is refused");

  // Plus-addressing and a long subdomain are REAL addresses. A stricter pattern
  // that rejected them would stop an advisor saving a supplier that exists,
  // which is worse than accepting an address that later bounces.
  assert.strictEqual(looksLikeEmail("bookings+safari@res.east-africa.serena.example"), true);
  assert.strictEqual(looksLikeEmail("a@b.co"), true);
  assert.strictEqual(looksLikeEmail("reservations@serena"), false);
  assert.strictEqual(looksLikeEmail("two words@serena.example"), false);
  assert.strictEqual(looksLikeEmail("@serena.example"), false);
  assert.strictEqual(looksLikeEmail("reservations@@serena.example"), false);
  const plusAddress = sampleSupplier();
  plusAddress.contactEmail = "bookings+safari@res.east-africa.serena.example";
  assert.deepStrictEqual(validateSupplier(plusAddress), []);
  console.log("supplierValidation: legitimate unusual addresses are accepted");

  // ----- UNKNOWN FIELDS AND PROTOTYPE-CHAIN KEYS ---------------------------
  // A body of { "constructor": ... } arrives from a request more often than
  // anyone expects. An unknown field is reported BY NAME rather than dropped,
  // because a silently dropped "contactMail" is a field the advisor believes
  // they saved.

  const typo = sampleSupplier();
  typo.contactMail = "oops@example.com";
  onlyProblem(validateSupplier(typo), "supplier: unknown fields: contactMail");
  console.log("supplierValidation: a mistyped field name is refused by name, not dropped");

  const prototypeKey = sampleSupplier();
  prototypeKey.constructor = "nope";
  onlyProblem(validateSupplier(prototypeKey), "unknown fields: constructor");
  console.log("supplierValidation: a prototype-chain key is treated as an unknown field");

  // Inherited keys are NOT own keys and must not be reported - otherwise every
  // object literal would fail on toString.
  assert.deepStrictEqual(validateSupplier(sampleSupplier()), []);

  // ----- NON-OBJECT INPUTS -------------------------------------------------
  // Everything here arrives from an HTTP body, so none of it may throw.

  [null, undefined, 42, "supplier", [], true].forEach(function (value) {
    const problems = validateSupplier(value);
    assert.ok(problems.length > 0, "expected problems for " + JSON.stringify(value));
    assert.ok(problems[0].startsWith("supplier must be an object"));
  });
  console.log("supplierValidation: a non-object supplier is refused, never thrown on");

  // The problem text describes the SHAPE of a bad value, never the value. A
  // supplier record carries contact details, and these strings reach an HTTP
  // response and the logs.
  const leaky = sampleSupplier();
  leaky.supplierType = "secret-internal-code";
  const leakyProblem = onlyProblem(validateSupplier(leaky), "supplierType must be one of");
  assert.ok(!leakyProblem.includes("secret-internal-code"), "the bad value was echoed back");
  console.log("supplierValidation: a refusal never echoes the submitted value back");

  console.log("supplierValidation: all tests passed");
}

main();
