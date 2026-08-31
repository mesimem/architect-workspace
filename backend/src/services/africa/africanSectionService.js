// STORY-002: the African travel section itself - what a customer sees when
// they navigate to it, before they have picked anything.
//
// Why this exists: getSafariDetails() can only answer if the customer already
// knows a destination ID. The story is "explore African travel options", and
// the acceptance criterion begins "given a customer navigates to the African
// section" - so there has to be something to navigate TO. This is it.
//
// What it returns is a SUMMARY row per destination, not the full record:
// enough to render a list and choose from, and a detailsComplete flag so the
// caller can mark a destination as not-yet-bookable rather than letting a
// customer click into it and hit the "being finalized" message with no warning.
// Detail belongs to getSafariDetails(); this list deliberately does not
// duplicate it.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if the read fails? The section renders as a status and an
//     advisor message, never a hang and never a half-list. A partial list is
//     worse than no list: a customer who sees three of our eight destinations
//     thinks that is the whole catalog.
//  2. Will it retry? Only on timeout, capped - the shared policy in
//     catalogRead.js, identical to the detail lookup by construction.
//  3. Recovery when retries are exhausted? Hand off to a human: status
//     "timeout", advisor message, logged interaction.
//  4. Handled here: source timeout, source throwing, an empty catalog, and a
//     source that resolves to something that is not an array. NOT handled:
//     paging or filtering (the catalog is two rows; paging a list this size
//     would be machinery with no user), sorting by anything but catalog order,
//     and cancelling the in-flight call behind a timeout - Node cannot.

const { logInteraction, isValidInteractionKey } = require("./interactionLog");
const { isCompleteRecord, defaultCatalogListSource } = require("./catalogSource");
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  READ_FAILURE_MESSAGE,
  readThroughTimeout,
  classifyReadFailure,
  logReadFailure,
} = require("./catalogRead");

const SECTION_MESSAGE = Object.assign(
  {
    empty: "No African destinations are listed right now — contact an advisor to plan a trip.",
    invalid_request: "Something went wrong on our side — please try again or contact an advisor.",
  },
  READ_FAILURE_MESSAGE
);

// New objects, not references into the catalog, so a caller cannot reach
// through the returned list and mutate the source.
function toSummary(record) {
  return {
    destinationId: record.destinationId,
    name: record.name,
    country: record.country,
    detailsComplete: isCompleteRecord(record),
  };
}

async function listAfricanDestinations({
  customerId,
  interactionKey,
  source = defaultCatalogListSource,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  // Checked FIRST, before any read: we do not serve what we cannot audit.
  if (!isValidInteractionKey(interactionKey)) {
    logReadFailure("african_section_list_failed", "ValidationError", 0, {
      reason: "invalid_interaction_key",
    });
    return { status: "invalid_request", message: SECTION_MESSAGE.invalid_request };
  }

  const read = await readThroughTimeout(source, undefined, timeoutMs, maxAttempts);

  if (!read.ok) {
    const failure = classifyReadFailure(read);

    logReadFailure("african_section_list_failed", failure.errorClass, read.attempts, {});
    // Browsing is an interaction too. A customer who opened the section and
    // saw nothing is exactly the event an advisor wants to find in the log.
    logInteraction(interactionKey, {
      customerId,
      action: "browse_section",
      outcome: failure.status,
    });
    return { status: failure.status, message: SECTION_MESSAGE[failure.status] };
  }

  // A source that resolves to a non-array is a broken source, not an empty
  // section. Treating it as empty would quietly show the customer nothing and
  // report success - the exact silent failure CLAUDE.md forbids.
  if (!Array.isArray(read.value)) {
    logReadFailure("african_section_list_failed", "ContractViolation", read.attempts, {
      receivedType: typeof read.value,
    });
    logInteraction(interactionKey, {
      customerId,
      action: "browse_section",
      outcome: "unavailable",
    });
    return { status: "unavailable", message: SECTION_MESSAGE.unavailable };
  }

  const destinations = read.value.map(toSummary);

  logInteraction(interactionKey, {
    customerId,
    action: "browse_section",
    outcome: "browsed",
    destinationCount: destinations.length,
  });

  if (destinations.length === 0) {
    // Not a failure - nothing is seeded yet. Still worth a message, because an
    // empty page with no explanation reads as a bug to the customer.
    return { status: "ok", destinations: destinations, message: SECTION_MESSAGE.empty };
  }

  return { status: "ok", destinations: destinations };
}

module.exports = { listAfricanDestinations };
