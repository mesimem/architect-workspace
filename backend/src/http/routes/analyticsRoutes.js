// STORY-012: the analytics dashboard endpoint. Revenue and booking trends for
// a manager, as JSON - the same shape every other dashboard in this repo uses
// (see opsBookingRoutes.js); there is no frontend in this repo to render it.
//
// Who may call it is declared by the permission and enforced by server.js.
// What the figures mean, and what "partial" or "mismatch" says about them, is
// analyticsService.js and revenueAnalytics.js - this file only maps results to
// HTTP.
//
// FAILURE PATH "DASHBOARD ERROR". When analytics were not generated - the
// booking log could not be read, or the run could not be audited - the caller
// gets a 503 with a stable error code and a sentence a manager can act on,
// never a 200 with empty or zeroed figures that would read as "no revenue".

const { PERMISSIONS } = require("../../services/authz/permissions");
const analyticsService = require("../../services/analytics/analyticsService");

const { FAILURE_REASONS } = analyticsService;

const FAILURES = Object.freeze({
  [FAILURE_REASONS.INVALID_REQUEST]: {
    status: 400,
    message: "The analytics request was malformed.",
  },
  [FAILURE_REASONS.SOURCE_UNAVAILABLE]: {
    status: 503,
    message: "Analytics could not be generated: booking data is unavailable. Try again shortly.",
  },
  [FAILURE_REASONS.AUDIT_UNAVAILABLE]: {
    status: 503,
    message: "Analytics could not be generated: the run could not be recorded in the audit log.",
  },
});

// A factory so tests can drive the failure paths; the live table uses the real service.
function createAnalyticsRoutes(overrides) {
  return [
    {
      method: "GET",
      pattern: /^\/api\/analytics\/revenue$/,
      permission: PERMISSIONS.ANALYTICS_READ,
      handler: async function (context) {
        const result = analyticsService.generateAnalytics(
          { actor: context.principal.userId, correlationId: context.correlationId },
          overrides
        );
        if (result.ok) {
          return { status: 200, body: { correlationId: result.correlationId, analytics: result.analytics } };
        }
        const failure = FAILURES[result.reason] || { status: 500, message: "Analytics failed." };
        return {
          status: failure.status,
          body: {
            error: result.reason,
            message: failure.message,
            problems: result.problems || [],
          },
        };
      },
    },
  ];
}

const analyticsRoutes = createAnalyticsRoutes();

module.exports = { analyticsRoutes, createAnalyticsRoutes };
