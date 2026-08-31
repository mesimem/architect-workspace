// STORY-002: the one place the African section talks to a catalog source.
//
// Extracted from safariDetailsService.js when a second reader (the section
// listing) appeared. Two readers with two hand-rolled timeout loops would
// drift apart, and the retry policy is exactly the kind of rule that must not
// differ depending on which screen the customer is on.
//
// This module owns: the timeout, the retry policy, the vocabulary for a failed
// read, and the structured failure log. It owns no domain knowledge - it does
// not know what a safari is.

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 2; // one initial call plus one retry
const RETRY_DELAY_MS = 100;

const READ_FAILURE_MESSAGE = {
  timeout: "We couldn't load safari details just now — please try again or contact an advisor.",
  unavailable: "Safari details are temporarily unavailable — contact an advisor.",
};

// Distinct class so the retry loop can tell "too slow" from "broken", and so
// the log carries a stable error_class instead of a generic Error.
class CatalogTimeoutError extends Error {
  constructor(timeoutMs) {
    super("Catalog read timed out after " + timeoutMs + "ms");
    this.name = "CatalogTimeoutError";
    this.errorClass = "TimeoutError";
  }
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Races the source call against a timer. The timer is always cleared, so a
// fast call does not hold the event loop open waiting for a timeout that will
// never matter.
function callWithTimeout(source, arg, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new CatalogTimeoutError(timeoutMs));
    }, timeoutMs);

    Promise.resolve()
      .then(function () {
        return source(arg);
      })
      .then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

// Returns { ok: true, value, attempts } or { ok: false, error, attempts } -
// never throws, so callers handle failure as data rather than control flow.
//
// Retry policy: only a timeout is retried, at most maxAttempts times with a
// fixed RETRY_DELAY_MS pause. A source that throws is NOT retried - a rejected
// credential or a malformed row does not fix itself, and retrying it just
// doubles the load on something already broken.
async function readThroughTimeout(
  source,
  arg,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
) {
  let lastError;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const value = await callWithTimeout(source, arg, timeoutMs);
      return { ok: true, value: value, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!(error instanceof CatalogTimeoutError)) {
        break;
      }
      if (attempt < maxAttempts) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return { ok: false, error: lastError, attempts: attempt };
}

// Turns a failed read into the two things every caller needs: the status the
// customer sees, and a stable error_class for the log.
//
// A source that throws a bare `new Error(...)` would otherwise log error_class
// "Error", which CLAUDE.md rules out as a classification because it says
// nothing. Anything thrown without naming itself is classified by what it
// means to us: the catalog is unreachable.
function classifyReadFailure(read) {
  const timedOut = read.error instanceof CatalogTimeoutError;
  if (timedOut) {
    return { status: "timeout", errorClass: "TimeoutError" };
  }
  const thrownName = read.error && read.error.name;
  return {
    status: "unavailable",
    errorClass: !thrownName || thrownName === "Error" ? "UpstreamUnavailable" : thrownName,
  };
}

// Structured JSON to stderr, per CLAUDE.md's observability rules. stderr and
// not stdout so this stays usable if a service is ever driven over a stdio
// protocol. Callers pass only IDs the customer themselves supplied - no
// secrets, no personal data.
function logReadFailure(event, errorClass, attempts, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "africa-section",
      event: event,
      outcome: "failure",
      error_class: errorClass,
      context: Object.assign({ attempts: attempts }, context),
    })
  );
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
