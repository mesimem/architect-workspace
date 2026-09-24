// STORY-003: the advisor review queue over HTTP. Moved verbatim out of
// server.js by STORY-005's split (see routes/portalRoutes.js for why).

const { getQueuedReviews } = require("../../services/advisor/advisorReviewQueue");
const { PERMISSIONS } = require("../../services/authz/permissions");

const advisorRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/advisor\/reviews$/,
    // Held by `advisor` alone; a customer and an admin both get 403.
    permission: PERMISSIONS.ADVISOR_REVIEWS_READ,
    handler: async function () {
      const reviews = getQueuedReviews();
      return { status: 200, body: { count: reviews.length, reviews: reviews } };
    },
  },
];

module.exports = { advisorRoutes };
