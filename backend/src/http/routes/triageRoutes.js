// STORY-003: request triage over HTTP. Moved verbatim out of server.js by
// STORY-005's split (see routes/portalRoutes.js for why). Behaviour unchanged -
// STORY-003's own test suite is the proof, and it was re-run unmodified.

const { triageRequest } = require("../../services/advisor/requestTriageService");

// Envelope validation only: is this the right SHAPE to hand to the service?
// Whether the request is clear enough to act on is the triage service's
// judgement, not the router's, and duplicating those rules here would give us
// two sets that drift.
function validateTriageBody(body) {
  const problems = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  if (typeof body.requestId !== "string" || body.requestId.length < 8 || body.requestId.length > 128) {
    problems.push("requestId must be a string of 8-128 characters");
  }
  if (typeof body.customerId !== "string" || body.customerId.trim() === "") {
    problems.push("customerId must be a non-empty string");
  }
  if (body.travelDates !== undefined && (body.travelDates === null || typeof body.travelDates !== "object")) {
    problems.push("travelDates must be an object when supplied");
  }
  if (body.partySize !== undefined && typeof body.partySize !== "number") {
    problems.push("partySize must be a number when supplied");
  }
  if (body.notes !== undefined && typeof body.notes !== "string") {
    problems.push("notes must be a string when supplied");
  }
  return problems;
}

const triageRoutes = [
  {
    method: "POST",
    pattern: /^\/api\/requests\/triage$/,
    roles: ["customer", "advisor"],
    handler: async function (context) {
      const problems = validateTriageBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      // A customer may only submit requests as themselves. An advisor acts on
      // behalf of customers, so they may name any. This is CLAUDE.md's
      // "the resource belongs to them" rule at the only place it can be
      // enforced.
      if (context.principal.role === "customer" && context.body.customerId !== context.principal.userId) {
        return {
          status: 403,
          body: {
            error: "forbidden",
            message: "A customer may only submit requests for themselves.",
          },
        };
      }

      const result = await triageRequest(context.body);
      return { status: 200, body: result };
    },
  },
];

module.exports = { triageRoutes, validateTriageBody };
