// STORY-015: the safari product book. A product manager authors a package -
// its day-by-day itinerary and its price - and an advisor sells from it.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It owns authored
// products: write them down, keep them consistent, and audit every change. It
// does NOT decide what makes a product well-formed (safariProductValidation.js
// owns that, purely), it does NOT price a customer's trip (quotes/ owns that,
// from explicit line items), and it does NOT replace africa/catalogSource.js -
// that is a read-only seeded lookup of destinations a customer can browse,
// while this is the authored inventory behind it. Merging the two would give
// one module a read path for customers and a write path for staff, which is
// exactly the shape that leaks.
//
// THE THREE FAILURE PATHS THE STORY NAMES, AND WHERE EACH IS HANDLED.
//   Incorrect pricing data  -> safariProductValidation.js, called on create AND
//                              on the MERGED record on update. Refused with a
//                              problem list, never half-written.
//   Itinerary conflicts     -> same module, same two call sites. The update
//                              case is the one that actually bites: changing
//                              durationDays alone can orphan a day the
//                              itinerary already describes, so the merge is
//                              what gets validated, not the patch.
//   Unauthorized product    -> NOT here. Enforced once, centrally, by the
//   modification               permission gate in http/server.js against the
//                              products.* permissions the routes declare. A
//                              second check in this module would be a second
//                              policy, and two policies can disagree.
//
// WHY EVERY MUTATION NEEDS A correlationId. Audit entries are keyed and
// first-write-wins (see auditLog.js). A module that audited every edit under
// "<productId>:updated" would record the FIRST change to a product and silently
// discard every later one - so a package repriced three times would show its
// original price forever. The honest key for "an edit happened" is the request
// that made it. The consequence, stated plainly: a mutation arriving with no
// correlationId is REFUSED rather than performed unaudited. The project
// guardrail is that all changes are audited, so "I cannot audit this" has to
// mean "I will not do this".
//
// WHY THE AUDIT ENTRY CARRIES AN ITINERARY DIGEST AND NOT THE ITINERARY.
// auditLog.js caps context nesting at MAX_CONTEXT_DEPTH and replaces anything
// deeper with "<truncated>". A before/after pair holding full day objects sits
// below that cap, so writing it would produce an audit entry that LOOKS
// complete and actually reads "<truncated>" where the evidence should be. A
// digest - how many days, and which day numbers moved - is smaller, true, and
// the thing an auditor asks first. Recording something that silently becomes
// "<truncated>" would be worse than recording less.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A refusal returns { ok: false, reason,
//     problems } and writes an audit entry recording the refusal. Nothing is
//     partially written: validation runs to completion before the store is
//     touched, and the write is a single synchronous set of one frozen record.
//     If the audit write itself throws, the store write has not happened yet -
//     see the ordering note in createSafariProduct.
//  2. Will it retry? There is nothing to retry: no network, no clock skew, one
//     synchronous local write. Callers may safely re-send - create dedups on
//     (name + country), update dedups on the correlationId.
//  3. Recovery path if it fails anyway? The caller gets the reason and the full
//     problem list and can correct and re-send. A disk-level failure surfaces
//     as a thrown error from jsonFileStore rather than a silent success, and a
//     corrupt store file refuses to load at startup (see jsonFileStore.js).
//  4. Handled: every validation fault, unknown products, duplicate products,
//     unknown and empty patches, prototype-chain keys in `changes`, a missing
//     correlationId, replayed creates, and callers mutating a record they were
//     handed. NOT handled: deletion or retirement of a product (there is no
//     delete - an unsold package is a status question a later story owns, and
//     erasing a product erases the subject of its own audit trail), optimistic
//     concurrency between two product managers editing at once (`version` is
//     recorded so a later story can add If-Match without a migration, but it
//     is not enforced today), and any index over the book - list and the
//     duplicate check both scan, which is O(n) on purpose. STORY-016 owns
//     scale; an index is a second copy of the data that can desync.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");
const {
  validateSafariProduct,
  normaliseItinerary,
  normalisePricing,
} = require("./safariProductValidation");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise, same as every
// other store here. A product book that forgets on restart loses the inventory
// the agency sells.
const PRODUCTS = createJsonFileStore("safari-products");

// Only these may be changed after authoring. Notably absent: productId,
// createdAt, createdBy, version. An "update" that can rewrite who authored a
// package and when is not an update, it is a way to erase the trail.
const MUTABLE_FIELDS = Object.freeze([
  "name",
  "country",
  "summary",
  "durationDays",
  "itinerary",
  "pricing",
]);

// Fields whose values are objects or arrays, and so are compared structurally
// rather than with ===. Both sides of every such comparison are NORMALISED
// first, and the normalisers build their keys in a fixed order, so a JSON
// comparison is exact here - it is not relied upon for arbitrary objects.
const STRUCTURAL_FIELDS = Object.freeze(["itinerary", "pricing"]);

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Lower-cased and trimmed: "Serengeti Migration Safari" and "serengeti
// migration safari " are the same package, and the duplicate check is only as
// good as this function.
function normaliseText(value) {
  return isNonBlankString(value) ? value.trim().toLowerCase() : "";
}

// The duplicate identity: the same package name in the same country. Two rows
// with that pair is a double-submit or a copy-paste, and an advisor picking
// from a list of two identical names cannot tell which one is current. The same
// name in a DIFFERENT country is intentionally not a duplicate - "Big Five
// Safari" in Kenya and in Botswana are different products.
function dedupKeyFor(name, country) {
  return normaliseText(name) + "|" + normaliseText(country);
}

function findByDedupKey(dedupKey) {
  const products = Array.from(PRODUCTS.values());
  for (const product of products) {
    if (dedupKeyFor(product.name, product.country) === dedupKey) {
      return product;
    }
  }
  return null;
}

// Frozen one level down for the scalars; the itinerary and pricing blocks were
// already frozen by their normalisers. A caller handed a product cannot edit
// the book through it - every change goes through updateSafariProduct, which is
// the only thing that writes an audit entry.
function freezeProduct(product) {
  return Object.freeze(product);
}

// What goes in an audit entry for a given field. Everything is itself except
// the itinerary, which becomes a digest - see the header for why writing the
// days themselves would produce "<truncated>".
function forAudit(field, value) {
  return field === "itinerary" ? { days: value.length } : value;
}

function sameValue(field, left, right) {
  return STRUCTURAL_FIELDS.includes(field)
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right;
}

// Which day numbers actually moved. Reported alongside an itinerary change
// because "the itinerary changed" is not an answer to "what changed?", and it
// is the question asked when a customer says their day 4 is different from the
// brochure. A day counts as changed if it was added, removed, or differs in any
// field.
function changedDays(before, after) {
  const byDay = new Map();
  before.forEach(function (entry) {
    byDay.set(entry.day, { before: entry });
  });
  after.forEach(function (entry) {
    const pair = byDay.get(entry.day) || {};
    pair.after = entry;
    byDay.set(entry.day, pair);
  });

  return Array.from(byDay.keys())
    .filter(function (day) {
      const pair = byDay.get(day);
      return JSON.stringify(pair.before) !== JSON.stringify(pair.after);
    })
    .sort(function (a, b) {
      return a - b;
    });
}

function refuse(reason, problems, details) {
  // A refusal is audited too. "Someone tried to publish a package priced below
  // cost" and "someone tried to edit a product that does not exist" are both
  // things you want to find later; a refusal that leaves no trace is
  // indistinguishable from a request that was never made.
  const auditKey = deriveAuditKey(details.correlationId, "products.safari.refused");
  if (auditKey !== "") {
    recordAudit({
      auditKey: auditKey,
      event: "products.safari.refused",
      outcome: "failure",
      actor: details.actor,
      resource: details.resource || "products.safari",
      correlationId: details.correlationId,
      // The problem list is the validator's, and it is written not to echo
      // untrusted input back - see safariProductValidation's describeValue.
      context: { reason: reason, problems: problems },
    });
  }
  return { ok: false, reason: reason, problems: problems };
}

// Authors a new product. Idempotent on (name + country): calling it twice with
// the same package returns the record from the first call, writes no second row
// and no second audit entry, and says so with replayed: true.
//
// A replayed create does NOT apply the second call's content. If the price in
// the retry differs, that is an EDIT, and edits go through updateSafariProduct
// where they are audited as such - silently accepting it here would reprice a
// package under an audit entry that says "created".
function createSafariProduct({
  name,
  country,
  summary,
  durationDays,
  itinerary,
  pricing,
  actor,
  correlationId,
}) {
  if (!isNonBlankString(correlationId)) {
    // Refused before validation and before any write - see the header. Not
    // audited, because there is no id to audit it under; the HTTP layer always
    // supplies one, so reaching this means a programming error, not a bad
    // request.
    return {
      ok: false,
      reason: "missing_correlation_id",
      problems: ["correlationId is required."],
    };
  }

  const candidate = { name, country, summary, durationDays, itinerary, pricing };
  const problems = validateSafariProduct(candidate);
  if (problems.length > 0) {
    return refuse("invalid_product", problems, { actor, correlationId });
  }

  // Duplicate check BEFORE the id is generated, so a repeat does not burn a new
  // productId and does not depend on the store's own key.
  const existing = findByDedupKey(dedupKeyFor(name, country));
  if (existing) {
    return { ok: true, product: existing, replayed: true };
  }

  const now = new Date().toISOString();
  const productId = "safari_" + crypto.randomUUID();
  const product = freezeProduct({
    productId: productId,
    name: name.trim(),
    country: country.trim(),
    summary: summary.trim(),
    durationDays: durationDays,
    itinerary: normaliseItinerary(itinerary),
    pricing: normalisePricing(pricing),
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: isNonBlankString(actor) ? actor : null,
    updatedBy: isNonBlankString(actor) ? actor : null,
  });

  // AUDIT BEFORE THE STORE WRITE. recordAudit throws on a bad entry (see its
  // header), and the ordering decides what a failure leaves behind: audited but
  // unstored is a traceable no-op, stored but unaudited is an unexplained
  // product in the catalog. Keyed on the productId, generated a moment ago, so
  // it cannot collide with an earlier entry. Updates cannot use this key - see
  // the header.
  recordAudit({
    auditKey: deriveAuditKey(productId, "products.safari.created"),
    event: "products.safari.created",
    outcome: "success",
    actor: product.createdBy,
    resource: productId,
    correlationId: correlationId,
    context: {
      name: product.name,
      country: product.country,
      durationDays: product.durationDays,
      itinerary: forAudit("itinerary", product.itinerary),
      pricing: product.pricing,
    },
  });

  PRODUCTS.set(productId, product);

  return { ok: true, product: product, replayed: false };
}

// Edits an existing product. Every accepted edit writes one audit entry naming
// the fields that changed, which is the story's trust criterion, and bumps
// `version` so a reader can tell two revisions apart.
function updateSafariProduct({ productId, changes, actor, correlationId }) {
  if (!isNonBlankString(correlationId)) {
    return {
      ok: false,
      reason: "missing_correlation_id",
      problems: ["correlationId is required."],
    };
  }

  const current = getSafariProduct(productId);
  if (!current) {
    return refuse("unknown_product", ["No safari product with that id."], {
      actor,
      correlationId,
      resource: typeof productId === "string" ? productId : "products.safari",
    });
  }

  const requested = changes && typeof changes === "object" && !Array.isArray(changes) ? changes : {};

  // hasOwnProperty, not `key in requested`: a body of { "constructor": ... }
  // arrives from a request more often than anyone expects, and MUTABLE_FIELDS
  // is the allow-list that stops anything else being written at all.
  const offered = MUTABLE_FIELDS.filter(function (field) {
    return Object.prototype.hasOwnProperty.call(requested, field);
  });
  const rejected = Object.keys(requested).filter(function (field) {
    return !MUTABLE_FIELDS.includes(field);
  });
  if (rejected.length > 0) {
    return refuse("unknown_fields", ["Not editable: " + rejected.sort().join(", ") + "."], {
      actor,
      correlationId,
      resource: current.productId,
    });
  }
  if (offered.length === 0) {
    return refuse("empty_update", ["changes must name at least one editable field."], {
      actor,
      correlationId,
      resource: current.productId,
    });
  }

  // VALIDATE THE MERGED RECORD, NOT THE PATCH. This is the line that catches
  // the story's itinerary-conflict path on the update side: shortening
  // durationDays alone leaves the stored itinerary describing days that no
  // longer exist, and replacing the itinerary alone can leave a gap against the
  // stored duration. Either patch is legal in isolation; the merge is what has
  // to hold up.
  const merged = {};
  MUTABLE_FIELDS.forEach(function (field) {
    merged[field] = offered.includes(field) ? requested[field] : current[field];
  });
  // The stored pricing block carries a derived `internal`, which the validator
  // does not accept as input. When pricing is NOT being edited, the authored
  // figures are reconstructed from the stored record so the merge validates the
  // same shape a create does.
  if (!offered.includes("pricing")) {
    merged.pricing = {
      currency: current.pricing.currency,
      perPersonCents: current.pricing.perPersonCents,
      singleSupplementCents: current.pricing.singleSupplementCents,
      costPerPersonCents: current.pricing.internal.costPerPersonCents,
    };
  }

  const problems = validateSafariProduct(merged);
  if (problems.length > 0) {
    return refuse("invalid_product", problems, {
      actor,
      correlationId,
      resource: current.productId,
    });
  }

  const normalised = {
    name: merged.name.trim(),
    country: merged.country.trim(),
    summary: merged.summary.trim(),
    durationDays: merged.durationDays,
    itinerary: normaliseItinerary(merged.itinerary),
    pricing: normalisePricing(merged.pricing),
  };

  // An edit that moves (name + country) onto another product's pair would
  // create the duplicate createSafariProduct exists to prevent. Same rule,
  // applied to the other door into the book.
  const newDedupKey = dedupKeyFor(normalised.name, normalised.country);
  if (newDedupKey !== dedupKeyFor(current.name, current.country)) {
    const clash = findByDedupKey(newDedupKey);
    if (clash && clash.productId !== current.productId) {
      return refuse("duplicate_product", ["Another product already has that name and country."], {
        actor,
        correlationId,
        resource: current.productId,
      });
    }
  }

  // Compared against the NORMALISED values, so re-sending "  Serengeti  " for a
  // name already stored as "Serengeti", or the same itinerary in a different
  // order, is correctly no change.
  const changed = MUTABLE_FIELDS.filter(function (field) {
    return !sameValue(field, normalised[field], current[field]);
  });

  if (changed.length === 0) {
    // Audited as a success with no diff, rather than skipped. "A product
    // manager opened this package and saved it unchanged" is a real event, and
    // recording it stops a reader of the trail assuming the request never
    // arrived. The version does NOT move: nothing changed, so nothing is a new
    // revision.
    recordAudit({
      auditKey: deriveAuditKey(correlationId, "products.safari.unchanged"),
      event: "products.safari.unchanged",
      outcome: "success",
      actor: isNonBlankString(actor) ? actor : null,
      resource: current.productId,
      correlationId: correlationId,
      context: { productId: current.productId, version: current.version },
    });
    return { ok: true, product: current, changed: [], unchanged: true };
  }

  const before = {};
  const after = {};
  changed.forEach(function (field) {
    before[field] = forAudit(field, current[field]);
    after[field] = forAudit(field, normalised[field]);
  });

  const updated = freezeProduct(
    Object.assign({}, current, normalised, {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: isNonBlankString(actor) ? actor : null,
    })
  );

  const context = {
    fields: changed,
    before: before,
    after: after,
    version: updated.version,
  };
  if (changed.includes("itinerary")) {
    context.daysChanged = changedDays(current.itinerary, updated.itinerary);
  }

  // Audited before the write, for the reason given in createSafariProduct.
  recordAudit({
    auditKey: deriveAuditKey(correlationId, "products.safari.updated"),
    event: "products.safari.updated",
    outcome: "success",
    actor: isNonBlankString(actor) ? actor : null,
    resource: updated.productId,
    correlationId: correlationId,
    context: context,
  });

  PRODUCTS.set(updated.productId, updated);

  return { ok: true, product: updated, changed: changed, unchanged: false };
}

function getSafariProduct(productId) {
  if (!isNonBlankString(productId)) {
    return null;
  }
  return PRODUCTS.get(productId) || null;
}

// Sorted by name, then by country to break a tie between two same-named
// packages in different places. A product book is READ BY NAME - an advisor
// looking for the Serengeti package scans for it alphabetically - which is the
// opposite of the lead book, where the question is always "what came in?".
// Records are frozen, so there is nothing to copy defensively.
function listSafariProducts() {
  return Array.from(PRODUCTS.values()).sort(function (a, b) {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.country.localeCompare(b.country);
  });
}

// Tests only. The store is process-wide, so a suite that did not reset it would
// pass or fail depending on the order its files happened to run in.
function __resetProductsForTests() {
  Array.from(PRODUCTS.keys()).forEach(function (key) {
    PRODUCTS.delete(key);
  });
}

module.exports = {
  createSafariProduct,
  updateSafariProduct,
  getSafariProduct,
  listSafariProducts,
  MUTABLE_FIELDS,
  __resetProductsForTests,
};
