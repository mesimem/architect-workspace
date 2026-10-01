// The one route table, assembled from the per-area modules.
//
// Order is preserved from the pre-split server.js. No two patterns in this
// table overlap, so first-match-wins never actually has to arbitrate - but
// keeping the order means the split is a pure move, which is what makes
// STORY-003's unmodified test suite a valid regression proof.
//
// To add an area: create routes/<area>Routes.js exporting an array, and add it
// here. Nothing in server.js needs to change.

const { portalRoutes } = require("./portalRoutes");
const { triageRoutes } = require("./triageRoutes");
const { advisorRoutes } = require("./advisorRoutes");
const { africaRoutes } = require("./africaRoutes");
const { adminRoutes } = require("./adminRoutes");
const { crmRoutes } = require("./crmRoutes");
const { quoteRoutes } = require("./quoteRoutes");
const { proposalRoutes } = require("./proposalRoutes");
const { productRoutes } = require("./productRoutes");
const { supplierRoutes } = require("./supplierRoutes");
const { suggestionRoutes } = require("./suggestionRoutes");
const { healthRoutes } = require("./healthRoutes");

const ROUTES = [].concat(
  // STORY-016: FIRST in the table, which is the one place order matters here.
  // Matching is first-wins, and the health probe is the request that must be
  // answered when the instance is at its limit - so it should also be the
  // cheapest to find. Its patterns overlap nothing else (checked against every
  // other pattern in this folder), so putting it first changes no other
  // route's behaviour.
  healthRoutes,
  portalRoutes,
  triageRoutes,
  advisorRoutes,
  africaRoutes,
  adminRoutes,
  crmRoutes,
  quoteRoutes,
  proposalRoutes,
  productRoutes,
  supplierRoutes,
  suggestionRoutes
);

module.exports = { ROUTES };
