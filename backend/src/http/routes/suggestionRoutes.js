// STORY-009: trip suggestions over HTTP.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Which status code a refusal deserves,
// and what a customer is told. Nothing else. What counts as a usable
// preference, which trips are relevant, when a human must look at the answer
// and what gets audited all live in ../../services/suggestions/, because those
// are decisions and this is plumbing. A rule implemented in a route is a rule
// that only applies to callers who arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. The route DECLARES suggestions.request and
// http/server.js enforces it once, before the handler runs, auditing every
// refusal. Same reasoning as productRoutes.js: a second check here would be a
// second policy that can disagree with the first.
//
// WHY THERE IS NO CUSTOMER PROJECTION OF A SUGGESTION. productRoutes.js keeps
// its product records staff-only because they carry pricing.internal - our
// cost and our margin. A suggestion carries neither: the price on it is the
// one we sell at, which is the number a customer is entitled to see, and the
// `score` and `reasons` are what make the answer explainable rather than
// oracular. So the service's result goes out as it is. If a suggestion ever
// starts carrying a cost figure, this paragraph is the one that has to change.
//
// WHERE requestId COMES FROM, AND WHY IT IS NOT REQUIRED. The service is
// idempotent on requestId: the same id twice is audited once. A client that
// wants that guarantee sends one. A client that does not gets a per-request id
// derived from the correlation id, which means two separate asks are recorded
// as two - the honest default. Quietly collapsing two genuine requests into
// one because they came from the same customer would lose exactly the record
// the trust criterion asks for.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to a status via
//     REFUSAL_STATUS; an unmapped reason becomes 500 rather than a plausible
//     400, because an unrecognised refusal is our bug and should read like
//     one. The customer-facing sentence always comes from the service, so a
//     failure says the same thing here as it does anywhere else.
//  2. Will it retry? Nothing here retries. The engine call is already wrapped
//     in the service's timeout-and-capped-retry envelope, and the operation is
//     safe for the CALLER to retry - with a requestId it dedups, without one
//     it is recorded as a fresh ask.
//  3. Recovery path? A 503 means the suggestion engine could not answer and a
//     travel advisor has been queued. The caller is told to expect a human,
//     not to try again in a loop.
//  4. Handled: non-object bodies, every service refusal, and an empty result
//     (200 with a message, not a 404 - the request succeeded, there was just
//     nothing to show). NOT handled: pagination beyond `limit`, a GET form of
//     this route (a suggestion writes an audit row, so it is not a GET), and
//     reading someone else's past suggestions - that is the audit trail, which
//     is admin.audit.read.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  suggestTripsForRequest,
  REFUSALS,
} = require("../../services/suggestions/tripSuggestionService");

// Service refusal reason -> HTTP status. A table, so adding a refusal to the
// service and forgetting it here produces a 500 (loud) rather than a 400
// (plausible, and wrong).
const REFUSAL_STATUS = Object.freeze({
  // The caller's own input: a requestId they supplied that is too short to
  // key an audit row, or preferences we cannot read.
  [REFUSALS.UNIDENTIFIED]: 400,
  [REFUSALS.INVALID_PREFERENCES]: 400,
  // Our bug, not the caller's: server.js always supplies a correlationId, so
  // reaching this means the plumbing broke.
  [REFUSALS.MISSING_CORRELATION_ID]: 500,
  // 503, not 500: the request was fine and the thing that answers it is not
  // working. A client may reasonably come back later, and an advisor has
  // already been told.
  [REFUSALS.ENGINE_ERROR]: 503,
  [REFUSALS.NOT_AUDITABLE]: 503,
});

// Said out loud rather than left as an empty array. A customer who gets no
// suggestions should know a person is picking it up, and a client should not
// have to infer that from `suggestions.length === 0`.
const NO_SUGGESTIONS_MESSAGE =
  "We don't have a trip that matches that yet — a travel advisor will follow up with ideas.";

const FLAGGED_MESSAGE =
  "Here's a starting point — a travel advisor is looking at your request to suggest more.";

function validateSuggestionBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  return [];
}

// See the header: a caller-supplied id wins, otherwise one derived from the
// correlation id. The prefix keeps it readable in the audit trail and well
// clear of the 8-character floor an audit key needs.
function resolveRequestId(body, correlationId) {
  if (typeof body.requestId === "string" && body.requestId.trim() !== "") {
    return body.requestId;
  }
  return "sugg-req-" + correlationId;
}

const suggestionRoutes = [
  {
    // POST, not GET. Asking for suggestions writes an audit row every time and
    // may write to the advisor queue, and a GET that changes state is a GET
    // something will eventually retry, prefetch or cache.
    method: "POST",
    pattern: /^\/api\/suggestions\/trips$/,
    permission: PERMISSIONS.SUGGESTIONS_REQUEST,
    handler: async function (context) {
      const problems = validateSuggestionBody(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = await suggestTripsForRequest({
        requestId: resolveRequestId(context.body, context.correlationId),
        // Who is asking comes from the resolved principal, never from the
        // body. A request cannot nominate who it is acting as - and this id
        // is what lands in the audit row's `actor`.
        customerId: context.principal.userId,
        preferences: context.body.preferences,
        limit: context.body.limit,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        const status = REFUSAL_STATUS[result.reason] || 500;
        return {
          status: status,
          body: {
            error: result.reason,
            // The service's sentence, unchanged. One wording for one failure,
            // wherever the caller met it.
            message: result.message,
            problems: result.problems || [],
            // Tells the client a human has it, so it can say so instead of
            // offering a retry button that will not help.
            flagged: Boolean(result.flagged),
          },
        };
      }

      // 200 even when the list is empty. The request succeeded and was
      // recorded; "we have nothing for you yet" is an answer, and a 404 would
      // say the endpoint does not exist.
      return {
        status: 200,
        body: {
          strategy: result.strategy,
          confidence: result.confidence,
          count: result.suggestions.length,
          suggestions: result.suggestions,
          flagged: result.flagged,
          flagReasons: result.flagReasons,
          // True when this exact requestId had already been answered. A client
          // retrying something it is unsure of can tell.
          replayed: result.replayed,
          message:
            result.suggestions.length === 0
              ? NO_SUGGESTIONS_MESSAGE
              : result.flagged
                ? FLAGGED_MESSAGE
                : null,
        },
      };
    },
  },
];

module.exports = {
  suggestionRoutes,
  validateSuggestionBody,
  resolveRequestId,
  REFUSAL_STATUS,
  NO_SUGGESTIONS_MESSAGE,
  FLAGGED_MESSAGE,
};
