// STORY-013: test fixtures for the proposal suites. TEST-ONLY - nothing in
// backend/src/http or any service requires this file.
//
// It exists because the three proposal suites (lifecycle, trust, durability)
// all need the same four fakes, and a store stub that behaves subtly
// differently in one suite than another is a way to get a green suite that
// proves nothing. Keeping them here also kept each suite under CLAUDE.md's
// 500-line ceiling without deleting cases to fit.
//
// THE CLOCK IS ALWAYS EXPLICIT. Every instant these fixtures produce is passed
// in by the caller: no test waits, and no assertion depends on how long the
// test itself took to run. A suite that measures a 30-minute SLA against a real
// clock is a suite that passes for 30 minutes and then starts failing.

// A Map-shaped store, like the real one but disposable per test.
function fakeStore() {
  const rows = new Map();
  return {
    get: rows.get.bind(rows),
    set: function (key, value) {
      rows.set(key, value);
      return this;
    },
    has: rows.has.bind(rows),
    delete: rows.delete.bind(rows),
    keys: rows.keys.bind(rows),
    values: rows.values.bind(rows),
    get size() {
      return rows.size;
    },
  };
}

// Accepts every write and keeps none - the SILENT save failure, which is the
// dangerous one: the advisor sees a confirmation and the row is not there.
function droppingStore() {
  const store = fakeStore();
  return { ...store, set: function () { return this; }, get: function () { return undefined; } };
}

// Records what was audited, so the trust criterion can be checked by CONTENT
// and not just by count.
function auditSpy() {
  const entries = [];
  const spy = function (entry) {
    entries.push(entry);
    return { entry: entry, replayed: false };
  };
  spy.entries = entries;
  spy.eventsFor = function (event) {
    return entries.filter(function (e) {
      return e.event === event;
    });
  };
  return spy;
}

function failingAudit() {
  return function () {
    const error = new Error("audit store unavailable");
    error.errorClass = "UpstreamUnavailable";
    throw error;
  };
}

// Watches the delay page without sending one. Injected everywhere a suite
// completes a LATE proposal, so no test reaches the real notifier's module-level
// outbox - a suite whose assertions depend on what an earlier block sent is a
// suite that passes in one order and fails in another.
function notifierSpy(result) {
  const calls = [];
  const spy = async function (args) {
    calls.push(args);
    return result || { status: "notified", notified: true, replayed: false, attempts: 1 };
  };
  spy.calls = calls;
  return spy;
}

// A clock the test drives, one instant per call, holding the last value.
function clockAt(instants) {
  let index = 0;
  return function () {
    const value = instants[Math.min(index, instants.length - 1)];
    index += 1;
    return value;
  };
}

// The instants every proposal suite works in. A draft opened at 09:00 is due at
// 09:30, so 09:12 is comfortably inside the budget and 09:41 is eleven minutes
// past it - both far enough from the boundary that the boundary cases have to be
// written deliberately rather than arrived at by accident.
const OPENED_AT = "2026-09-30T09:00:00.000Z";
const ON_TIME_AT = "2026-09-30T09:12:00.000Z";
const LATE_AT = "2026-09-30T09:41:00.000Z";

// A realistic two-line trip: a safari at cost $4,200 sold at $5,000 for two
// people, plus a transfer at cost $140 sold at $200 for the party. Totals
// $10,200, which every suite asserts by hand rather than by recomputing.
function tripDetails(overrides) {
  return {
    title: "Ten days in Tanzania",
    lines: [
      { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
      { label: "Airport transfer", unitCostCents: 14000, unitSellCents: 20000, quantity: 1 },
    ],
    currency: "USD",
    ...overrides,
  };
}

module.exports = {
  fakeStore,
  droppingStore,
  auditSpy,
  failingAudit,
  notifierSpy,
  clockAt,
  tripDetails,
  OPENED_AT,
  ON_TIME_AT,
  LATE_AT,
};
