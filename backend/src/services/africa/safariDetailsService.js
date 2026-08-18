// STORY-002: African travel section — safari details lookup. In-memory
// seed stands in for a real destination catalog until one exists.

const { logInteraction } = require("./interactionLog");

const REQUIRED_FIELDS = ["description", "durationDays", "priceUSD"];

const SAFARI_CATALOG = {
  "SF-300": {
    destinationId: "SF-300",
    name: "Serengeti Migration Safari",
    country: "Tanzania",
    durationDays: 7,
    priceUSD: 4200,
    description: "Follow the wildebeest migration across the Serengeti plains.",
  },
  // Stub entry: destination exists in the catalog but its details haven't
  // been filled in yet. Exercises the "missing safari details" failure path.
  "SF-301": {
    destinationId: "SF-301",
    name: "Kilimanjaro Trek",
    country: "Tanzania",
  },
};

function isComplete(details) {
  return REQUIRED_FIELDS.every(function (field) {
    return details[field] !== undefined;
  });
}

function getSafariDetails({ customerId, destinationId, interactionKey }) {
  const details = SAFARI_CATALOG[destinationId];

  if (!details) {
    logInteraction(interactionKey, {
      customerId,
      destinationId,
      outcome: "unsupported",
    });
    return {
      status: "unsupported",
      message: "Contact an advisor for this destination.",
    };
  }

  if (!isComplete(details)) {
    logInteraction(interactionKey, {
      customerId,
      destinationId,
      outcome: "incomplete",
    });
    return {
      status: "incomplete",
      message: "Details for this destination are being finalized — contact an advisor.",
    };
  }

  logInteraction(interactionKey, {
    customerId,
    destinationId,
    outcome: "viewed",
  });

  return { status: "ok", details };
}

module.exports = { getSafariDetails, SAFARI_CATALOG };
