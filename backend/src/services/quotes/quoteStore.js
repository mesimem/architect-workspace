// STORY-007: where a quote lives, and the rules for changing one.
//
// Three jobs, and no fourth: persist a priced quote, revise it, and make sure
// every one of those acts is in the audit trail. The arithmetic belongs to
// quotePricing.js and the customer document to quoteView.js, so this file
// never computes a figure and never decides what a customer may see.
//
// AN UNAUDITED QUOTE MUST NOT EXIST, and no write here is called a success
// until it has been read back. Both rules live in quoteWriteGuard.js, which is
// the only door to the store - nothing in this file calls store.set directly.
// Read that file's header for why a failed audit rolls the write back.
//
// IDEMPOTENCY IS ON THE CORRELATION ID. Every request through http/server.js
// carries one. A retried generate returns the first quote rather than issuing a
// second at a different id - a duplicate quote is not a cosmetic problem, it is
// two documents with two totals and no way to tell a customer which is real.
// Modifications dedup the same way, so a double-clicked save does not bump the
// version twice.
//
// REPRICING IS ALWAYS FROM SCRATCH, NEVER A PATCH OF THE OLD TOTALS. A
// modification rebuilds the price from the full line set, because adjusting a
// stored total by a delta is how a total drifts away from the lines beneath it.
// The input lines do not need to be stored separately to do this: a priced line
// carries everything it was priced from (see reconstructInputLines).
//
// THAT IS ALSO WHAT MAKES ACCEPTANCE CRITERION 2 TRUE BY CONSTRUCTION. There is
// ONE stored price and both views are projections of it, so "the system updates
// the customer view" is not a step anyone has to remember - there is no second
// copy to update, and no way to save a revision that the customer view does not
// immediately reflect.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every outcome is { ok: false, reason, problems }.
//     Nothing here throws on caller input: these reasons become HTTP statuses,
//     and a malformed body must be a 400, not a 500.
//  2. Will it retry? No. The only I/O is a local synchronous store write, and
//     retrying a failed local write generally fails again. The CALLER may retry
//     safely, which is the point of the correlationId dedup.
//  3. Recovery path? A failed save leaves NO partial state - no row, no audit
//     entry claiming success - so the advisor resubmits and nothing has to be
//     cleaned up. A store that will not load at all fails at startup rather
//     than serving an empty quote book (see jsonFileStore.js).
//  4. Handled here: invalid pricing, missing ids, unknown quotes, unknown or
//     empty update fields, prototype-chain field names, replayed requests,
//     no-op edits, a write that does not persist, and an audit that fails.
//     NOT handled: concurrent edits to one quote (last write wins; two
//     advisors editing one quote in the same second needs row locking, which
//     needs the database), quote expiry, deletion (a withdrawn quote is a
//     status this story does not ship), and pagination of the quote list.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit } = require("../audit/auditLog");
const { priceQuote, STATUSES: PRICING_STATUSES } = require("./quotePricing");
const { isRenderable } = require("./quoteView");
// The write path and its audit guarantee. Nothing in this file writes to the
// store directly - see quoteWriteGuard.js for why there is exactly one door.
const { commitQuote, auditNoChange, REASONS: WRITE_REASONS } = require("./quoteWriteGuard");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise - the same
// bargain every other store in this repo makes. See jsonFileStore.js.
const QUOTES = createJsonFileStore("quotes");

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;

// The only status this story ships. A quote is issued the moment it is
// generated, because an advisor generating a quote IS the act of issuing it.
// Draft and withdrawn states are deliberately absent: each implies a
// visibility rule, and a visibility rule nobody has specified is worse than
// none at all.
const QUOTE_STATUS = "issued";

// The allow-list for modifications. `currency` is absent on purpose - changing
// it would reinterpret every figure on the quote without changing one of them.
// `customerId` is absent because reassigning a quote to a different customer
// is not an edit, it is a new quote.
const MUTABLE_FIELDS = Object.freeze([
  "title",
  "tripReference",
  "customerNote",
  "internalNotes",
  "lines",
  "discountBasisPoints",
]);

const EVENTS = Object.freeze({
  GENERATED: "quote.generated",
  MODIFIED: "quote.modified",
  UNCHANGED: "quote.unchanged",
  REFUSED: "quote.refused",
});

// Every way this module can refuse. The last two are re-exported from the
// write guard rather than restated here: a route maps these onto HTTP statuses
// from ONE list, and two lists that must agree are one list that will not.
const REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  INVALID_QUOTE: "invalid_quote",
  UNKNOWN_QUOTE: "unknown_quote",
  UNKNOWN_FIELDS: "unknown_fields",
  EMPTY_UPDATE: "empty_update",
  MISSING_CORRELATION_ID: "missing_correlation_id",
  NOT_SAVED: WRITE_REASONS.NOT_SAVED,
  AUDIT_UNAVAILABLE: WRITE_REASONS.AUDIT_UNAVAILABLE,
});

function isUsableId(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID_LENGTH;
}

function optionalText(value, maxLength) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, maxLength) : null;
}

function nowIso() {
  return new Date().toISOString();
}

function refuse(reason, problems) {
  return { ok: false, reason: reason, problems: problems };
}

// A refusal changed nothing, so logging it is best effort - see the asymmetry
// explained in quoteWriteGuard.js. Wrapped here only so the twenty call sites
// below do not each have to restate the event name and the outcome.
function auditRefusal(audit, details) {
  return auditNoChange(audit, { event: EVENTS.REFUSED, outcome: "failure", ...details });
}

// Rebuilds the arguments a priced line was priced FROM. This is why the raw
// submission does not need to be stored alongside the priced one: the priced
// line already carries the unit cost, the unit price and the quantity, and
// those three are the whole input. Storing both would be two truths.
function reconstructInputLines(pricing) {
  return pricing.lines.map(function (line) {
    return {
      label: line.label,
      unitCostCents: line.internal.unitCostCents,
      unitSellCents: line.unitSellCents,
      quantity: line.quantity,
    };
  });
}

function allQuotes(store) {
  return Array.from(store.values());
}

// A replay is the SAME request arriving twice, identified by its correlation
// id. Matching on `createdWith` for generate and `lastModifiedWith` for modify.
function findByCorrelation(store, field, correlationId) {
  return (
    allQuotes(store).find(function (quote) {
      return quote && quote[field] === correlationId;
    }) || null
  );
}

// Generates a quote. Returns { ok: true, quote, replayed } or a refusal.
//
// `audit`, `store` and `now` are injected with real defaults: the tests need a
// store that drops writes and an audit that fails, and there is no honest way
// to exercise "quote not saved" without one.
function generateQuote(
  {
    customerId,
    tripReference,
    title,
    lines,
    currency = "USD",
    discountBasisPoints = 0,
    customerNote,
    internalNotes,
    actor,
    correlationId,
  },
  { store = QUOTES, audit = recordAudit, now = nowIso } = {}
) {
  if (!isUsableId(correlationId)) {
    // Our plumbing, not the caller's: server.js always supplies one.
    return refuse(REASONS.MISSING_CORRELATION_ID, ["correlationId is required."]);
  }

  const problems = [];
  if (!isUsableId(customerId)) {
    problems.push("customerId is required.");
  }
  if (!isUsableId(actor)) {
    problems.push("actor is required - a quote records who issued it.");
  }
  if (problems.length > 0) {
    auditRefusal(audit, { reason: REASONS.INVALID_REQUEST, actor, correlationId });
    return refuse(REASONS.INVALID_REQUEST, problems);
  }

  // Replay check BEFORE pricing and before an id is generated, so a retry
  // cannot burn a second quoteId.
  const replay = findByCorrelation(store, "createdWith", correlationId);
  if (replay) {
    return { ok: true, quote: replay, replayed: true };
  }

  const priced = priceQuote({
    lines: lines,
    currency: currency,
    discountBasisPoints: discountBasisPoints,
  });
  if (priced.status !== PRICING_STATUSES.PRICED) {
    auditRefusal(audit, { reason: REASONS.INVALID_QUOTE, actor, correlationId });
    return refuse(REASONS.INVALID_QUOTE, priced.problems);
  }

  const timestamp = now();
  const quote = Object.freeze({
    quoteId: "quote_" + crypto.randomUUID(),
    customerId: customerId,
    tripReference: optionalText(tripReference, MAX_ID_LENGTH),
    title: optionalText(title, MAX_TITLE_LENGTH),
    status: QUOTE_STATUS,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    issuedBy: actor,
    lastModifiedBy: actor,
    customerNote: optionalText(customerNote, MAX_NOTE_LENGTH),
    internalNotes: optionalText(internalNotes, MAX_NOTE_LENGTH),
    pricing: priced.pricing,
    createdWith: correlationId,
    lastModifiedWith: correlationId,
  });

  const committed = commitQuote(store, audit, {
    quote: quote,
    previous: null,
    event: EVENTS.GENERATED,
    actor: actor,
    correlationId: correlationId,
    context: {
      customerId: customerId,
      version: 1,
      lineCount: quote.pricing.lines.length,
      totalCents: quote.pricing.totalCents,
      currency: quote.pricing.currency,
    },
  });
  if (!committed.ok) {
    return committed;
  }

  return { ok: true, quote: quote, replayed: false };
}

// Revises a quote. Returns { ok: true, quote, replayed, changed } or a refusal.
function modifyQuote(
  { quoteId, changes, actor, correlationId },
  { store = QUOTES, audit = recordAudit, now = nowIso } = {}
) {
  if (!isUsableId(correlationId)) {
    return refuse(REASONS.MISSING_CORRELATION_ID, ["correlationId is required."]);
  }
  if (!isUsableId(actor)) {
    auditRefusal(audit, { reason: REASONS.INVALID_REQUEST, actor, correlationId });
    return refuse(REASONS.INVALID_REQUEST, ["actor is required - a revision records who made it."]);
  }

  const current = isUsableId(quoteId) ? store.get(quoteId) || null : null;
  if (!current) {
    auditRefusal(audit, {
      reason: REASONS.UNKNOWN_QUOTE,
      actor,
      correlationId,
      resource: isUsableId(quoteId) ? quoteId : "quote",
    });
    return refuse(REASONS.UNKNOWN_QUOTE, ["No quote with that id."]);
  }

  // A retried save returns the revision it already made. Without this, a
  // double-clicked Save bumps the version twice and the customer sees "version
  // 3" of a quote that was revised once.
  if (current.lastModifiedWith === correlationId) {
    return { ok: true, quote: current, replayed: true, changed: false };
  }

  const requested = changes !== null && typeof changes === "object" && !Array.isArray(changes) ? changes : {};

  // hasOwnProperty, not `in`: a body of { "constructor": ... } arrives from the
  // internet more often than anyone expects, and MUTABLE_FIELDS is what stops
  // anything outside the allow-list being written at all.
  const offered = MUTABLE_FIELDS.filter(function (field) {
    return Object.prototype.hasOwnProperty.call(requested, field);
  });
  const rejected = Object.keys(requested).filter(function (field) {
    return !MUTABLE_FIELDS.includes(field);
  });

  if (rejected.length > 0) {
    auditRefusal(audit, { reason: REASONS.UNKNOWN_FIELDS, actor, correlationId, resource: quoteId });
    // Field NAMES are safe to echo; they are our vocabulary, not the caller's data.
    return refuse(REASONS.UNKNOWN_FIELDS, [
      "These fields cannot be changed: " + rejected.join(", ") + ".",
      "Editable fields are: " + MUTABLE_FIELDS.join(", ") + ".",
    ]);
  }
  if (offered.length === 0) {
    auditRefusal(audit, { reason: REASONS.EMPTY_UPDATE, actor, correlationId, resource: quoteId });
    return refuse(REASONS.EMPTY_UPDATE, ["No changes were supplied."]);
  }

  // Reprice from the full line set, always - see the header on why a delta is
  // not an option. Unchanged inputs are reconstructed from the stored price.
  const nextLines = offered.includes("lines")
    ? requested.lines
    : reconstructInputLines(current.pricing);
  const nextDiscount = offered.includes("discountBasisPoints")
    ? requested.discountBasisPoints
    : current.pricing.discountBasisPoints;

  const priced = priceQuote({
    lines: nextLines,
    currency: current.pricing.currency,
    discountBasisPoints: nextDiscount,
  });
  if (priced.status !== PRICING_STATUSES.PRICED) {
    auditRefusal(audit, { reason: REASONS.INVALID_QUOTE, actor, correlationId, resource: quoteId });
    // The stored quote is untouched. A rejected revision must never leave the
    // customer looking at a half-changed document.
    return refuse(REASONS.INVALID_QUOTE, priced.problems);
  }

  const nextText = {
    title: offered.includes("title") ? optionalText(requested.title, MAX_TITLE_LENGTH) : current.title,
    tripReference: offered.includes("tripReference")
      ? optionalText(requested.tripReference, MAX_ID_LENGTH)
      : current.tripReference,
    customerNote: offered.includes("customerNote")
      ? optionalText(requested.customerNote, MAX_NOTE_LENGTH)
      : current.customerNote,
    internalNotes: offered.includes("internalNotes")
      ? optionalText(requested.internalNotes, MAX_NOTE_LENGTH)
      : current.internalNotes,
  };

  // A no-op edit is not a revision. Bumping the version for a save that
  // changed nothing would tell a customer their quote was revised when it was
  // not - and an audit trail full of empty revisions is an audit trail nobody
  // reads. It is still recorded, as an unchanged event.
  const priceChanged = JSON.stringify(priced.pricing) !== JSON.stringify(current.pricing);
  const textChanged = Object.keys(nextText).some(function (field) {
    return nextText[field] !== current[field];
  });
  if (!priceChanged && !textChanged) {
    auditNoChange(audit, {
      event: EVENTS.UNCHANGED,
      // A save that changed nothing is not a failure - the advisor did nothing
      // wrong and nothing was refused. Recording it as one would put a wall of
      // false failures in front of whoever reviews this trail.
      outcome: "success",
      reason: "no_effective_change",
      actor,
      correlationId,
      resource: quoteId,
    });
    return { ok: true, quote: current, replayed: false, changed: false };
  }

  const revised = Object.freeze({
    ...current,
    ...nextText,
    version: current.version + 1,
    updatedAt: now(),
    lastModifiedBy: actor,
    lastModifiedWith: correlationId,
    pricing: priced.pricing,
  });

  const committed = commitQuote(store, audit, {
    quote: revised,
    previous: current,
    event: EVENTS.MODIFIED,
    actor: actor,
    correlationId: correlationId,
    context: {
      customerId: revised.customerId,
      version: revised.version,
      fields: offered,
      totalCentsBefore: current.pricing.totalCents,
      totalCentsAfter: revised.pricing.totalCents,
    },
  });
  if (!committed.ok) {
    return committed;
  }

  return { ok: true, quote: revised, replayed: false, changed: true };
}

// READS. Every one takes a customerId or is explicitly internal, for the same
// reason itineraryService.js does: a read that can return anyone's quote is one
// forgotten argument away from returning everyone's.

function getQuoteForCustomer({ customerId, quoteId }, { store = QUOTES } = {}) {
  if (!isUsableId(customerId) || !isUsableId(quoteId)) {
    return null;
  }
  const quote = store.get(quoteId);
  // A stranger's quote is reported exactly like one that does not exist - the
  // caller turns both into 404. See itineraryService.js for the reasoning: the
  // difference between 403 and 404 maps out the whole quote book.
  return quote && quote.customerId === customerId ? quote : null;
}

function listQuotesForCustomer({ customerId }, { store = QUOTES } = {}) {
  if (!isUsableId(customerId)) {
    return [];
  }
  return allQuotes(store)
    .filter(function (quote) {
      return quote && quote.customerId === customerId && isRenderable(quote);
    })
    .sort(function (a, b) {
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
}

// The advisor's read. Named so that its lack of a customer filter is a
// deliberate choice at the call site rather than an oversight.
function getQuoteForStaff({ quoteId }, { store = QUOTES } = {}) {
  return isUsableId(quoteId) ? store.get(quoteId) || null : null;
}

// Tests only. Not reachable over HTTP - erasing the quote book is not an
// operation this system offers.
function __resetQuotesForTests() {
  for (const key of Array.from(QUOTES.keys())) {
    QUOTES.delete(key);
  }
}

module.exports = {
  generateQuote,
  modifyQuote,
  getQuoteForCustomer,
  listQuotesForCustomer,
  getQuoteForStaff,
  __resetQuotesForTests,
  MUTABLE_FIELDS,
  QUOTE_STATUS,
  EVENTS,
  REASONS,
};
