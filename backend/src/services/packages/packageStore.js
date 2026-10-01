// STORY-017: the package book. An advisor combines products the agency already
// sells into one offering, and every version of that offering is audited.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It owns stored
// packages: write them down, keep them consistent, and audit every change. It
// does NOT decide whether components fit together (packageCompatibility.js
// owns that, purely), does NOT add up the price (packagePricing.js), does NOT
// author the products being combined (products/safariProductStore.js), and does
// NOT decide who may create one - that is the central permission gate in
// http/server.js, against the permissions the routes declare. A second check
// here would be a second policy, and two policies can disagree.
//
// A PACKAGE HOLDS IDS, NEVER COPIES. The components are `{ kind, productId,
// startDay }` and nothing else; the itinerary, the country and the price all
// stay in the product book and are looked up on write. The tempting
// alternative - denormalising the product into the package "so reads are
// cheap" - means a product manager repricing the Masai Mara (which STORY-015
// exists to let them do) leaves every package that sells it quoting last
// quarter's figure, silently and forever. A stored copy of a number that lives
// somewhere else is a bug with a delay on it.
//
// THE CONSEQUENCE OF THAT CHOICE, STATED HONESTLY: the `pricing` block on a
// stored package IS a derived copy, frozen at the moment of the last write. It
// is stored rather than computed on read because it is the figure the advisor
// SAW and agreed to, and an offering whose price changes between being quoted
// and being read is not an offering. So a product reprice does not retro-
// actively move a package's price - it means the package is out of date, and
// re-saving it picks up the new figure and audits the change. That is a
// deliberate trade, not an oversight; see the known limits at the bottom.
//
// THE THREE FAILURE PATHS THE STORY NAMES, AND WHERE EACH IS HANDLED.
//   Incompatible products   -> packageCompatibility.js, called on create AND on
//                              the MERGED record on update. Refused with the
//                              full problem list, never half-written.
//   Creation fails due to   -> shared/auditedCommit.js. The write is proved
//   a system error             durable by reading it back, and if the audit
//                              entry cannot be written the write is ROLLED
//                              BACK and the caller is refused. A stored package
//                              nobody can account for is the one state this
//                              module refuses to leave behind.
//   Unauthorized access     -> NOT here. See the paragraph above.
//
// WHY EVERY MUTATION NEEDS A correlationId. Refusals are audited under a key
// derived from the request that caused them (see auditLog.js: entries are
// keyed and first-write-wins). A mutation arriving with no correlationId is
// REFUSED rather than performed unaudited - the project guardrail is that all
// changes are audited, so "I cannot audit this" has to mean "I will not do
// this". The HTTP layer always supplies one, so reaching that refusal means a
// programming error rather than a bad request.
//
// WHY THE AUDIT ENTRY CARRIES A COMPONENT DIGEST AND NOT THE COMPONENTS.
// auditLog.js caps context nesting at MAX_CONTEXT_DEPTH and replaces anything
// deeper with "<truncated>". A before/after pair holding arrays of component
// objects sits at that cap, so writing it would produce an entry that LOOKS
// complete and actually reads "<truncated>" where the evidence should be. The
// digest - how many components, which product ids, which days - is flat,
// smaller, true, and the thing an auditor asks first.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A refusal returns { ok: false, reason,
//     problems } and, where there is a correlationId to key it on, writes an
//     audit entry recording the refusal. Nothing is partially written:
//     validation and pricing both run to completion before the store is
//     touched, and the write itself is one commit that rolls back if it cannot
//     be audited.
//  2. Will it retry? There is nothing to retry - no network, no clock skew, one
//     synchronous local write. Callers may safely re-send: create dedups on the
//     package name, update dedups on nothing but is naturally idempotent (the
//     same patch applied twice reports the second as `unchanged`).
//  3. Recovery path if it fails anyway? The caller gets the reason and the full
//     problem list and can correct and re-send. A NOT_SAVED or
//     AUDIT_UNAVAILABLE refusal means the store is unchanged and the request
//     can simply be repeated. A disk-level failure surfaces as a refusal rather
//     than a silent success, and a corrupt store file refuses to load at
//     startup (see jsonFileStore.js).
//  4. Handled: every compatibility and pricing fault, unknown packages,
//     duplicate names, unknown and empty patches, prototype-chain keys in
//     `changes`, a missing correlationId, replayed creates, a store that loses
//     or stales a write, an audit that throws, and callers mutating a record
//     they were handed. NOT handled: deletion or retirement of a package (there
//     is no delete - erasing a package erases the subject of its own audit
//     trail, same call as the product book), optimistic concurrency between two
//     advisors editing at once (`version` is recorded so a later story can add
//     If-Match without a migration, but it is not enforced today), stale
//     pricing against a repriced product (see the trade above - a later story
//     wanting "packages affected by this reprice" should add that query here
//     rather than denormalising), BOOKING a package (STORY-018 owns bookings),
//     and any index over the book: list and the duplicate check both scan,
//     which is O(n) on purpose, because an index is a second copy that can
//     desync.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit } = require("../audit/auditLog");
const { createAuditedCommit, REASONS: COMMIT_REASONS } = require("../shared/auditedCommit");
const { getSafariProduct } = require("../products/safariProductStore");
const { validatePackage, normaliseComponents } = require("./packageCompatibility");
const { derivePackagePricing } = require("./packagePricing");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise, same bargain as
// every other store here. A package book that forgets on restart loses the
// offerings the agency is actively selling.
const PACKAGES = createJsonFileStore("travel-packages");

const { commit, auditNoChange } = createAuditedCommit({
  subject: "package",
  service: "packages",
});

// Only these may be changed after the package is created. Notably absent:
// packageId, createdAt, createdBy, version, and pricing. An "update" that can
// rewrite who built a package and when is not an update, it is a way to erase
// the trail - and pricing is DERIVED, so letting a caller set it would be a way
// to sell a package at a number its own components do not support.
const MUTABLE_FIELDS = Object.freeze(["name", "summary", "components", "discountBasisPoints"]);

const EVENTS = Object.freeze({
  CREATED: "packages.created",
  UPDATED: "packages.updated",
  UNCHANGED: "packages.unchanged",
  REFUSED: "packages.refused",
});

const REASONS = Object.freeze({
  MISSING_CORRELATION_ID: "missing_correlation_id",
  INVALID_PACKAGE: "invalid_package",
  // Separate from INVALID_PACKAGE even though both are 400s. "These products
  // cannot be combined" and "this discount sells below cost" send an advisor to
  // two different parts of the same form, and collapsing them would make the
  // error message do work the reason code should.
  INVALID_PRICING: "invalid_pricing",
  DUPLICATE_PACKAGE: "duplicate_package",
  UNKNOWN_PACKAGE: "unknown_package",
  UNKNOWN_FIELDS: "unknown_fields",
  EMPTY_UPDATE: "empty_update",
  // Re-exported rather than restated, so a route maps every refusal onto a
  // status from ONE list. Two lists that must agree are one list that will not.
  NOT_SAVED: COMMIT_REASONS.NOT_SAVED,
  AUDIT_UNAVAILABLE: COMMIT_REASONS.AUDIT_UNAVAILABLE,
});

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function nowIso() {
  return new Date().toISOString();
}

function refuse(reason, problems) {
  return { ok: false, reason: reason, problems: problems };
}

// A refusal changed nothing, so recording it is best effort - see the asymmetry
// explained in shared/auditedCommit.js. It is still recorded: "an advisor tried
// to combine two safaris that overlap" is exactly the kind of thing you want to
// find later, and a refusal that leaves no trace is indistinguishable from a
// request that was never made.
function auditRefusal(audit, { reason, actor, correlationId, resource }) {
  return auditNoChange(audit, {
    event: EVENTS.REFUSED,
    outcome: "failure",
    reason: reason,
    actor: actor,
    correlationId: correlationId,
    resource: resource || "packages",
  });
}

// Lower-cased and trimmed: "Kenya & Tanzania Circuit" and "kenya & tanzania
// circuit " are the same offering, and the duplicate check is only as good as
// this function.
function normaliseText(value) {
  return isNonBlankString(value) ? value.trim().toLowerCase() : "";
}

// THE DUPLICATE IDENTITY IS THE NAME ALONE. Unlike the product book, which
// dedups on (name + country), a package has no single country - that is rather
// the point of it. Two packages with the same name is a double-submit or a
// copy-paste, and an advisor picking from a list of two identical names cannot
// tell which one is current.
function findByName(store, name) {
  const wanted = normaliseText(name);
  if (wanted === "") {
    return null;
  }
  return (
    Array.from(store.values()).find(function (entry) {
      return entry && normaliseText(entry.name) === wanted;
    }) || null
  );
}

// The default product lookup. Dispatches on nothing today because
// COMPONENT_KINDS holds one entry; when a flight or lodging module lands this
// is the ONE place that learns about it, and the resolver gains the component's
// kind as an argument. Never throws - packageCompatibility.js documents that it
// relies on that.
function defaultResolveProduct(productId) {
  try {
    return getSafariProduct(productId);
  } catch (error) {
    return null;
  }
}

// What goes in an audit entry for the components: a flat digest, not the
// objects. See the header on why the objects would read "<truncated>".
function componentsDigest(components) {
  return {
    count: components.length,
    // Product ids are OURS (generated by the product book), so echoing them is
    // safe and is the thing an auditor actually needs - "which products went
    // into this offering?".
    productIds: components.map(function (entry) {
      return entry.productId;
    }),
    startDays: components.map(function (entry) {
      return entry.startDay;
    }),
  };
}

// What goes in an audit entry for the price: the figures, including the ones
// under `internal`. An audit trail that recorded the sell price but not the
// margin could not answer "was this sold at a loss?", which is the question the
// below-cost refusal exists to prevent ever needing to ask.
function pricingDigest(pricing) {
  return {
    currency: pricing.currency,
    perPersonCents: pricing.perPersonCents,
    listPerPersonCents: pricing.internal.listPerPersonCents,
    discountBasisPoints: pricing.internal.discountBasisPoints,
    costPerPersonCents: pricing.internal.costPerPersonCents,
    marginPerPersonCents: pricing.internal.marginPerPersonCents,
  };
}

function forAudit(field, value) {
  return field === "components" ? componentsDigest(value) : value;
}

// Compared structurally, with both sides already normalised - the normaliser
// builds its keys in a fixed order, so a JSON comparison is exact here. It is
// not relied upon for arbitrary objects.
function sameValue(field, left, right) {
  return field === "components" ? JSON.stringify(left) === JSON.stringify(right) : left === right;
}

// Validates the candidate and prices it, in that order. Returns either the two
// derived blocks or a refusal, so both call sites below share one definition of
// "is this package sellable?" rather than keeping two that must agree.
//
// ORDER MATTERS: compatibility first. A package whose components overlap should
// be told that, not told its price is below cost - and pricing a set of
// products that cannot be taken together produces a number with no meaning.
function buildPackageBody(candidate, resolveProduct) {
  const problems = validatePackage(candidate, resolveProduct);
  if (problems.length > 0) {
    return refuse(REASONS.INVALID_PACKAGE, problems);
  }

  const priced = derivePackagePricing(
    { components: candidate.components, discountBasisPoints: candidate.discountBasisPoints },
    resolveProduct
  );
  if (!priced.ok) {
    return refuse(REASONS.INVALID_PRICING, priced.problems);
  }

  return {
    ok: true,
    name: candidate.name.trim(),
    summary: candidate.summary.trim(),
    components: normaliseComponents(candidate.components),
    discountBasisPoints: priced.pricing.internal.discountBasisPoints,
    pricing: priced.pricing,
  };
}

// Creates a package. Idempotent on the package NAME: calling it twice with the
// same offering returns the record from the first call, writes no second row
// and no second audit entry, and says so with replayed: true.
//
// A replayed create does NOT apply the second call's content. If the discount
// in the retry differs, that is an EDIT, and edits go through updatePackage
// where they are audited as such - silently accepting it here would reprice an
// offering under an audit entry that says "created".
function createPackage(
  { name, summary, components, discountBasisPoints, actor, correlationId },
  { store = PACKAGES, audit = recordAudit, resolveProduct = defaultResolveProduct, now = nowIso } = {}
) {
  if (!isNonBlankString(correlationId)) {
    // Refused before validation and before any write. Not audited, because
    // there is no id to key the entry on - see the header.
    return refuse(REASONS.MISSING_CORRELATION_ID, ["correlationId is required."]);
  }

  const built = buildPackageBody(
    { name, summary, components, discountBasisPoints },
    resolveProduct
  );
  if (!built.ok) {
    auditRefusal(audit, { reason: built.reason, actor, correlationId });
    return built;
  }

  // Duplicate check BEFORE the id is generated, so a repeat does not burn a new
  // packageId and does not depend on the store's own key.
  const existing = findByName(store, built.name);
  if (existing) {
    return { ok: true, travelPackage: existing, replayed: true };
  }

  const timestamp = now();
  const packageId = "package_" + crypto.randomUUID();
  const record = Object.freeze({
    packageId: packageId,
    name: built.name,
    summary: built.summary,
    components: built.components,
    discountBasisPoints: built.discountBasisPoints,
    pricing: built.pricing,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: isNonBlankString(actor) ? actor : null,
    updatedBy: isNonBlankString(actor) ? actor : null,
  });

  // THE ONLY PATH THAT WRITES. commit saves, reads back to prove it saved,
  // audits, and rolls the write back if the audit throws - which is the story's
  // "package creation fails due to system error" path, handled rather than
  // left as a stored package nobody can account for.
  const committed = commit(store, audit, {
    id: packageId,
    version: 1,
    record: record,
    previous: null,
    event: EVENTS.CREATED,
    actor: actor,
    correlationId: correlationId,
    context: {
      name: record.name,
      components: componentsDigest(record.components),
      pricing: pricingDigest(record.pricing),
      version: 1,
    },
  });
  if (!committed.ok) {
    return committed;
  }

  return { ok: true, travelPackage: record, replayed: false };
}

// Edits an existing package. Every accepted edit writes one audit entry naming
// the fields that changed, which is the story's trust criterion, and bumps
// `version` so a reader can tell two revisions apart.
function updatePackage(
  { packageId, changes, actor, correlationId },
  { store = PACKAGES, audit = recordAudit, resolveProduct = defaultResolveProduct, now = nowIso } = {}
) {
  if (!isNonBlankString(correlationId)) {
    return refuse(REASONS.MISSING_CORRELATION_ID, ["correlationId is required."]);
  }

  const current = getPackage(packageId, { store });
  if (!current) {
    auditRefusal(audit, {
      reason: REASONS.UNKNOWN_PACKAGE,
      actor,
      correlationId,
      resource: typeof packageId === "string" ? packageId : "packages",
    });
    return refuse(REASONS.UNKNOWN_PACKAGE, ["No package with that id."]);
  }

  const requested =
    changes && typeof changes === "object" && !Array.isArray(changes) ? changes : {};

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
    auditRefusal(audit, {
      reason: REASONS.UNKNOWN_FIELDS,
      actor,
      correlationId,
      resource: current.packageId,
    });
    return refuse(REASONS.UNKNOWN_FIELDS, [
      "Not editable: " + rejected.sort().join(", ") + ".",
    ]);
  }
  if (offered.length === 0) {
    auditRefusal(audit, {
      reason: REASONS.EMPTY_UPDATE,
      actor,
      correlationId,
      resource: current.packageId,
    });
    return refuse(REASONS.EMPTY_UPDATE, ["changes must name at least one editable field."]);
  }

  // VALIDATE AND PRICE THE MERGED RECORD, NOT THE PATCH. This is the line that
  // catches the story's incompatibility path on the update side: adding one
  // component is legal in isolation and may overlap three that are already
  // stored, and raising the discount alone can push a package that was fine
  // below the cost of components it still holds. Either patch is legal by
  // itself; the merge is what has to hold up.
  const merged = {};
  MUTABLE_FIELDS.forEach(function (field) {
    merged[field] = offered.includes(field) ? requested[field] : current[field];
  });

  const built = buildPackageBody(merged, resolveProduct);
  if (!built.ok) {
    auditRefusal(audit, {
      reason: built.reason,
      actor,
      correlationId,
      resource: current.packageId,
    });
    return built;
  }

  // An edit that moves the name onto another package's name would create the
  // duplicate createPackage exists to prevent. Same rule, applied to the other
  // door into the book.
  if (normaliseText(built.name) !== normaliseText(current.name)) {
    const clash = findByName(store, built.name);
    if (clash && clash.packageId !== current.packageId) {
      auditRefusal(audit, {
        reason: REASONS.DUPLICATE_PACKAGE,
        actor,
        correlationId,
        resource: current.packageId,
      });
      return refuse(REASONS.DUPLICATE_PACKAGE, ["Another package already has that name."]);
    }
  }

  // Compared against the NORMALISED values, so re-sending "  Grand Circuit  "
  // for a name already stored as "Grand Circuit", or the same components in a
  // different order, is correctly no change.
  const changed = MUTABLE_FIELDS.filter(function (field) {
    return !sameValue(field, built[field], current[field]);
  });

  if (changed.length === 0) {
    // Audited as a no-change rather than skipped. "An advisor opened this
    // package and saved it unchanged" is a real event, and recording it stops a
    // reader of the trail assuming the request never arrived. The version does
    // NOT move: nothing changed, so nothing is a new revision. Best effort, per
    // auditedCommit's asymmetry - nothing was written, so there is nothing to
    // protect by refusing.
    auditNoChange(audit, {
      event: EVENTS.UNCHANGED,
      outcome: "success",
      reason: "no_fields_changed",
      actor: actor,
      correlationId: correlationId,
      resource: current.packageId,
    });
    return { ok: true, travelPackage: current, changed: [], unchanged: true };
  }

  const before = {};
  const after = {};
  changed.forEach(function (field) {
    before[field] = forAudit(field, current[field]);
    after[field] = forAudit(field, built[field]);
  });

  const version = current.version + 1;
  const updated = Object.freeze(
    Object.assign({}, current, {
      name: built.name,
      summary: built.summary,
      components: built.components,
      discountBasisPoints: built.discountBasisPoints,
      // Re-derived on EVERY accepted edit, even one that only touches the
      // summary. A component's price may have moved in the product book since
      // the last save, and a package whose stored price disagrees with its own
      // components is worse than one that is merely out of date.
      pricing: built.pricing,
      version: version,
      updatedAt: now(),
      updatedBy: isNonBlankString(actor) ? actor : null,
    })
  );

  const committed = commit(store, audit, {
    id: updated.packageId,
    version: version,
    record: updated,
    // The row to restore if the audit cannot be written. Without it a failed
    // audit would leave the NEW version stored and unaccounted for.
    previous: current,
    event: EVENTS.UPDATED,
    actor: actor,
    correlationId: correlationId,
    context: {
      fields: changed,
      before: before,
      after: after,
      pricing: pricingDigest(updated.pricing),
      version: version,
    },
  });
  if (!committed.ok) {
    return committed;
  }

  return { ok: true, travelPackage: updated, changed: changed, unchanged: false };
}

function getPackage(packageId, { store = PACKAGES } = {}) {
  if (!isNonBlankString(packageId)) {
    return null;
  }
  return store.get(packageId) || null;
}

// Sorted by name. A package book is READ BY NAME - an advisor looking for the
// grand-circuit offering scans for it alphabetically - which is the opposite of
// the lead book, where the question is always "what came in?". Records are
// frozen, so there is nothing to copy defensively.
function listPackages({ store = PACKAGES } = {}) {
  return Array.from(store.values()).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
}

// Tests only. The store is process-wide, so a suite that did not reset it would
// pass or fail depending on the order its files happened to run in.
function __resetPackagesForTests() {
  Array.from(PACKAGES.keys()).forEach(function (key) {
    PACKAGES.delete(key);
  });
}

module.exports = {
  createPackage,
  updatePackage,
  getPackage,
  listPackages,
  MUTABLE_FIELDS,
  EVENTS,
  REASONS,
  __resetPackagesForTests,
};
