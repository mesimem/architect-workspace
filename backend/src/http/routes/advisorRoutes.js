// STORY-003: the advisor review queue over HTTP. Moved verbatim out of
// server.js by STORY-005's split (see routes/portalRoutes.js for why).

const { getQueuedReviews } = require("../../services/advisor/advisorReviewQueue");

const advisorRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/advisor\/reviews$/,
    roles: ["advisor"], // the queue is advisor-only; a customer gets 403
    handler: async function () {
      const reviews = getQueuedReviews();
      return { status: 200, body: { count: reviews.length, reviews: reviews } };
    },
  },
];

module.exports = { advisorRoutes };
