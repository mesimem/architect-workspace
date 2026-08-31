// STORY-002: African travel section - safari details lookup.
//
// The catalog sits behind an async boundary (catalogSource.js) and every read
// goes through catalogRead.js, which owns the timeout and the retry policy.
// Reading a catalog is the one external call this section makes, so it is the
// one place a customer can be left staring at a spinner.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if the catalog read fails? The customer never sees a hang
//     and never sees partial data. They get a status and a plain message
//     pointing them at an advisor, and the attempt is written to the
//     interaction log so the failure is auditable.
//  2. Will it retry? Only on timeout, at most DEFAULT_MAX_ATTEMPTS times with
//     a fixed pause. See the retry-policy note in catalogRead.js.
//  3. Recovery when retries are exhausted? Hand off to a human: status
//     "timeout", advisor message, logged interaction. There is no queue to
//     dead-letter to yet, and inventing one for a read would be pretend
//     machinery - a read has nothing to replay.
//  4. Handled here: unknown destination, incomplete record, source timeout,
//     source throwing. NOT handled here: a source that resolves with the
//     wrong SHAPE (garbage in a record's fields is treated as data - only
//     REQUIRED_FIELDS presence is checked); cancelling the in-flight call
//     behind a timeout (Node cannot, so a slow source keeps running after we
//     have stopped waiting for it); and concurrent reads racing, which is
//     harmless today because the source is read-only.

const { logInteraction, isValidInteractionKey } = require("./interactionLog");
const { SAFARI_CATALOG, isCompleteRecord, defaultCatalogSource } = require("./catalogSource");
const {
  CatalogTimeoutError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  READ_FAILURE_MESSAGE,
  readThroughTimeout,
  classifyReadFailure,
  logReadFailure,
} = require("./catalogRead");

const ADVISOR_MESSAGE = Object.assign(
  {
    unsupported: "Contact an advisor for this destination.",
    incomplete: "Details for this destination are being finalized — contact an advisor.",
    invalid_request: "Something went wrong on our side — please try again or contact an advisor.",
  },
  READ_FAILURE_MESSAGE
);

async function getSafariDetails({
  customerId,
  destinationId,
  interactionKey,
  source = defaultCatalogSource,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  // Checked FIRST, before any read: we do not serve what we cannot audit, and
  // a bad key is our bug, not the customer's. Same ordering as the idempotency
  // key in bookTripService.js.
  if (!isValidInteractionKey(interactionKey)) {
    logReadFailure("safari_details_lookup_failed", "ValidationError", 0, {
      destinationId: destinationId,
      reason: "invalid_interaction_key",
    });
    return { status: "invalid_request", message: ADVISOR_MESSAGE.invalid_request };
  }

  const read = await readThroughTimeout(source, destinationId, timeoutMs, maxAttempts);

  if (!read.ok) {
    const failure = classifyReadFailure(read);

    logReadFailure("safari_details_lookup_failed", failure.errorClass, read.attempts, {
      destinationId: destinationId,
    });
    // Logged like any other outcome: a customer who could not see a safari
    // still interacted with the section, and the audit trail must show it.
    logInteraction(interactionKey, {
      customerId,
      destinationId,
      outcome: failure.status,
    });
    return { status: failure.status, message: ADVISOR_MESSAGE[failure.status] };
  }

  const details = read.value;

  if (!details) {
    logInteraction(interactionKey, {
      customerId,
      destinationId,
      outcome: "unsupported",
    });
    return { status: "unsupported", message: ADVISOR_MESSAGE.unsupported };
  }

  if (!isCompleteRecord(details)) {
    logInteraction(interactionKey, {
      customerId,
      destinationId,
      outcome: "incomplete",
    });
    return { status: "incomplete", message: ADVISOR_MESSAGE.incomplete };
  }

  logInteraction(interactionKey, {
    customerId,
    destinationId,
    outcome: "viewed",
  });

  return { status: "ok", details: details };
}

// CatalogTimeoutError and SAFARI_CATALOG are re-exported so existing importers
// of this module do not have to learn about the two files it was split into.
module.exports = { getSafariDetails, CatalogTimeoutError, SAFARI_CATALOG };
