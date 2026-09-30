// STORY-007: the rule that no quote exists without an audit entry.
//
// THE MECHANISM NOW LIVES IN backend/src/services/shared/auditedCommit.js,
// moved there by STORY-013 when trip proposals needed the identical guarantee.
// This file is the quote-shaped adapter over it and holds no logic of its own.
// The reasoning below is unchanged and is still the canonical explanation of
// WHY the rule is shaped this way - the shared module's header covers only why
// it is shared.
//
// Nothing observable moved with it. The shared door derives its audit keys, log
// event names, log context field and refusal messages from the noun "quote", so
// they are the same strings this file used to hold. A refactor that renamed an
// audit key would be a break in the trail, not a tidy-up.
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

const { createAuditedCommit } = require("../shared/auditedCommit");

// "quote" is the noun every derived string is built from; "quotes" is the log
// service tag these lines already carried.
const { commit, auditNoChange, REASONS } = createAuditedCommit({
  subject: "quote",
  service: "quotes",
});

// The quote-shaped call. `quoteId` and `version` are named here so the generic
// door never has to know which field on a record is its key.
function commitQuote(store, audit, { quote, previous, event, actor, correlationId, context }) {
  const committed = commit(store, audit, {
    id: quote.quoteId,
    version: quote.version,
    record: quote,
    previous: previous,
    event: event,
    actor: actor,
    correlationId: correlationId,
    context: context,
  });
  // Refusals pass straight through; a success is renamed to the noun the
  // callers next door already read.
  return committed.ok ? { ok: true, quote: committed.record } : committed;
}

module.exports = { commitQuote, auditNoChange, REASONS };
