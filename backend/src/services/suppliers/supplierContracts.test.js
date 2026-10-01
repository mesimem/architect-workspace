// STORY-010, the commercial half: contracts, rates, and whether they agree.
//
// The story's "data mismatch" failure path is tested here at the unit level -
// each check driven directly, with no supplier record around it - and again in
// supplierValidation.test.js through the whole-record orchestration. That
// overlap is deliberate: one proves the check works, the other proves it is
// actually wired in. A check that is correct and never called passes the first
// kind of test and ships the bug.
//
// Every one of these faults looks completely normal on screen: a contract that
// ends before it starts reads like two ordinary dates, an orphan rate reads
// like an ordinary price. So each is asserted by hand, with the expected
// problem text written out rather than recomputed from the implementation's own
// strings. A test that restates the code cannot catch the code being wrong.

const assert = require("assert");

const {
  validateContracts,
  validateRates,
  crossReferenceProblems,
  normaliseContracts,
  normaliseRates,
  normaliseRef,
  isCalendarDate,
  MAX_CONTRACTS,
  MAX_RATES,
} = require("./supplierContracts");

// One active 2026 contract, and two rates quoted under it.
function sampleContracts() {
  return [
    {
      contractRef: "TZ-SERENA-2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      currency: "USD",
      status: "active",
    },
  ];
}

function sampleRates() {
  return [
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
  ];
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
  // HAPPY PATH.
  assert.deepStrictEqual(validateContracts(sampleContracts()), []);
  assert.deepStrictEqual(validateRates(sampleRates()), []);
  assert.deepStrictEqual(crossReferenceProblems(sampleContracts(), sampleRates()), []);
  console.log("supplierContracts: a well-formed contract and rate card validate clean");

  // ----- CALENDAR DATES ----------------------------------------------------
  // The reason this is hand-rolled rather than handed to `new Date()`:
  // 2026-02-30 becomes March 2nd if you let the Date constructor near it, and
  // that is how an impossible contract date gets stored as a plausible one.

  assert.strictEqual(isCalendarDate("2026-02-30"), false);
  assert.strictEqual(isCalendarDate("2026-04-31"), false);
  assert.strictEqual(isCalendarDate("2026-13-01"), false);
  assert.strictEqual(isCalendarDate("2026-00-10"), false);
  assert.strictEqual(isCalendarDate("2026-01-00"), false);
  assert.strictEqual(isCalendarDate("26-04-01"), false);
  assert.strictEqual(isCalendarDate("2026-04-01T00:00:00Z"), false);
  assert.strictEqual(isCalendarDate("2026-4-1"), false);
  assert.strictEqual(isCalendarDate(20260401), false);
  assert.strictEqual(isCalendarDate(null), false);
  assert.strictEqual(isCalendarDate("2026-04-01"), true);
  assert.strictEqual(isCalendarDate("2026-12-31"), true);
  // Allowed every year on purpose - see the note in isCalendarDate. Being
  // loose here cannot refuse a valid contract; being strict could.
  assert.strictEqual(isCalendarDate("2026-02-29"), true);
  console.log("supplierContracts: impossible calendar dates are refused, real ones accepted");

  // ----- MISMATCH 1: a contract that ends before it starts ------------------

  const inverted = sampleContracts();
  inverted[0].startDate = "2026-12-31";
  inverted[0].endDate = "2026-01-01";
  onlyProblem(validateContracts(inverted), "contracts[0]: endDate must be after startDate");
  console.log("supplierContracts: a contract ending before it starts is refused");

  // Same day start and end is zero days of cover, not a one-day contract. The
  // usual cause is a form that defaulted both fields and only one got edited.
  const sameDay = sampleContracts();
  sameDay[0].startDate = "2026-05-01";
  sameDay[0].endDate = "2026-05-01";
  onlyProblem(validateContracts(sameDay), "endDate must be after startDate");
  console.log("supplierContracts: a contract covering zero days is refused");

  // A malformed date is reported ONCE. The ordering check stays silent, because
  // the date it would compare against is already reported as unusable and a
  // second problem about one fault is noise.
  const impossible = sampleContracts();
  impossible[0].endDate = "2026-02-30";
  const impossibleProblems = validateContracts(impossible);
  onlyProblem(impossibleProblems, "endDate must be a calendar date");
  assert.deepStrictEqual(
    impossibleProblems.filter(function (problem) {
      return problem.includes("must be after startDate");
    }),
    []
  );
  console.log("supplierContracts: a malformed date is reported once, not twice");

  // ----- MISMATCH 2: two contracts sharing a reference ---------------------

  const duplicateRef = sampleContracts();
  duplicateRef.push({
    contractRef: "tz-serena-2026 ",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
    currency: "USD",
    status: "draft",
  });
  // Case and surrounding space do not make it a different agreement - the
  // duplicate check is only as good as normaliseRef, so this asserts both.
  onlyProblem(
    crossReferenceProblems(duplicateRef, []),
    "more than one contract uses the reference TZ-SERENA-2026"
  );
  console.log("supplierContracts: two contracts under one reference are refused");

  // Two DIFFERENT references is the normal case - a supplier renewing for a
  // second season holds both at once, and refusing that would be a bug.
  const twoContracts = sampleContracts();
  twoContracts.push({
    contractRef: "TZ-SERENA-2027",
    startDate: "2027-01-01",
    endDate: "2027-12-31",
    currency: "USD",
    status: "draft",
  });
  assert.deepStrictEqual(validateContracts(twoContracts), []);
  assert.deepStrictEqual(crossReferenceProblems(twoContracts, sampleRates()), []);
  console.log("supplierContracts: a supplier may hold two contracts at once");

  // ----- MISMATCH 3: an orphan rate ----------------------------------------
  // The one that actually costs money: a price with no agreement behind it
  // still looks quotable.

  const orphanRates = sampleRates();
  orphanRates[1].contractRef = "TZ-SERENA-2025";
  onlyProblem(
    crossReferenceProblems(sampleContracts(), orphanRates),
    "no contract on this supplier matches the reference TZ-SERENA-2025"
  );
  console.log("supplierContracts: a rate with no matching contract is refused");

  // A rate whose ref differs only in case is NOT an orphan. Refusing it would
  // reject correct data, which is the more expensive direction to be wrong in.
  const casedRates = sampleRates();
  casedRates[0].contractRef = " tz-serena-2026 ";
  assert.deepStrictEqual(crossReferenceProblems(sampleContracts(), casedRates), []);
  console.log("supplierContracts: a rate reference matches its contract case-insensitively");

  // ----- MISMATCH 4: a rate in the wrong currency --------------------------
  // CURRENCIES is ["USD"] today, so this cannot be staged with two currencies
  // the system accepts. Driving crossReferenceProblems directly is what makes
  // it testable at all: the contract is denominated in a currency the system
  // does not know, the rate in one it does, and the comparison is the thing
  // under test. When a second currency joins CURRENCIES this test keeps
  // passing and the realistic version becomes expressible.
  const eurContract = sampleContracts();
  eurContract[0].currency = "EUR";
  onlyProblem(
    crossReferenceProblems(eurContract, sampleRates()),
    "rates: currency does not match the contract it is quoted under for TZ-SERENA-2026"
  );
  console.log("supplierContracts: a rate disagreeing with its contract's currency is refused");

  // An UNKNOWN rate currency is reported once, by the rate's own check - the
  // cross-check stays silent rather than adding a second complaint about one
  // field.
  const unknownCurrency = sampleRates();
  unknownCurrency[0].currency = "EUR";
  onlyProblem(validateRates(unknownCurrency), "rates[0]: currency must be one of USD");
  assert.deepStrictEqual(
    crossReferenceProblems(sampleContracts(), unknownCurrency).filter(function (problem) {
      return problem.includes("does not match the contract");
    }),
    []
  );
  console.log("supplierContracts: an unknown rate currency is reported once, by its own check");

  // The cross-checks SKIP entries that failed their own validation. An entry
  // whose contractRef is undefined cannot be a duplicate of anything, and
  // reporting it twice is noise.
  assert.deepStrictEqual(crossReferenceProblems([{}, {}, null, 7], []), []);
  assert.deepStrictEqual(crossReferenceProblems(sampleContracts(), [{}, null]), []);
  console.log("supplierContracts: the cross-checks skip entries already reported as broken");

  // ----- SHAPE -------------------------------------------------------------

  // A supplier with no contract is a lead, not a supplier. REQ-012 is
  // "including contracts and rates"; if this were optional the field would be
  // a suggestion.
  assert.deepStrictEqual(validateContracts([]), [
    "contracts must be a non-empty array of contract entries",
  ]);
  assert.deepStrictEqual(validateContracts(undefined), [
    "contracts must be a non-empty array of contract entries",
  ]);
  assert.deepStrictEqual(validateContracts("TZ-SERENA-2026"), [
    "contracts must be a non-empty array of contract entries",
  ]);
  console.log("supplierContracts: a supplier must hold at least one contract");

  // Rates MAY be empty, and the asymmetry is deliberate: an agreement is often
  // signed before its rate card is agreed, and refusing to record it until
  // then pushes an advisor to invent a figure.
  assert.deepStrictEqual(validateRates([]), []);
  // ... but absent is a different thing from empty: one is "no rates agreed",
  // the other is a caller who forgot the field.
  assert.deepStrictEqual(validateRates(undefined), ["rates must be an array of rate entries"]);
  console.log("supplierContracts: no rates yet is allowed, a missing rates field is not");

  assert.deepStrictEqual(validateContracts(new Array(MAX_CONTRACTS + 1).fill({})), [
    "contracts must have at most " + MAX_CONTRACTS + " entries",
  ]);
  assert.deepStrictEqual(validateRates(new Array(MAX_RATES + 1).fill({})), [
    "rates must have at most " + MAX_RATES + " entries",
  ]);
  console.log("supplierContracts: absurd contract and rate counts are refused");

  // A non-object entry is refused without throwing - everything here arrives
  // from an HTTP body.
  [null, 42, "contract", [], true].forEach(function (value) {
    const problems = validateContracts([value]);
    assert.ok(problems.length > 0, "expected problems for " + JSON.stringify(value));
    assert.ok(problems[0].startsWith("contracts[0]: must be an object"));
  });
  console.log("supplierContracts: a non-object entry is refused, never thrown on");

  // ----- PER-ENTRY RULES ---------------------------------------------------

  const badStatus = sampleContracts();
  badStatus[0].status = "Active";
  onlyProblem(validateContracts(badStatus), "contracts[0]: status must be one of");
  console.log("supplierContracts: status is an allow-list, not free text");

  const badUnit = sampleRates();
  badUnit[0].unit = "per night";
  onlyProblem(validateRates(badUnit), "rates[0]: unit must be one of");
  console.log("supplierContracts: unit is an allow-list, not free text");

  // Money: whole cents above zero. A rate of zero is either a freebie that
  // belongs in the contract notes or a field someone left blank, and storing
  // it as a price means it can be quoted from.
  [0, -1, 4.5, "48000", null, NaN, Infinity, 1e21].forEach(function (value) {
    const rates = sampleRates();
    rates[0].amountCents = value;
    onlyProblem(validateRates(rates), "rates[0]: amountCents must be a whole number of cents above 0");
  });
  console.log("supplierContracts: a rate must be whole cents above zero");

  // An unknown field is reported BY NAME rather than dropped, because a
  // silently dropped "amount" is a figure the advisor believes they saved.
  const typo = sampleRates();
  typo[0].amount = 48000;
  onlyProblem(validateRates(typo), "rates[0]: unknown fields: amount");
  console.log("supplierContracts: a mistyped field name is refused by name, not dropped");

  const prototypeKey = sampleContracts();
  prototypeKey[0].constructor = "nope";
  onlyProblem(validateContracts(prototypeKey), "unknown fields: constructor");
  console.log("supplierContracts: a prototype-chain key is treated as an unknown field");

  // Inherited keys are NOT own keys and must not be reported - otherwise every
  // object literal would fail on toString.
  assert.deepStrictEqual(validateContracts(sampleContracts()), []);

  // The problem text describes the SHAPE of a bad value, never the value. A
  // rate description is prose written by a person and these strings reach an
  // HTTP response and the logs.
  const leaky = sampleContracts();
  leaky[0].startDate = "signed-under-NDA-ref-44182";
  const leakyProblem = onlyProblem(validateContracts(leaky), "startDate must be a calendar date");
  assert.ok(!leakyProblem.includes("NDA"), "the bad value was echoed back");
  console.log("supplierContracts: a refusal never echoes the submitted value back");

  // EVERY FAULT IN ONE PASS. The whole reason these return lists: an advisor
  // fixing three separate faults should need one round trip, not three.
  const manyFaults = sampleContracts();
  manyFaults[0].endDate = "2025-01-01";
  manyFaults[0].status = "nope";
  manyFaults[0].contractRef = "";
  const manyProblems = validateContracts(manyFaults);
  onlyProblem(manyProblems, "contractRef must be a non-empty string");
  onlyProblem(manyProblems, "endDate must be after startDate");
  onlyProblem(manyProblems, "status must be one of");
  console.log("supplierContracts: every fault is reported in one pass");

  // ----- NORMALISERS -------------------------------------------------------
  // Post-validation, no decisions. Sorting matters beyond tidiness: the store
  // compares contracts and rates structurally to decide whether an update
  // changed anything, so an unsorted normaliser would report a reordered rate
  // card as an edit.

  const contracts = normaliseContracts([
    {
      contractRef: " tz-serena-2027 ",
      startDate: "2027-01-01",
      endDate: "2027-12-31",
      currency: "USD",
      status: "draft",
      notes: "  Renewal pending signature.  ",
    },
    {
      contractRef: "TZ-SERENA-2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      currency: "USD",
      status: "active",
    },
  ]);
  assert.deepStrictEqual(
    contracts.map(function (entry) {
      return entry.contractRef;
    }),
    ["TZ-SERENA-2026", "TZ-SERENA-2027"]
  );
  assert.strictEqual(contracts[1].notes, "Renewal pending signature.");
  // Absent optional fields become null, so every stored contract has one shape
  // and a reader never has to ask whether a key is missing or empty.
  assert.strictEqual(contracts[0].notes, null);
  assert.ok(Object.isFrozen(contracts));
  assert.ok(Object.isFrozen(contracts[0]));
  console.log("supplierContracts: contracts normalise, sort, trim and freeze");

  const rates = normaliseRates([
    {
      contractRef: "TZ-SERENA-2026",
      description: "  Airport transfer  ",
      currency: "USD",
      amountCents: 12000,
      unit: "per_transfer",
    },
    {
      contractRef: "tz-serena-2026",
      description: "Standard double room",
      currency: "USD",
      amountCents: 48000,
      unit: "per_person_per_night",
    },
  ]);
  assert.deepStrictEqual(
    rates.map(function (entry) {
      return entry.description;
    }),
    ["Airport transfer", "Standard double room"]
  );
  assert.strictEqual(rates[1].contractRef, "TZ-SERENA-2026");
  assert.ok(Object.isFrozen(rates));
  assert.ok(Object.isFrozen(rates[0]));
  console.log("supplierContracts: rates normalise, sort, trim and freeze");

  // THE SAME RATE CARD IN A DIFFERENT ORDER NORMALISES IDENTICALLY. This is the
  // property the store's change detection rests on - without it, re-saving an
  // unedited supplier would be audited as an edit.
  assert.deepStrictEqual(normaliseRates(sampleRates()), normaliseRates(sampleRates().reverse()));
  assert.deepStrictEqual(
    normaliseContracts(sampleContracts()),
    normaliseContracts(sampleContracts().reverse())
  );
  console.log("supplierContracts: a reordered rate card normalises to the same thing");

  assert.strictEqual(normaliseRef("  tz-serena-2026 "), "TZ-SERENA-2026");
  assert.strictEqual(normaliseRef(""), "");
  assert.strictEqual(normaliseRef("   "), "");
  assert.strictEqual(normaliseRef(null), "");
  assert.strictEqual(normaliseRef(undefined), "");
  assert.strictEqual(normaliseRef(42), "");
  console.log("supplierContracts: contract references normalise case and space");

  console.log("supplierContracts: all tests passed");
}

main();
