// STORY-002: the one place the African section talks to a catalog source.
//
// The timeout, the retry policy, the failure classification and the structured
// failure log now live in backend/src/services/shared/callWithRetry.js, which
// was extracted when advisor notification (STORY-003) became the third caller
// needing exactly the same policy. Nothing about that policy is specific to
// safaris, so keeping a private copy here would have been two retry rules that
// could silently drift apart.
//
// What stays here is what IS specific to this section: the customer-facing
// wording for a failed read, and the service name its logs are tagged with.
// This module is deliberately a thin adapter with the same export surface it
// had before, so safariDetailsService.js and africanSectionService.js did not
// have to change when the move happened.

const {
  TimeoutError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  callWithRetry,
  classifyFailure,
  logFailure,
} = require("../shared/callWithRetry");

const SERVICE_NAME = "africa-section";

const READ_FAILURE_MESSAGE = {
  timeout: "We couldn't load safari details just now — please try again or contact an advisor.",
  unavailable: "Safari details are temporarily unavailable — contact an advisor.",
};

// Kept as a named export under the old name: callers that imported
// CatalogTimeoutError still get the class the retry loop actually throws.
const CatalogTimeoutError = TimeoutError;

function readThroughTimeout(source, arg, timeoutMs, maxAttempts) {
  return callWithRetry(source, arg, timeoutMs, maxAttempts);
}

function classifyReadFailure(read) {
  return classifyFailure(read);
}

function logReadFailure(event, errorClass, attempts, context) {
  logFailure(SERVICE_NAME, event, errorClass, attempts, context);
}

module.exports = {
  CatalogTimeoutError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  READ_FAILURE_MESSAGE,
  readThroughTimeout,
  classifyReadFailure,
  logReadFailure,
};
