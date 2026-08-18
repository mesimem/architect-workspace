// STORY-002: in-memory stand-in for logging customer interactions with the
// African travel section (REQ-017 audit-log intent). Idempotent by the
// caller-supplied interactionKey: logging the same key twice returns the
// existing entry instead of creating a duplicate.

const INTERACTIONS = new Map();

function logInteraction(interactionKey, record) {
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

module.exports = { logInteraction, getLoggedInteractions };
