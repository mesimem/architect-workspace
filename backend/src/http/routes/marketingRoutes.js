// STORY-019: email campaigns to customer segments, for a sales manager.
//
//   GET  /api/marketing/segments                  list defined segments
//   POST /api/marketing/segments                  define one; returns who matches
//   GET  /api/marketing/segments/:segmentId       one segment and its members today
//   PUT  /api/marketing/contacts/:customerId      record an address / opt-out
//   POST /api/marketing/campaigns                 send to a segment; per-customer report
//
// Who may call each is the permission, enforced by server.js. What a segment
// means and how a send is made safe are in services/marketing/ - this file only
// maps outcomes to HTTP. The actor always comes from the resolved principal,
// never from the body.

const { PERMISSIONS } = require("../../services/authz/permissions");
const segmentStore = require("../../services/marketing/segmentStore");
const contactPreferences = require("../../services/marketing/contactPreferences");
const campaignSender = require("../../services/marketing/campaignSender");

const STATUS_BY_REASON = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  mail_not_configured: 503,
  not_saved: 503,
  audit_unavailable: 503,
});

function refusal(result) {
  return {
    status: STATUS_BY_REASON[result.reason] || 500,
    body: { error: result.reason, problems: result.problems || [] },
  };
}

// decodeURIComponent throws on a malformed sequence; that is a 400, not a 500
// (same guard as crmRoutes.js).
function decodeParam(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return null;
  }
}

function badParam(name) {
  return { status: 400, body: { error: "invalid_request", problems: [{ field: name, problem: "is malformed" }] } };
}

function actorOf(context) {
  return { actor: context.principal.userId, correlationId: context.correlationId };
}

const marketingRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/marketing\/segments$/,
    permission: PERMISSIONS.MARKETING_READ,
    handler: async function () {
      return { status: 200, body: { segments: segmentStore.listSegments() } };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/marketing\/segments$/,
    permission: PERMISSIONS.MARKETING_WRITE,
    handler: async function (context) {
      const result = segmentStore.defineSegment(Object.assign({ input: context.body }, actorOf(context)));
      if (!result.ok) return refusal(result);
      return {
        status: result.replayed ? 200 : 201,
        body: { replayed: result.replayed, segment: result.segment, members: result.members },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/marketing\/segments\/([^/]+)$/,
    permission: PERMISSIONS.MARKETING_READ,
    handler: async function (context) {
      const segmentId = decodeParam(context.params[0]);
      if (!segmentId) return badParam("segmentId");
      const result = segmentStore.getSegment(segmentId);
      if (!result.ok) return refusal(result);
      return { status: 200, body: { segment: result.segment, members: result.members } };
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/marketing\/contacts\/([^/]+)$/,
    permission: PERMISSIONS.MARKETING_WRITE,
    handler: async function (context) {
      const customerId = decodeParam(context.params[0]);
      if (!customerId) return badParam("customerId");
      const result = contactPreferences.setPreferences(
        Object.assign({ customerId: customerId, change: context.body }, actorOf(context))
      );
      if (!result.ok) return refusal(result);
      return { status: 200, body: { changed: result.changed, contact: result.contact } };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/marketing\/campaigns$/,
    permission: PERMISSIONS.MARKETING_WRITE,
    handler: async function (context) {
      const result = await campaignSender.sendCampaign(Object.assign({ input: context.body }, actorOf(context)));
      if (!result.ok) return refusal(result);
      return { status: 200, body: { replayed: result.replayed, report: result.report } };
    },
  },
];

module.exports = { marketingRoutes };
