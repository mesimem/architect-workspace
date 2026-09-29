// STORY-007: the two ways to look at a quote - the customer's and ours.
//
// THIS MODULE IS THE ACCEPTANCE CRITERION. "Given a quote is generated, when a
// customer views it, then it displays without internal costs." Everything that
// makes that true lives in this file, and nothing else in the build is allowed
// to hand a stored quote to a customer.
//
// WHY AN ALLOWLIST AND NOT A DELETE LIST. The tempting version is to copy the
// stored record and strip the internal bits out. That version is wrong in a
// way that only shows up months later: the day someone adds `supplierRef` or
// `netRate` to a quote line, the new field is published to customers
// immediately, because nobody remembered to add it to the delete list. The
// omission is silent and the leak is retroactive - every quote, not just new
// ones. So this builds the customer document field by field. A field that
// nobody has decided to publish does not appear, and the default for anything
// new is invisible. This is the same rule as `itineraryView` in
// ../portal/itineraryService.js, for the same reason.
//
// THE SECOND LINE OF DEFENCE IS THE SHAPE OF THE PRICE. quotePricing.js keeps
// every internal figure inside an `internal` key rather than beside the
// customer-facing ones. So even a careless future edit here has to type the
// word `internal` to leak anything - a leak becomes something you do on
// purpose rather than something you do by forgetting. The test walks the whole
// serialized customer document and fails on any key or figure that looks like
// a cost, which is what stops both mistakes.
//
// WHY THERE IS AN INTERNAL VIEW HERE TOO. Putting both projections in one file
// looks like mixing concerns, and it is the opposite: the only way to be sure
// the two differ correctly is to read them side by side. Split across two
// files, "what exactly does the customer not see?" becomes a question you
// answer by flipping between tabs, and that is the question this story is
// about.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A record this module cannot render returns
//     null - it NEVER returns a half-built document. That is the story's
//     "customer view error" path: a caller that gets null must report the
//     quote as unavailable, and a customer sees an honest error instead of a
//     quote with a blank total they might act on. Rendering is total: no
//     input, however malformed, throws.
//  2. Will it retry? Nothing to retry. Pure projection, no I/O, no clock.
//  3. Recovery path? null propagates to a 500 with a correlation id at the
//     route, so the broken row is findable in the audit trail. The record
//     itself is untouched - a quote we cannot render is still a quote we can
//     repair, and reading it must never damage it.
//  4. Handled here: a missing or non-object record, missing pricing, missing
//     or non-array lines, a line that is not an object, missing totals, and
//     any unknown extra field on either the record or a line (dropped, not
//     published). NOT handled: currency formatting or localisation (a client
//     concern - cents and an ISO code go over the wire), PDF rendering, and
//     visibility rules such as draft or withdrawn states, which need a status
//     vocabulary this story does not ship.

// Returns true only for a record complete enough to render honestly. Being
// strict here is the point: a quote missing its total is not a quote with a
// gap in it, it is a document we must not show anyone.
function isRenderable(quote) {
  if (quote === null || typeof quote !== "object" || Array.isArray(quote)) {
    return false;
  }
  const pricing = quote.pricing;
  if (pricing === null || typeof pricing !== "object" || Array.isArray(pricing)) {
    return false;
  }
  if (!Array.isArray(pricing.lines) || pricing.lines.length === 0) {
    return false;
  }
  if (
    !Number.isInteger(pricing.subtotalCents) ||
    !Number.isInteger(pricing.discountCents) ||
    !Number.isInteger(pricing.totalCents)
  ) {
    return false;
  }
  return pricing.lines.every(function (line) {
    return (
      line !== null &&
      typeof line === "object" &&
      !Array.isArray(line) &&
      typeof line.label === "string" &&
      Number.isInteger(line.quantity) &&
      Number.isInteger(line.sellCents)
    );
  });
}

// ONE LINE, AS THE CUSTOMER SEES IT. Named fields only - note that
// `line.internal` is not mentioned anywhere below, and adding it would be a
// visible, reviewable act.
//
// The unit price is published deliberately: REQ-009 asks for "clear and
// detailed pricing", and a customer who can see 2 x $5,000 can check our
// arithmetic. A total with no working shown is what people distrust.
function customerLine(line) {
  return {
    label: line.label,
    quantity: line.quantity,
    unitPriceCents: Number.isInteger(line.unitSellCents) ? line.unitSellCents : null,
    amountCents: line.sellCents,
  };
}

// THE CUSTOMER DOCUMENT. Returns null for anything unrenderable - see
// failure-first note 1.
function customerQuoteView(quote) {
  if (!isRenderable(quote)) {
    return null;
  }

  return {
    quoteId: quote.quoteId,
    // A customer needs to know which of their trips this prices. The tripId
    // is theirs already; it publishes nothing new.
    tripReference: typeof quote.tripReference === "string" ? quote.tripReference : null,
    title: typeof quote.title === "string" ? quote.title : null,
    status: typeof quote.status === "string" ? quote.status : null,
    // The version is published on purpose. When an advisor revises a quote,
    // "version 2, updated on the 3rd" is how a customer knows the figure they
    // were emailed last week is no longer the figure - which is exactly what
    // acceptance criterion 2 is about.
    version: Number.isInteger(quote.version) ? quote.version : null,
    issuedAt: typeof quote.createdAt === "string" ? quote.createdAt : null,
    updatedAt: typeof quote.updatedAt === "string" ? quote.updatedAt : null,
    currency: typeof quote.pricing.currency === "string" ? quote.pricing.currency : null,
    lines: quote.pricing.lines.map(customerLine),
    subtotalCents: quote.pricing.subtotalCents,
    // A discount is shown as a positive amount with its own label; the client
    // renders it as a deduction. Publishing it matters: a customer who is
    // given a discount should be able to see that they were.
    discountCents: quote.pricing.discountCents,
    totalCents: quote.pricing.totalCents,
    // The advisor's note TO the customer. Distinct from `quote.internalNotes`,
    // which is never published - two fields rather than one flagged field,
    // because a boolean that decides who sees a note is a boolean someone will
    // eventually get backwards.
    customerNote: typeof quote.customerNote === "string" ? quote.customerNote : null,
  };
}

// THE INTERNAL DOCUMENT - what an advisor sees. Costs, margins, who issued it.
// Also an allowlist, for a different reason: an advisor has no business
// reading a customer's stored password hash or session data either, should a
// record ever grow a reference to one.
function internalQuoteView(quote) {
  const customer = customerQuoteView(quote);
  if (customer === null) {
    return null;
  }

  return {
    ...customer,
    customerId: quote.customerId,
    issuedBy: typeof quote.issuedBy === "string" ? quote.issuedBy : null,
    lastModifiedBy: typeof quote.lastModifiedBy === "string" ? quote.lastModifiedBy : null,
    internalNotes: typeof quote.internalNotes === "string" ? quote.internalNotes : null,
    lines: quote.pricing.lines.map(function (line, index) {
      return {
        ...customer.lines[index],
        unitCostCents: line.internal ? line.internal.unitCostCents : null,
        costCents: line.internal ? line.internal.costCents : null,
        marginCents: line.internal ? line.internal.marginCents : null,
      };
    }),
    costTotalCents: quote.pricing.internal ? quote.pricing.internal.costTotalCents : null,
    marginCents: quote.pricing.internal ? quote.pricing.internal.marginCents : null,
  };
}

module.exports = { customerQuoteView, internalQuoteView, isRenderable };
