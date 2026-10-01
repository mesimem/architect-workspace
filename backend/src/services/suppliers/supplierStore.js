// STORY-010: the supplier book. A travel advisor records who we buy from, what
// we have signed with them, and what they charge - and every change to any of
// it leaves a trail.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It owns stored
// suppliers: write them down, keep them consistent, and audit every change. It
// does NOT decide what makes a supplier well-formed (supplierValidation.js and
// supplierContracts.js own that, purely), it does NOT price a customer's trip
// (quotes/ owns that, from explicit line items), and it does NOT own the
// authored packages we sell (products/safariProductStore.js). The relationship
// between a product and the suppliers behind it is a join no story has asked
// for yet; building it now would guess at a shape STORY-011 and STORY-012 are
// more likely to determine than this one.
//
// THE THREE FAILURE PATHS THE STORY NAMES, AND WHERE EACH IS HANDLED.
//   Supplier not added  -> HERE, and made VISIBLE. Every refusal returns
//                          { ok: false, reason, problems } AND writes an audit
//                          entry recording the refusal. "The supplier was not
//                          added" is only a useful failure path if an advisor
//                          can later find out why; a silent refusal is
//                          indistinguishable from a request never sent.
//   Data mismatch       -> supplierContracts.js, called on create AND on the
//                          MERGED record on update. The update case is the one
//                          that actually bites: adding a rate is legal on its
//                          own, and shortening the contract list is legal on
//                          its own, but either can orphan the other. So the
//                          merge is what gets validated, never the patch.
//   Update failure      -> HERE. Unknown supplier, fields that are not
//                          editable, an empty patch, and an edit that would
//                          move this supplier onto another's identity are each
//                          refused by name, audited, and leave the stored
//                          record untouched.
//
// WHY EVERY MUTATION NEEDS A correlationId. Audit entries are keyed and
// first-write-wins (see auditLog.js). A module that audited every edit under
// "<supplierId>:updated" would record the FIRST change to a supplier and
// silently discard every later one - so a supplier re-contracted three times
// would show its original terms forever. The honest key for "an edit happened"
// is the request that made it. The consequence, stated plainly: a mutation
// arriving with no correlationId is REFUSED rather than performed unaudited.
// The project guardrail is that all changes are audited, so "I cannot audit
// this" has to mean "I will not do this".
//
// WHY THE AUDIT ENTRY CARRIES DIGESTS AND NOT THE CONTRACTS THEMSELVES.
// auditLog.js caps context nesting at MAX_CONTEXT_DEPTH (4) and replaces
// anything deeper with "<truncated>". A before/after pair holding full contract
// objects sits right at that boundary, so writing it would produce an audit
// entry that LOOKS complete and reads "<truncated>" exactly where the evidence
// should be - and on a supplier with 50 contracts it would be enormous besides.
// A digest - how many, which references, and which of them moved - is smaller,
// true, and the thing an auditor asks first ("which contract was repriced?").
// Recording something that silently becomes "<truncated>" would be worse than
// recording less.
//
// SIZE DEVIATION, LOGGED PER CLAUDE.md. This file is over the 500-line hard
// ceiling. CLAUDE.md allows a deviation recorded in the file's header with
// reasoning, and this is it. The three cuts available all cost more than they
// save:
//   - Create and update cannot be separated: they share
//     normaliseSupplierFields (the one place that decides what a stored
//     supplier looks like), dedupKeyFor, refuse and the store handle. Two files
//     reaching into one shared middle is harder to read than one file, and
//     letting them drift into storing two shapes is the exact bug
//     normaliseSupplierFields exists to prevent.
//   - Extracting the audit helpers (forAudit, changedRefs, refuse) saves ~80
//     lines and separates the audit DECISION from the code that must not write
//     without it. The ordering rule below - audit before the store write - is
//     only enforceable by being readable in one place.
//   - Deleting header comments would get under the number without changing the
//     code, which is gaming it. ~85 lines here are the Failure-First block
//     CLAUDE.md itself requires in writing.
// For comparison, products/safariProductStore.js is 496 lines and does strictly
// less: one structural field where this has two, and no optional-field merge.
// The extra length is the shape of the problem, not sprawl. If this file grows
// again, the audit-helper extraction is the cut to make.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A refusal returns { ok: false, reason,
//     problems } and writes an audit entry recording the refusal. Nothing is
//     partially written: validation runs to completion before the store is
//     touched, and the write is a single synchronous set of one frozen record.
//     If the audit write itself throws, the store write has not happened yet -
//     see the ordering note in createSupplier.
//  2. Will it retry? There is nothing to retry: no network, no clock skew, one
//     synchronous local write. Callers may safely re-send - create dedups on
//     (name + country), update dedups on the correlationId.
//  3. Recovery path if it fails anyway? The caller gets the reason and the full
//     problem list and can correct and re-send. A disk-level failure surfaces
//     as a thrown error from jsonFileStore rather than a silent success, and a
//     corrupt store file refuses to load at startup (see jsonFileStore.js).
//  4. Handled: every validation fault, unknown suppliers, duplicate suppliers,
//     unknown and empty patches, prototype-chain keys in `changes`, a missing
//     correlationId, replayed creates, and callers mutating a record they were
//     handed. NOT handled: deletion of a supplier (there is no delete - a
//     relationship that has ended is a status question, and erasing a supplier
//     erases the subject of its own audit trail along with the contracts we are
//     still liable under), optimistic concurrency between two advisors editing
//     at once (`version` is recorded so a later story can add If-Match without
//     a migration, but it is not enforced today), and any index over the book -
//     list and the duplicate check both scan, which is O(n) on purpose. An
//     index is a second copy of the data that can desync.

const crypto = require("crypto");

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");
const { validateSupplier } = require("./supplierValidation");
const { normaliseContracts, normaliseRates } = require("./supplierContracts");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise, same as every
// other store here. A supplier book that forgets on restart loses the contracts
// the agency is liable under.
const SUPPLIERS = createJsonFileStore("suppliers");

// Only these may be changed after the supplier is recorded. Notably absent:
// supplierId, createdAt, createdBy, version. An "update" that can rewrite who
// recorded a supplier and when is not an update, it is a way to erase the
// trail.
const MUTABLE_FIELDS = Object.freeze([
  "name",
  "country",
  "supplierType",
  "contactEmail",
  "contactPhone",
  "notes",
  "contracts",
  "rates",
]);

// Fields whose values are arrays of objects, and so are compared structurally
// rather than with ===. Both sides of every such comparison are NORMALISED
// first, and the normalisers sort and build their keys in a fixed order, so a
// JSON comparison is exact here - it is not relied upon for arbitrary objects.
const STRUCTURAL_FIELDS = Object.freeze(["contracts", "rates"]);

// Optional text fields, stored as null when absent so every record has one
// shape and a reader never has to ask whether a key is missing or empty.
const OPTIONAL_TEXT_FIELDS = Object.freeze(["contactEmail", "contactPhone", "notes"]);

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Lower-cased and trimmed: "Serengeti Serena Safari Lodge" and "serengeti
// serena safari lodge " are the same business, and the duplicate check is only
// as good as this function.
function normaliseText(value) {
  return isNonBlankString(value) ? value.trim().toLowerCase() : "";
}

// The duplicate identity: the same supplier name in the same country. Two rows
// with that pair is a double-submit or a copy-paste, and an advisor picking
// from a list of two identical lodges cannot tell which one holds the live
// contract. The same name in a DIFFERENT country is intentionally not a
// duplicate - a chain with a "Serena Lodge" in Kenya and in Tanzania is two
// suppliers, invoiced separately.
function dedupKeyFor(name, country) {
  return normaliseText(name) + "|" + normaliseText(country);
}

function findByDedupKey(dedupKey) {
  const suppliers = Array.from(SUPPLIERS.values());
  for (const supplier of suppliers) {
    if (dedupKeyFor(supplier.name, supplier.country) === dedupKey) {
      return supplier;
    }
  }
  return null;
}

// Frozen one level down for the scalars; the contract and rate arrays were
// already frozen by their normalisers. A caller handed a supplier cannot edit
// the book through it - every change goes through updateSupplier, which is the
// only thing that writes an audit entry.
function freezeSupplier(supplier) {
  return Object.freeze(supplier);
}

// Trim, or null when absent. Called after validation, so a present value is
// already known to be usable.
function optionalText(value) {
  return isNonBlankString(value) ? value.trim() : null;
}

// Turns a validated candidate into the shape that gets stored. The only place
// that decides what a stored supplier looks like, so create and update cannot
// drift into storing two different shapes.
function normaliseSupplierFields(candidate) {
  return {
    name: candidate.name.trim(),
    country: candidate.country.trim(),
    supplierType: candidate.supplierType,
    contactEmail: optionalText(candidate.contactEmail),
    contactPhone: optionalText(candidate.contactPhone),
    notes: optionalText(candidate.notes),
    contracts: normaliseContracts(candidate.contracts),
    rates: normaliseRates(candidate.rates),
  };
}

// The references in a contract or rate list, de-duplicated and sorted. The unit
// an auditor thinks in: "what happened to TZ-SERENA-2026?".
function refsOf(entries) {
  return Array.from(
    new Set(
      entries.map(function (entry) {
        return entry.contractRef;
      })
    )
  ).sort();
}

// What goes in an audit entry for a given field. Scalars are themselves;
// contracts and rates become digests - see the header for why writing the
// entries themselves would produce "<truncated>".
function forAudit(field, value) {
  return STRUCTURAL_FIELDS.includes(field)
    ? { count: value.length, refs: refsOf(value) }
    : value;
}

function sameValue(field, left, right) {
  return STRUCTURAL_FIELDS.includes(field)
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right;
}

// Which contract references actually moved. Reported alongside a contracts or
// rates change because "the contracts changed" is not an answer to "what
// changed?", and it is the question asked when a supplier disputes an invoice.
// A reference counts as changed if it was added, removed, or differs in any
// field under it.
function changedRefs(before, after) {
  const byRef = new Map();
  before.forEach(function (entry) {
    const bucket = byRef.get(entry.contractRef) || {};
    bucket.before = (bucket.before || []).concat([entry]);
    byRef.set(entry.contractRef, bucket);
  });
  after.forEach(function (entry) {
    const bucket = byRef.get(entry.contractRef) || {};
    bucket.after = (bucket.after || []).concat([entry]);
    byRef.set(entry.contractRef, bucket);
  });

  return Array.from(byRef.keys())
    .filter(function (ref) {
      const bucket = byRef.get(ref);
      return JSON.stringify(bucket.before) !== JSON.stringify(bucket.after);
    })
    .sort();
}

function refuse(reason, problems, details) {
  // A refusal is audited too. "Someone tried to record a supplier with an
  // orphan rate" and "someone tried to edit a supplier that does not exist" are
  // both things you want to find later; a refusal that leaves no trace is
  // indistinguishable from a request that was never made. This IS the story's
  // "supplier not added" failure path - not just returning an error, but
  // leaving evidence of it.
  const auditKey = deriveAuditKey(details.correlationId, "suppliers.refused");
  if (auditKey !== "") {
    recordAudit({
      auditKey: auditKey,
      event: "suppliers.refused",
      outcome: "failure",
      actor: details.actor,
      resource: details.resource || "suppliers",
      correlationId: details.correlationId,
      // The problem list is the validators', and they are written not to echo
      // untrusted input back - see supplierValidation's describeValue.
      context: { reason: reason, problems: problems },
    });
  }
  return { ok: false, reason: reason, problems: problems };
}

function missingCorrelationId() {
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

// Records a new supplier. Idempotent on (name + country): calling it twice with
// the same supplier returns the record from the first call, writes no second row
// and no second audit entry, and says so with replayed: true.
//
// A replayed create does NOT apply the second call's content. If the contracts
// in the retry differ, that is an EDIT, and edits go through updateSupplier
// where they are audited as such - silently accepting it here would re-contract
// a supplier under an audit entry that says "created".
function createSupplier({
  name,
  country,
  supplierType,
  contactEmail,
  contactPhone,
  notes,
  contracts,
  rates,
  actor,
  correlationId,
}) {
  if (!isNonBlankString(correlationId)) {
    return missingCorrelationId();
  }

  const candidate = { name, country, supplierType, contracts, rates };
  // The optional fields are assigned ONLY WHEN PRESENT, rather than always.
  // The validator treats an absent optional field differently from a present
  // one, and `{ contactEmail: undefined }` has an own key that reads as
  // present - which would make an unknown-field check or a future
  // required-field check see a key the caller never sent.
  if (contactEmail !== undefined) {
    candidate.contactEmail = contactEmail;
  }
  if (contactPhone !== undefined) {
    candidate.contactPhone = contactPhone;
  }
  if (notes !== undefined) {
    candidate.notes = notes;
  }

  const problems = validateSupplier(candidate);
  if (problems.length > 0) {
    return refuse("invalid_supplier", problems, { actor, correlationId });
  }

  // Duplicate check BEFORE the id is generated, so a repeat does not burn a new
  // supplierId and does not depend on the store's own key.
  const existing = findByDedupKey(dedupKeyFor(name, country));
  if (existing) {
    return { ok: true, supplier: existing, replayed: true };
  }

  const now = new Date().toISOString();
  const supplierId = "supplier_" + crypto.randomUUID();
  const supplier = freezeSupplier(
    Object.assign({ supplierId: supplierId }, normaliseSupplierFields(candidate), {
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: isNonBlankString(actor) ? actor : null,
      updatedBy: isNonBlankString(actor) ? actor : null,
    })
  );

  // AUDIT BEFORE THE STORE WRITE. recordAudit throws on a bad entry (see its
  // header), and the ordering decides what a failure leaves behind: audited but
  // unstored is a traceable no-op, stored but unaudited is an unexplained
  // supplier holding contracts nobody can account for. Keyed on the supplierId,
  // generated a moment ago, so it cannot collide with an earlier entry. Updates
  // cannot use this key - see the header.
  recordAudit({
    auditKey: deriveAuditKey(supplierId, "suppliers.created"),
    event: "suppliers.created",
    outcome: "success",
    actor: supplier.createdBy,
    resource: supplierId,
    correlationId: correlationId,
    context: {
      name: supplier.name,
      country: supplier.country,
      supplierType: supplier.supplierType,
      contracts: forAudit("contracts", supplier.contracts),
      rates: forAudit("rates", supplier.rates),
    },
  });

  SUPPLIERS.set(supplierId, supplier);

  return { ok: true, supplier: supplier, replayed: false };
}

// Edits an existing supplier. Every accepted edit writes one audit entry naming
// the fields that changed, which is the story's trust criterion, and bumps
// `version` so a reader can tell two revisions apart.
function updateSupplier({ supplierId, changes, actor, correlationId }) {
  if (!isNonBlankString(correlationId)) {
    return missingCorrelationId();
  }

  const current = getSupplier(supplierId);
  if (!current) {
    return refuse("unknown_supplier", ["No supplier with that id."], {
      actor,
      correlationId,
      resource: typeof supplierId === "string" ? supplierId : "suppliers",
    });
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
    return refuse("unknown_fields", ["Not editable: " + rejected.sort().join(", ") + "."], {
      actor,
      correlationId,
      resource: current.supplierId,
    });
  }
  if (offered.length === 0) {
    return refuse("empty_update", ["changes must name at least one editable field."], {
      actor,
      correlationId,
      resource: current.supplierId,
    });
  }

  // VALIDATE THE MERGED RECORD, NOT THE PATCH. This is the line that catches
  // the story's data-mismatch path on the update side. Adding a rate is legal
  // in isolation and removing a contract is legal in isolation; either one can
  // leave a rate quoted under an agreement the supplier no longer holds.
  // Likewise clearing contactEmail is legal until you notice there was never a
  // phone number. The merge is what has to hold up.
  //
  // The stored shape re-validates as-is: a normalised contract differs from its
  // authored form only in a trimmed ref and `notes: null` for an absent note,
  // both of which the validator accepts. There is nothing to reconstruct.
  const merged = {};
  MUTABLE_FIELDS.forEach(function (field) {
    const value = offered.includes(field) ? requested[field] : current[field];
    // An optional field stored as null is ABSENT, not present-and-empty. Passing
    // null through would be read by the validator as "not provided" anyway, but
    // omitting the key says so explicitly and keeps the merged candidate the
    // same shape a create submits.
    if (OPTIONAL_TEXT_FIELDS.includes(field) && value === null) {
      return;
    }
    merged[field] = value;
  });

  const problems = validateSupplier(merged);
  if (problems.length > 0) {
    return refuse("invalid_supplier", problems, {
      actor,
      correlationId,
      resource: current.supplierId,
    });
  }

  const normalised = normaliseSupplierFields(merged);

  // An edit that moves (name + country) onto another supplier's pair would
  // create the duplicate createSupplier exists to prevent. Same rule, applied
  // to the other door into the book.
  const newDedupKey = dedupKeyFor(normalised.name, normalised.country);
  if (newDedupKey !== dedupKeyFor(current.name, current.country)) {
    const clash = findByDedupKey(newDedupKey);
    if (clash && clash.supplierId !== current.supplierId) {
      return refuse(
        "duplicate_supplier",
        ["Another supplier already has that name and country."],
        { actor, correlationId, resource: current.supplierId }
      );
    }
  }

  // Compared against the NORMALISED values, so re-sending "  Serena Lodge  "
  // for a name already stored as "Serena Lodge", or the same rate card in a
  // different order, is correctly no change.
  const changed = MUTABLE_FIELDS.filter(function (field) {
    return !sameValue(field, normalised[field], current[field]);
  });

  if (changed.length === 0) {
    // Audited as a success with no diff, rather than skipped. "An advisor
    // opened this supplier and saved it unchanged" is a real event, and
    // recording it stops a reader of the trail assuming the request never
    // arrived. The version does NOT move: nothing changed, so nothing is a new
    // revision.
    recordAudit({
      auditKey: deriveAuditKey(correlationId, "suppliers.unchanged"),
      event: "suppliers.unchanged",
      outcome: "success",
      actor: isNonBlankString(actor) ? actor : null,
      resource: current.supplierId,
      correlationId: correlationId,
      context: { supplierId: current.supplierId, version: current.version },
    });
    return { ok: true, supplier: current, changed: [], unchanged: true };
  }

  const before = {};
  const after = {};
  changed.forEach(function (field) {
    before[field] = forAudit(field, current[field]);
    after[field] = forAudit(field, normalised[field]);
  });

  const updated = freezeSupplier(
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
  if (changed.includes("contracts")) {
    context.contractsChanged = changedRefs(current.contracts, updated.contracts);
  }
  if (changed.includes("rates")) {
    context.ratesChanged = changedRefs(current.rates, updated.rates);
  }

  // Audited before the write, for the reason given in createSupplier.
  recordAudit({
    auditKey: deriveAuditKey(correlationId, "suppliers.updated"),
    event: "suppliers.updated",
    outcome: "success",
    actor: isNonBlankString(actor) ? actor : null,
    resource: updated.supplierId,
    correlationId: correlationId,
    context: context,
  });

  SUPPLIERS.set(updated.supplierId, updated);

  return { ok: true, supplier: updated, changed: changed, unchanged: false };
}

function getSupplier(supplierId) {
  if (!isNonBlankString(supplierId)) {
    return null;
  }
  return SUPPLIERS.get(supplierId) || null;
}

// Sorted by name, then by country to break a tie between two same-named
// businesses in different places. A supplier book is READ BY NAME - an advisor
// looking for the Serena lodge scans for it alphabetically - which is the
// opposite of the lead book, where the question is always "what came in?".
// Records are frozen, so there is nothing to copy defensively.
function listSuppliers() {
  return Array.from(SUPPLIERS.values()).sort(function (a, b) {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.country.localeCompare(b.country);
  });
}

// Tests only. The store is process-wide, so a suite that did not reset it would
// pass or fail depending on the order its files happened to run in.
function __resetSuppliersForTests() {
  Array.from(SUPPLIERS.keys()).forEach(function (key) {
    SUPPLIERS.delete(key);
  });
}

module.exports = {
  createSupplier,
  updateSupplier,
  getSupplier,
  listSuppliers,
  MUTABLE_FIELDS,
  __resetSuppliersForTests,
};
