// The rule that no record exists without an audit entry. One implementation,
// for every store that has to obey it.
//
// Extracted from backend/src/services/quotes/quoteWriteGuard.js when STORY-013
// needed the same guarantee for trip proposals. The rule itself is unchanged -
// read that file's header for the reasoning behind the rollback and the
// read-back, which is still the canonical explanation. What moved here is the
// mechanism; what stayed there is the quote-shaped adapter over it.
//
// WHY THIS IS A FACTORY AND NOT A FUNCTION WITH MORE ARGUMENTS. Two things
// differ per caller and both are naming, not behaviour: the noun for the thing
// being committed ("quote", "proposal") and the service tag on its logs. Taking
// them once, at wiring time, means the commit call site stays as short as it
// was and no caller can pass a different noun on different calls and split its
// own audit trail in two.
//
// EVERY STRING A CALLER SEES IS DERIVED FROM THAT ONE NOUN - the audit key
// discriminator, the log event names, the log context field, and the two
// refusal messages. That is what made the extraction provably behaviour-
// preserving for quotes: with subject "quote" the derived strings are exactly
// the literals the quote guard used to hold, so STORY-007's audit keys and log
// lines did not move. A shared helper that quietly renames an audit key is not
// a refactor, it is a break in the trail.
//
// THE TWO HELPERS ARE NOT SYMMETRICAL, ON PURPOSE.
//   commit         - the audit entry is the thing being protected. If it fails,
//                    the write is undone and the caller is refused.
//   auditNoChange  - nothing was written, so there is nothing to protect. A
//                    failure is logged and the caller's outcome is unaffected.
// Turning a 400 into a 503 because the audit log hiccuped on a REFUSAL would be
// the worse trade: the refusal already left the system exactly as it was.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? commit returns { ok: false, reason, problems }
//     and leaves no partial state. It never throws.
//  2. Will it retry? No. The only I/O is a local synchronous store write, and an
//     immediate retry of a failed local write generally fails again. Callers
//     retry safely instead, via their own correlationId dedup.
//  3. Recovery path? A refused write needs no cleanup - that is the point of the
//     rollback. The one unrecoverable case (the rollback ITSELF fails) is logged
//     at error level with the id, because at that point only a person can put it
//     right.
//  4. Handled here: a store that throws on write, a store that accepts a write
//     and loses it, a store that keeps the OLD version, an audit that throws,
//     and a rollback that throws. NOT handled: another process writing the same
//     row between our write and our read-back (single-process store; the real
//     fix is the database), and crash-during-rollback, which leaves the
//     unaudited row on disk.

const { deriveAuditKey } = require("../audit/auditLog");

const REASONS = Object.freeze({
  NOT_SAVED: "not_saved",
  AUDIT_UNAVAILABLE: "audit_unavailable",
});

function refuse(reason, problems) {
  return { ok: false, reason: reason, problems: problems };
}

function usableActor(actor) {
  return typeof actor === "string" && actor.trim() !== "" ? actor : null;
}

// Structured JSON to stderr, per CLAUDE.md's observability rules.
function logEvent(service, level, event, outcome, error, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: service,
      event: event,
      outcome: outcome,
      error_class: error ? error.errorClass || error.name || "Error" : undefined,
      context: context,
    })
  );
}

// `subject` is the noun ("quote"); `service` is the log tag ("quotes").
function createAuditedCommit({ subject, service }) {
  // Deliberately identical for both ways a save can fail. The caller is told the
  // truth - nothing changed - without being told which internal component let us
  // down, which is not their business and not actionable by them.
  const NOT_SAVED_MESSAGE = "The " + subject + " could not be saved. Nothing was changed.";
  const AUDIT_UNAVAILABLE_MESSAGE =
    "The " +
    subject +
    " could not be recorded in the audit trail, so it was not saved. Please try again.";

  // "quoteId" / "proposalId" - the typed field name the logs used before this
  // was shared. A generic "id" here would have been a quiet observability
  // regression: every query written against the old field would stop matching.
  const ID_FIELD = subject + "Id";

  function logContext(id, version) {
    const context = {};
    context[ID_FIELD] = id;
    if (version !== undefined) {
      context.version = version;
    }
    return context;
  }

  // Audits something that changed NO state - a refusal, or a save that turned
  // out to be a no-op. Best effort; see the header on why this one is allowed to
  // fail quietly and commit is not.
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
        resource: resource || subject,
        correlationId: correlationId,
        // The reason only. Never the submitted body: a rejected submission can
        // carry a customer's details, and the audit trail persists to disk
        // forever.
        context: { reason: reason },
      });
      return true;
    } catch (error) {
      // Swallowed deliberately, and deliberately not silent - the caller's
      // outcome does not change, but this does not vanish. Without the log line
      // this would be the empty catch CLAUDE.md forbids.
      logEvent(service, "warn", subject + ".unaudited_no_change", "partial", error, {
        reason: reason,
        correlationId: correlationId,
      });
      return false;
    }
  }

  // THE ONLY PATH THAT WRITES. Save, prove it saved, audit, and undo everything
  // if the audit fails. `previous` is the row to restore on rollback, or null
  // when the row is new.
  //
  // Returns { ok: true, record } or a refusal. Callers never write to the store
  // themselves - a second write path would come with its own opinion about
  // auditing, which is exactly the drift this centralises away.
  function commit(store, audit, { id, version, record, previous, event, actor, correlationId, context }) {
    try {
      store.set(id, record);
    } catch (error) {
      logEvent(service, "error", subject + ".save_failed", "failure", error, logContext(id));
      return refuse(REASONS.NOT_SAVED, [NOT_SAVED_MESSAGE]);
    }

    // The read-back. Version is compared as well as presence, so a store that
    // kept the OLD row is caught too - not just one that kept nothing.
    const persisted = store.get(id);
    if (!persisted || persisted.version !== version) {
      logEvent(
        service,
        "error",
        subject + ".save_not_durable",
        "failure",
        null,
        logContext(id, version)
      );
      return refuse(REASONS.NOT_SAVED, [NOT_SAVED_MESSAGE]);
    }

    try {
      audit({
        // Keyed on the version, so v1 and v2 are two entries. Keyed on the id
        // alone, the audit log's first-write-wins rule would keep the creation
        // and silently discard every later change - the exact opposite of what
        // the trust criteria ask for.
        auditKey: deriveAuditKey(id, event + ".v" + version),
        event: event,
        outcome: "success",
        actor: usableActor(actor),
        resource: id,
        correlationId: correlationId,
        // Ids, figures and field names only - never note text, which is
        // free-form and may quote the customer.
        context: context,
      });
    } catch (error) {
      // COMPENSATING ACTION. The record is stored but unaudited, the one state
      // this module refuses to leave behind. Put it back the way it was.
      try {
        if (previous) {
          store.set(id, previous);
        } else {
          store.delete(id);
        }
        logEvent(
          service,
          "warn",
          subject + ".rolled_back_unaudited",
          "success",
          error,
          logContext(id, version)
        );
      } catch (rollbackError) {
        // An unaudited record we could not remove. Nothing further can be done
        // in process, so say it as loudly as the log allows: this one needs a
        // person.
        logEvent(
          service,
          "error",
          subject + ".rollback_failed",
          "failure",
          rollbackError,
          logContext(id, version)
        );
      }
      return refuse(REASONS.AUDIT_UNAVAILABLE, [AUDIT_UNAVAILABLE_MESSAGE]);
    }

    return { ok: true, record: record };
  }

  return { commit: commit, auditNoChange: auditNoChange, REASONS: REASONS };
}

module.exports = { createAuditedCommit, REASONS };
