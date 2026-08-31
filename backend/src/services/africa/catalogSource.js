// STORY-002: the African destination catalog, behind an async boundary.
//
// Today this reads an in-memory seed. Tomorrow it is a database table or a
// supplier API. The boundary is async NOW so that swap does not change the
// shape of every caller later, and so the services can wrap it in a timeout
// (see catalogRead.js) instead of discovering they need one the first time a
// supplier hangs in production.
//
// Contract, single record: given a destinationId, resolve to the catalog
// record, or to `undefined` when this catalog does not carry that destination.
// "Unknown destination" is a normal answer, not an error - it is the customer
// asking about somewhere we do not sell, which the service turns into the
// contact-an-advisor message. Reserve throwing for the source itself being
// broken (connection refused, malformed row, auth rejected).
//
// Contract, listing: resolve to an array of records, possibly empty. An empty
// African section is a real state (nothing seeded yet), not a failure.
//
// This module also owns REQUIRED_FIELDS - what makes a record complete is a
// property of the record, so it lives with the record rather than in whichever
// service happens to check it first.

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

function isCompleteRecord(record) {
  return REQUIRED_FIELDS.every(function (field) {
    return record[field] !== undefined;
  });
}

async function defaultCatalogSource(destinationId) {
  return SAFARI_CATALOG[destinationId];
}

async function defaultCatalogListSource() {
  return Object.values(SAFARI_CATALOG);
}

module.exports = {
  SAFARI_CATALOG,
  REQUIRED_FIELDS,
  isCompleteRecord,
  defaultCatalogSource,
  defaultCatalogListSource,
};
