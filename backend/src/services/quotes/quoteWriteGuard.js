// STORY-007: the rule that no quote exists without an audit entry.
//
// Extracted from quoteStore.js when that file crossed CLAUDE.md's 500-line
// hard ceiling, which requires a split before more code lands. The line the
// split follows is a real seam, not a line count: quoteStore.js owns the
// LIFECYCLE of a quote (what a revision means, which fields may change, what
// counts as a duplicate), and this file owns the GUARANTEE that every change
// to that lifecycle reaches the audit trail or does not happen at all.
//
// Worth separating because the two change for different reasons. New editable
// fields, new statuses and new pricing rules all land next door. The rule
// here should not move at all - and if it ever does, that change deserves to
// be reviewed on its own rather than buried in a diff about quote fields.
//
// THE GUARANTEE, IN ONE SENTENCE: after commitQuote returns, either the quote
// is stored AND audited, or neither.
//
// WHY THAT NEEDS A ROLLBACK. The project guardrail is "the system must
// maintain audit logs for all transactions and changes". The obvious order -
// save, then audit - breaks it the moment auditing fails: a live quote with
// no record of who issued it, which is precisely the state an audit trail
// exists to make impossible. So a failed audit undoes the write. A create is
// undone by deleting the row; a revision is undone by restoring the previous
// version, which the caller still holds. Both are safe compensating actions
// because nothing outside this function has seen the new state yet.
//
// WHY THE WRITE IS READ BACK. "Quote not saved" is one of the story's named
// failure paths, and the dangerous version is silent: the write returns, the
// advisor sees a confirmation, and the row is not there. A Map-shaped store
// backed by a file cannot be trusted to have persisted just because `set`
// returned. So we look.
//
// THE TWO AUDIT HELPERS ARE NOT SYMMETRICAL, ON PURPOSE.
//   commitQuote    - the audit entry is the thing being protected. If it
//                    fails, the write is undone and the caller is refused.
//   auditNoChange  - nothing was written, so there is nothing to protect. A
//                    failure is logged and the caller's outcome is unaffected.
// Turning a 400 into a 503 because the audit log hiccuped on a REFUSAL would
// be the worse trade: the refusal already left the system exactly as it was.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? commitQuote returns { ok: false, reason }
//     and leaves no partial state. It never throws.
//  2. Will it retry? No. The only I/O is a local synchronous store write, and
//     an immediate retry of a failed local write generally fails again. The
//     caller retries safely instead, via the correlationId dedup next door.
//  3. Recovery path? A refused write needs no cleanup - that is the point of
//     the rollback. The one unrecoverable case (the rollback ITSELF fails) is
//     logged at error level with the quoteId, because at that point only a
//     person can put it right.
//  4. Handled here: a store that throws on write, a store that accepts a write
//     and loses it, an audit that throws, and a rollback that throws. NOT
//     handled: another process writing the same row between our write and our
//     read-back (single-process store; the real fix is the database), and
//     crash-during-rollback, which leaves the unaudited row on disk.

const { deriveAuditKey } = require("../audit/auditLog");

const REASONS = Object.freeze({
  NOT_SAVED: "not_saved",
  AUDIT_UNAVAILABLE: "audit_unavailable",
});

// Deliberately identical for both ways a save can fail. The caller is told the
// truth - nothing changed - without being told which internal component let us
// down, which is not their business and not actionable by them.
const NOT_SAVED_MESSAGE = "The quote could not be saved. Nothing was changed.";
const AUDIT_UNAVAILABLE_MESSAGE =
  "The quote could not be recorded in the audit trail, so it was not saved. Please try again.";

function refuse(reason, problems) {
  return { ok: false, reason: reason, problems: problems };
}

function usableActor(actor) {
  return typeof actor === "string" && actor.trim() !== "" ? actor : null;
}

// Structured JSON to stderr, per CLAUDE.md's observability rules.
function logQuoteEvent(level, event, outcome, error, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: "quotes",
      event: event,
      outcome: outcome,
      error_class: error ? error.errorClass || error.name || "Error" : undefined,
      context: context,
    })
  );
}

// Audits something that changed NO state - a refusal, or a save that turned
// out to be a no-op. Best effort; see the header on why this one is allowed to
// fail quietly and commitQuote is not.
function auditNoChange(audit, { event, outcome = "failure", reason, actor, correlationId, resource }) {
  const auditKey = deriveAuditKey(correlationId, event + "." + reason);
  if (auditKey === "") {
    // No usable correlation id means no key we could dedup on. Recording under
    // a made-up key would put an entry in the trail that no later request could
    // ever match.
    return false;
  }
  try {
    audit({
      auditKey: auditKey,
      event: event,
      outcome: outcome,
      actor: usableActor(actor),
      resource: resource || "quote",
      correlationId: correlationId,
      // The reason only. Never the submitted body: a rejected quote can carry
      // a customer's details, and the audit trail persists to disk forever.
      context: { reason: reason },
    });
    return true;
  } catch (error) {
    // Swallowed deliberately, and deliberately not silent - the caller's
    // outcome does not change, but this does not vanish. Without the log line
    // this would be the empty catch CLAUDE.md forbids.
    logQuoteEvent("warn", "quote.unaudited_no_change", "partial", error, {
      reason: reason,
      correlationId: correlationId,
    });
    return false;
  }
}

// THE ONLY PATH THAT WRITES A QUOTE. Save, prove it saved, audit, and undo
// everything if the audit fails. `previous` is the row to restore on rollback,
// or null when the row is new.
//
// Returns { ok: true, quote } or a refusal. Callers never write to the store
// themselves - a second write path would come with its own opinion about
// auditing, which is exactly the drift this centralises away.
function commitQuote(store, audit, { quote, previous, event, actor, correlationId, context }) {
  try {
    store.set(quote.quoteId, quote);
  } catch (error) {
    logQuoteEvent("error", "quote.save_failed", "failure", error, { quoteId: quote.quoteId });
    return refuse(REASONS.NOT_SAVED, [NOT_SAVED_MESSAGE]);
  }

  // The read-back. Version is compared as well as presence, so a store that
  // kept the OLD row is caught too - not just one that kept nothing.
  const persisted = store.get(quote.quoteId);
  if (!persisted || persisted.version !== quote.version) {
    logQuoteEvent("error", "quote.save_not_durable", "failure", null, {
      quoteId: quote.quoteId,
      version: quote.version,
    });
    return refuse(REASONS.NOT_SAVED, [NOT_SAVED_MESSAGE]);
  }

  try {
    audit({
      // Keyed on the version, so v1 and v2 are two entries. Keyed on the
      // quoteId alone, the audit log's first-write-wins rule would keep the
      // creation and silently discard every later revision - the exact
      // opposite of what the trust criterion asks for.
      auditKey: deriveAuditKey(quote.quoteId, event + ".v" + quote.version),
      event: event,
      outcome: "success",
      actor: usableActor(actor),
      resource: quote.quoteId,
      correlationId: correlationId,
      // Ids, figures and field names only - never note text, which is
      // free-form and may quote the customer.
      context: context,
    });
  } catch (error) {
    // COMPENSATING ACTION. The quote is stored but unaudited, the one state
    // this module refuses to leave behind. Put it back the way it was.
    try {
      if (previous) {
        store.set(quote.quoteId, previous);
      } else {
        store.delete(quote.quoteId);
      }
      logQuoteEvent("warn", "quote.rolled_back_unaudited", "success", error, {
        quoteId: quote.quoteId,
        version: quote.version,
      });
    } catch (rollbackError) {
      // An unaudited quote we could not remove. Nothing further can be done in
      // process, so say it as loudly as the log allows: this one needs a person.
      logQuoteEvent("error", "quote.rollback_failed", "failure", rollbackError, {
        quoteId: quote.quoteId,
        version: quote.version,
      });
    }
    return refuse(REASONS.AUDIT_UNAVAILABLE, [AUDIT_UNAVAILABLE_MESSAGE]);
  }

  return { ok: true, quote: quote };
}

module.exports = { commitQuote, auditNoChange, REASONS };
