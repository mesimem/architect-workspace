// STORY-003: the African section over HTTP. Moved verbatim out of server.js by
// STORY-005's split (see routes/portalRoutes.js for why).

const { listAfricanDestinations } = require("../../services/africa/africanSectionService");
const { getSafariDetails } = require("../../services/africa/safariDetailsService");

const africaRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/africa\/destinations$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      const result = await listAfricanDestinations({
        customerId: context.principal.userId,
        interactionKey: "HTTP-BROWSE-" + context.correlationId,
      });
      return { status: result.status === "ok" ? 200 : 503, body: result };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/africa\/destinations\/([A-Za-z0-9-]{1,64})$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      const result = await getSafariDetails({
        customerId: context.principal.userId,
        destinationId: context.params[0],
        interactionKey: "HTTP-DETAIL-" + context.correlationId,
      });
      // "We do not sell that" is a 404 to a client, not a server error. A
      // catalog we could not read is a 503 - it may work in a moment.
      const statusByOutcome = {
        ok: 200,
        unsupported: 404,
        incomplete: 409,
        timeout: 503,
        unavailable: 503,
        invalid_request: 400,
      };
      return { status: statusByOutcome[result.status] || 500, body: result };
    },
  },
];

module.exports = { africaRoutes };
