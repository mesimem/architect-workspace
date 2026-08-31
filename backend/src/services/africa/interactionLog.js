// STORY-002: in-memory stand-in for logging customer interactions with the
// African travel section (REQ-017 audit-log intent, and the project guardrail
// "the system must maintain audit logs for all transactions and changes").
//
// Idempotent by the caller-supplied interactionKey: logging the same key twice
// returns the existing entry instead of creating a duplicate.
//
// WHY THE KEY IS GUARDED. The key used to be accepted as-is, so `undefined`
// was a perfectly good key. That meant a caller who forgot to pass one logged
// their first interaction and then silently REPLAYED it forever - every later
// interaction matched the `undefined` entry already in the map and was dropped.
// The log would look healthy and be quietly wrong, which is the worst state an
// audit log can be in. Bounds mirror the idempotency key in
// backend/src/services/booking/bookTripService.js so the two agree.
//
// Callers must therefore treat a bad key as a refusal to serve, not as a
// logging nuisance: an unauditable read of the section is a compliance hole,
// so the services check the key BEFORE doing any work. The throw here is the
// last line of defence, for a caller that skipped that check.

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;

const INTERACTIONS = new Map();

class InvalidInteractionKeyError extends Error {
  constructor(interactionKey) {
    // Reports the shape of the bad key, never a value that might be pasted
    // into a log from somewhere untrusted.
    const shape =
      typeof interactionKey === "string"
        ? "a string of length " + interactionKey.length
        : "type " + typeof interactionKey;
    super(
      "interactionKey must be a string of " +
        MIN_KEY_LENGTH +
        "-" +
        MAX_KEY_LENGTH +
        " characters; received " +
        shape
    );
    this.name = "InvalidInteractionKeyError";
    this.errorClass = "ValidationError";
  }
}

function isValidInteractionKey(interactionKey) {
  return (
    typeof interactionKey === "string" &&
    interactionKey.length >= MIN_KEY_LENGTH &&
    interactionKey.length <= MAX_KEY_LENGTH
  );
}

function logInteraction(interactionKey, record) {
  if (!isValidInteractionKey(interactionKey)) {
    throw new InvalidInteractionKeyError(interactionKey);
  }
  if (INTERACTIONS.has(interactionKey)) {
    return INTERACTIONS.get(interactionKey);
  }
  const entry = Object.assign({ interactionKey }, record);
  INTERACTIONS.set(interactionKey, entry);
  return entry;
}

function getLoggedInteractions() {
  return Array.from(INTERACTIONS.values());
}

module.exports = {
  logInteraction,
  getLoggedInteractions,
  isValidInteractionKey,
  InvalidInteractionKeyError,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
};
