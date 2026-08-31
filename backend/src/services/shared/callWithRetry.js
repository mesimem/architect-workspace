// Shared external-boundary helper: call something that might be slow or
// broken, with an explicit timeout and capped retries.
//
// Extracted from backend/src/services/africa/catalogRead.js when advisor
// notification became the third caller needing the same policy (CLAUDE.md's
// extract-at-three rule). It knows nothing about safaris, advisors or
// catalogs - it takes a function and returns what happened.
//
// The retry policy is the whole reason this is shared rather than copied:
// "which failures are worth retrying" must not differ depending on which
// service you happen to be reading.

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 2; // one initial call plus one retry
const RETRY_DELAY_MS = 100;

// Distinct class so a retry loop can tell "too slow" from "broken", and so
// logs carry a stable error_class instead of a generic Error.
class TimeoutError extends Error {
  constructor(timeoutMs) {
    super("Call timed out after " + timeoutMs + "ms");
    this.name = "TimeoutError";
    this.errorClass = "TimeoutError";
  }
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Races the call against a timer. The timer is always cleared, so a fast call
// does not hold the event loop open waiting for a timeout that will never
// matter.
//
// Known limit, true of any JS timeout: the in-flight call cannot be cancelled.
// After we stop waiting, a slow callee keeps running. Callers whose callee has
// side effects must therefore be idempotent - which is why every notifier and
// writer in this repo is keyed.
function callWithTimeout(fn, arg, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);

    Promise.resolve()
      .then(function () {
        return fn(arg);
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
// fixed RETRY_DELAY_MS pause. Something that THROWS is not retried - a
// rejected credential or a malformed payload does not fix itself, and
// retrying it just doubles the load on something already broken.
async function callWithRetry(
  fn,
  arg,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
) {
  let lastError;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const value = await callWithTimeout(fn, arg, timeoutMs);
      return { ok: true, value: value, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!(error instanceof TimeoutError)) {
        break;
      }
      if (attempt < maxAttempts) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return { ok: false, error: lastError, attempts: attempt };
}

// Turns a failed call into the two things every caller needs: a status, and a
// stable error_class for the log.
//
// Something that throws a bare `new Error(...)` would otherwise log
// error_class "Error", which CLAUDE.md rules out as a classification because
// it says nothing. Anything thrown without naming itself is classified by what
// it means to us: the far side is unreachable.
function classifyFailure(result) {
  if (result.error instanceof TimeoutError) {
    return { status: "timeout", errorClass: "TimeoutError" };
  }
  const thrownName = result.error && result.error.name;
  return {
    status: "unavailable",
    errorClass: !thrownName || thrownName === "Error" ? "UpstreamUnavailable" : thrownName,
  };
}

// Structured JSON to stderr, per CLAUDE.md's observability rules. stderr and
// not stdout so this stays usable if a service is ever driven over a stdio
// protocol. Callers pass IDs and codes only - no secrets, no personal data,
// no free text we have not sanitised.
function logFailure(service, event, errorClass, attempts, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: service,
      event: event,
      outcome: "failure",
      error_class: errorClass,
      context: Object.assign({ attempts: attempts }, context),
    })
  );
}

module.exports = {
  TimeoutError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  callWithRetry,
  classifyFailure,
  logFailure,
};
