// STORY-007, acceptance criterion 1: "Given a quote is generated, when a
// customer views it, then it displays without internal costs."
//
// The interesting test here is not "does the customer document look right" -
// it is the LEAK SCAN below, which walks the whole serialized document and
// fails on anything that looks like a cost, at any depth, under any name. A
// test that only checks the fields we remembered to check would pass on the
// day someone adds `supplierRef` to a line, which is precisely the day this
// criterion breaks.

const assert = require("assert");

const { priceQuote } = require("./quotePricing");
const { customerQuoteView, internalQuoteView, isRenderable } = require("./quoteView");

// Distinctive figures, so the scan below can hunt for them by value as well as
// by field name. Cost 8,540.00, sell 10,200.00, margin 1,660.00.
const SUPPLIER_SECRET = "SUPPLIER-NET-RATE-CONTRACT-4417";

function sampleQuote() {
  const priced = priceQuote({
    lines: [
      { label: "Serengeti Migration Safari", unitCostCents: 420000, unitSellCents: 500000, quantity: 2 },
      { label: "Airport transfer", unitCostCents: 14000, unitSellCents: 20000, quantity: 1 },
    ],
    currency: "USD",
  });
  assert.strictEqual(priced.status, "priced");

  return {
    quoteId: "QUOTE-0001",
    customerId: "CUST-77",
    tripReference: "TRIP-9",
    title: "Tanzania, two travellers",
    status: "issued",
    version: 1,
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    issuedBy: "ADVISOR-3",
    lastModifiedBy: "ADVISOR-3",
    customerNote: "Prices hold for 14 days.",
    internalNotes: "Supplier will discount if we confirm before Friday.",
    // A field nobody has decided to publish. It must not appear in the
    // customer document - not because it is on a delete list, but because it
    // is not on the allowlist.
    supplierReference: SUPPLIER_SECRET,
    pricing: priced.pricing,
  };
}

// Every key name, at every depth, in the customer document.
function allKeys(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => allKeys(item, found));
  } else if (value !== null && typeof value === "object") {
    Object.keys(value).forEach((key) => {
      found.push(key);
      allKeys(value[key], found);
    });
  }
  return found;
}

function main() {
  const quote = sampleQuote();
  const customer = customerQuoteView(quote);

  // HAPPY PATH: the customer gets a complete, useful document.
  assert.strictEqual(customer.quoteId, "QUOTE-0001");
  assert.strictEqual(customer.title, "Tanzania, two travellers");
  assert.strictEqual(customer.version, 1);
  assert.strictEqual(customer.currency, "USD");
  assert.strictEqual(customer.totalCents, 1020000);
  assert.strictEqual(customer.lines.length, 2);
  assert.strictEqual(customer.lines[0].label, "Serengeti Migration Safari");
  assert.strictEqual(customer.lines[0].quantity, 2);
  assert.strictEqual(customer.lines[0].unitPriceCents, 500000);
  assert.strictEqual(customer.lines[0].amountCents, 1000000);
  assert.strictEqual(customer.customerNote, "Prices hold for 14 days.");
  console.log("quoteView: a customer sees the full priced document, itemised");

  // THE ARITHMETIC STILL ADDS UP AFTER PROJECTION. A customer who checks our
  // working must find it correct - the lines they can see sum to the total
  // they are asked to pay.
  const shownSum = customer.lines.reduce((sum, line) => sum + line.amountCents, 0);
  assert.strictEqual(shownSum, customer.subtotalCents);
  assert.strictEqual(customer.subtotalCents - customer.discountCents, customer.totalCents);
  console.log("quoteView: the lines a customer can see sum to the total they are charged");

  // ===== ACCEPTANCE CRITERION 1: THE LEAK SCAN =====
  const serialized = JSON.stringify(customer);

  // By value: no internal figure appears anywhere, under any name.
  for (const internalFigure of [
    854000, // cost total
    166000, // margin total
    420000, // unit cost, line 0
    840000, // line cost, line 0
    160000, // line margin, line 0
    14000, // unit cost, line 1
    6000, // line margin, line 1
  ]) {
    assert.ok(
      !serialized.includes(String(internalFigure)),
      "internal figure " + internalFigure + " leaked into the customer document"
    );
  }

  // By name: no key at any depth reads like an internal one.
  const forbidden = /cost|margin|internal|supplier|net_?rate|markup/i;
  for (const key of allKeys(customer)) {
    assert.ok(!forbidden.test(key), "customer document exposes an internal-looking key: " + key);
  }

  // By explicit absence, for the three that matter most.
  assert.strictEqual(customer.internalNotes, undefined);
  assert.strictEqual(customer.supplierReference, undefined);
  assert.strictEqual(customer.customerId, undefined);
  assert.ok(!serialized.includes(SUPPLIER_SECRET));
  assert.ok(!serialized.includes("Supplier will discount"));
  console.log("quoteView: no internal cost, margin, note or supplier detail reaches the customer");

  // THE ALLOWLIST HOLDS AGAINST A FIELD NOBODY ANTICIPATED. This is the
  // regression that a delete-list implementation would fail.
  const withNewField = sampleQuote();
  withNewField.netRateAgreementCents = 799900;
  withNewField.pricing.lines[0].supplierRef = SUPPLIER_SECRET;
  const scanned = JSON.stringify(customerQuoteView(withNewField));
  assert.ok(!scanned.includes("799900"), "a newly added internal field was published by default");
  assert.ok(!scanned.includes(SUPPLIER_SECRET), "a newly added line field was published by default");
  console.log("quoteView: a field added to the record tomorrow is invisible until someone publishes it");

  // THE INTERNAL VIEW IS THE DIFFERENCE, AND IT REALLY DOES DIFFER. An advisor
  // sees what the customer sees, plus the costs. If these two ever returned
  // the same thing, the criterion above would be vacuous.
  const advisor = internalQuoteView(quote);
  assert.strictEqual(advisor.costTotalCents, 854000);
  assert.strictEqual(advisor.marginCents, 166000);
  assert.strictEqual(advisor.lines[0].costCents, 840000);
  assert.strictEqual(advisor.lines[0].marginCents, 160000);
  assert.strictEqual(advisor.internalNotes, "Supplier will discount if we confirm before Friday.");
  assert.strictEqual(advisor.customerId, "CUST-77");
  // And the customer-facing figures are identical in both - the customer is
  // not shown a different price from the one we hold.
  assert.strictEqual(advisor.totalCents, customer.totalCents);
  assert.strictEqual(advisor.lines[0].amountCents, customer.lines[0].amountCents);
  console.log("quoteView: an advisor sees the same prices plus the costs, a customer sees prices only");

  // FAILURE PATH - CUSTOMER VIEW ERROR. A record we cannot render honestly
  // returns null, never a document with a hole in it. Every one of these
  // arrives from a store that could have been written by an older version of
  // the code, or half-written by a crash.
  for (const broken of [
    null,
    undefined,
    "a string",
    [],
    {},
    { ...sampleQuote(), pricing: null },
    { ...sampleQuote(), pricing: {} },
    { ...sampleQuote(), pricing: { ...sampleQuote().pricing, lines: [] } },
    { ...sampleQuote(), pricing: { ...sampleQuote().pricing, lines: "not an array" } },
    { ...sampleQuote(), pricing: { ...sampleQuote().pricing, lines: [null] } },
    { ...sampleQuote(), pricing: { ...sampleQuote().pricing, totalCents: undefined } },
    { ...sampleQuote(), pricing: { ...sampleQuote().pricing, totalCents: 10.5 } },
    { ...sampleQuote(), pricing: { ...sampleQuote().pricing, subtotalCents: null } },
  ]) {
    assert.strictEqual(customerQuoteView(broken), null, JSON.stringify(broken) + " should not render");
    assert.strictEqual(internalQuoteView(broken), null);
    assert.strictEqual(isRenderable(broken), false);
  }
  console.log("quoteView: an unrenderable record returns null rather than a document with a hole in it");

  // RENDERING NEVER THROWS, AND NEVER DAMAGES THE RECORD. A read that mutates
  // what it read is how a repairable quote becomes an unrepairable one.
  const before = JSON.stringify(quote);
  customerQuoteView(quote);
  internalQuoteView(quote);
  assert.strictEqual(JSON.stringify(quote), before);
  console.log("quoteView: rendering leaves the stored record exactly as it found it");

  console.log("quoteView: all tests passed");
}

main();
