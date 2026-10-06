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
const { packageRoutes } = require("./packageRoutes");
const { supplierRoutes } = require("./supplierRoutes");
const { suggestionRoutes } = require("./suggestionRoutes");
const { opsBookingRoutes } = require("./opsBookingRoutes");
const { paymentRoutes } = require("./paymentRoutes");
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
  // STORY-017. Sits after productRoutes because a package is built out of
  // products, and the table reads in dependency order. Its patterns overlap
  // nothing else here - /api/packages against /api/products/safari - so the
  // position is readability, not behaviour.
  packageRoutes,
  supplierRoutes,
  suggestionRoutes,
  // STORY-018. Last, because the booking board reads what every other area
  // produces - a booking is the end of the journey that starts with a quote and
  // a package. Its three patterns sit under /api/ops/bookings and are the first
  // use of the /api/ops prefix in this table (STORY-016's metrics endpoint is
  // /api/admin/metrics, despite its permission being named ops.metrics.read).
  // They overlap nothing else here, so the position is readability, not
  // behaviour.
  opsBookingRoutes,
  paymentRoutes
);

module.exports = { ROUTES };
