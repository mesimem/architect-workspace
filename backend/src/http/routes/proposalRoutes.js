// STORY-013: trip proposals over HTTP - the advisor's desk.
//
// WHAT THIS FILE IS ALLOWED TO DECIDE. Very little, the same as quoteRoutes.js:
// it maps a request onto a service call and a service result onto a status
// code. When a proposal is late, what a breach means, whether a completion is
// a duplicate and who gets paged are all decided in services/proposals/,
// because those are decisions and this is plumbing. A rule implemented in a
// route is a rule that only applies to callers who arrive by HTTP.
//
// IT DOES NOT CHECK PERMISSIONS. Each route DECLARES the permission it needs
// and http/server.js enforces it once, before the handler runs, and audits
// every refusal. A second check here would be a second policy that can
// disagree with the first.
//
// THE CLOCK STARTS ON THE SERVER, NOT IN THE REQUEST. There is no field on any
// route below that sets `startedAt`, and the sweep takes no `at` - both are the
// server's clock, always. This is the one thing in this file worth arguing
// about, because accepting either would make the story far easier to test: a
// caller-supplied start instant is a caller who can decide their proposal took
// two minutes, and a caller-supplied `at` is a caller who can page every
// advisor in the company about proposals that are not late. An SLA the measured
// party can edit is not an SLA.
//
// TWO ROUTES FOR THE SLA, AND THEY ARE DIFFERENT KINDS OF THING.
//   GET  /api/proposals/sla/breaches -> READ. Which open drafts are late.
//   POST /api/proposals/sla/notify   -> ACT. Page the advisors behind them.
// A single endpoint that reported breaches and paged as a side effect would
// mean nobody could look at the list without setting phones off, so the
// dashboard query and the scheduled action are deliberately separate, under
// separate permissions. Note the paths are two segments deep: that is what
// keeps them from colliding with GET /api/proposals/:id, and it keeps the
// route table's "no two patterns overlap" property true.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Every service refusal maps to a status via
//     REFUSAL_STATUS below; an unmapped reason becomes 500, not a plausible
//     400, because an unrecognised refusal is our bug and should read like one.
//  2. Will it retry? Nothing here retries. Both POSTs are safe for the CALLER
//     to retry: each dedups on the correlationId the server generates per
//     request, so a resubmitted form cannot open a second proposal or issue one
//     twice. The sweep is idempotent for a different reason - the notifier's
//     dedup key is durable, so running it every minute pages nobody twice.
//  3. Recovery path? The caller gets a stable error code plus, for a validation
//     failure, the full problem list, so an advisor can fix the whole form in
//     one pass. A failed completion leaves the draft open and completable, and
//     the refusal message says so.
//  4. Handled: non-object bodies, a malformed or percent-broken path parameter,
//     unknown proposals, re-issuing an issued proposal, an assembly timeout,
//     trip details that do not price, and every service refusal. NOT handled:
//     pagination of the breach list (STORY-016 owns scale), proposal deletion
//     (there is no route - a proposal is evidence of work done and time taken),
//     and PDF rendering.

const { PERMISSIONS } = require("../../services/authz/permissions");
const {
  startProposal,
  completeProposal,
  getProposalForStaff,
  listBreachedOpenProposals,
  REASONS,
} = require("../../services/proposals/proposalStore");
const { sweepBreachedProposals } = require("../../services/proposals/proposalDelayNotifier");
const { slaPositionFor, SLA_MINUTES, deadlineFor } = require("../../services/proposals/proposalClock");

// Service refusal reason -> HTTP status. A table, so that adding a refusal to
// the service and forgetting it here produces a 500 (loud) rather than a 400
// (plausible, and wrong).
const REFUSAL_STATUS = Object.freeze({
  [REASONS.INVALID_REQUEST]: 400,
  [REASONS.INVALID_DETAILS]: 400,
  [REASONS.UNKNOWN_PROPOSAL]: 404,
  // 409, not 400: the request was well formed and the advisor did nothing
  // wrong - it is the state of the resource that conflicts with it. A 400 would
  // send them looking for a mistake in their form.
  [REASONS.ALREADY_ISSUED]: 409,
  // 504 rather than 503, and the distinction is worth keeping: we are a gateway
  // to the assembly step, and it did not answer in time. 503 would say WE are
  // unavailable, which is not true - everything else on this service works.
  [REASONS.GENERATION_TIMEOUT]: 504,
  [REASONS.GENERATION_UNAVAILABLE]: 503,
  // 503, not 500: both are temporary conditions where the right client
  // behaviour is to try again, and the request was not at fault.
  [REASONS.NOT_SAVED]: 503,
  [REASONS.AUDIT_UNAVAILABLE]: 503,
  // Our plumbing, not the caller's: server.js always supplies a correlationId,
  // so reaching this means something upstream broke.
  [REASONS.MISSING_CORRELATION_ID]: 500,
});

function refusalResponse(result) {
  return {
    status: REFUSAL_STATUS[result.reason] || 500,
    body: {
      error: result.reason,
      // The problem list is the service's, and it is written not to echo
      // untrusted input back - see quotePricing's describeValue.
      problems: result.problems || [],
    },
  };
}

// Envelope only. This checks the SHAPE ("is this a JSON object?") and nothing
// else: whether the trip details price correctly is a decision, that decision
// is audited by the service, and rejecting it here would return the same 400
// while quietly losing the audit entry - a refused proposal that leaves no
// trace.
function validateBodyEnvelope(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  return [];
}

// A path parameter arrives percent-encoded and decodeURIComponent THROWS on a
// malformed sequence ("%" alone). Unguarded that is a 500 on a URL a scanner
// finds within the hour, so it is a 400 here.
function decodeParam(raw) {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return null;
  }
}

// The advisor's view of a proposal: the record, plus where it stands against
// the clock right now.
//
// `sla` is the STORED verdict and is null while a proposal is still open;
// `slaPosition` is the live answer, which for an issued proposal is that same
// stored verdict and for an open draft is judged against this instant. Both are
// present because they answer different questions - "how long did this take?"
// and "how long have I got?" - and collapsing them into one field is how a
// finished proposal's recorded duration starts creeping upwards.
function proposalView(proposal, at) {
  return {
    ...proposal,
    slaMinutes: SLA_MINUTES,
    deadlineAt: deadlineFor(proposal.startedAt),
    slaPosition: slaPositionFor(proposal, at),
  };
}

const proposalRoutes = [
  {
    method: "POST",
    pattern: /^\/api\/proposals$/,
    permission: PERMISSIONS.PROPOSALS_WRITE,
    handler: async function (context) {
      const problems = validateBodyEnvelope(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = startProposal({
        customerId: context.body.customerId,
        tripReference: context.body.tripReference,
        title: context.body.title,
        // THE ADVISOR IS THE SESSION, not a field in the body. A proposal
        // records who opened it, and a body-supplied actor is an advisor's name
        // that any caller could type.
        actor: context.principal.userId,
        // Server-generated, one per request. This is what makes a resubmitted
        // form idempotent rather than a second proposal with a second clock.
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      const now = new Date().toISOString();
      return {
        // 200 rather than 201 on a replay: nothing was created the second time,
        // and saying "created" twice for one proposal would be a lie a client
        // can act on. Location is sent either way - the resource is there.
        status: result.replayed ? 200 : 201,
        body: {
          status: result.replayed ? "replayed" : "opened",
          proposal: proposalView(result.proposal, now),
        },
        headers: { Location: "/api/proposals/" + result.proposal.proposalId },
      };
    },
  },
  {
    method: "POST",
    // Bounded in the pattern itself, so an absurd id never reaches a service.
    pattern: /^\/api\/proposals\/([A-Za-z0-9_-]{1,128})\/complete$/,
    permission: PERMISSIONS.PROPOSALS_WRITE,
    handler: async function (context) {
      const proposalId = decodeParam(context.params[0]);
      if (proposalId === null) {
        return {
          status: 400,
          body: { error: "invalid_proposal_id", problems: ["Malformed proposal id."] },
        };
      }
      const problems = validateBodyEnvelope(context.body);
      if (problems.length > 0) {
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = await completeProposal({
        proposalId: proposalId,
        // The whole body is the trip. The service decides what prices and what
        // does not - one set of rules, checked in one place, rather than a copy
        // here that can fall out of step.
        details: context.body,
        actor: context.principal.userId,
        correlationId: context.correlationId,
      });

      if (!result.ok) {
        return refusalResponse(result);
      }

      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          status: result.replayed ? "replayed" : "issued",
          proposal: proposalView(result.proposal, now),
          // Surfaced so the advisor's client can say "this went out late and
          // your supervisor has been told" rather than leaving them to discover
          // it. null when the proposal was on time and nobody was paged.
          delayNotification: result.delayNotification,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/proposals\/([A-Za-z0-9_-]{1,128})$/,
    // The STAFF read. A proposal carries its costs and margins, which is why
    // there is no customer-facing counterpart to this route anywhere in this
    // file: the customer's priced document is a quote, and STORY-007 owns it.
    permission: PERMISSIONS.PROPOSALS_READ,
    handler: async function (context) {
      const proposalId = decodeParam(context.params[0]);
      const proposal = proposalId === null ? null : getProposalForStaff({ proposalId: proposalId });
      if (!proposal) {
        return { status: 404, body: { error: "unknown_proposal", message: "No such proposal." } };
      }
      return { status: 200, body: { proposal: proposalView(proposal, new Date().toISOString()) } };
    },
  },
  {
    method: "GET",
    // Two segments deep, so this cannot collide with GET /api/proposals/:id.
    pattern: /^\/api\/proposals\/sla\/breaches$/,
    permission: PERMISSIONS.PROPOSALS_READ,
    handler: async function () {
      // No `at` from the caller - see the header. The service uses the server
      // clock, and looking at this list pages nobody.
      const now = new Date().toISOString();
      const breached = listBreachedOpenProposals();
      return {
        status: 200,
        body: {
          count: breached.length,
          slaMinutes: SLA_MINUTES,
          proposals: breached.map(function (proposal) {
            return proposalView(proposal, now);
          }),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/proposals\/sla\/notify$/,
    // The narrowest grant in the table, because this one sends messages to
    // people. See permissions.js.
    permission: PERMISSIONS.PROPOSALS_SLA_SWEEP,
    handler: async function (context) {
      const now = new Date().toISOString();
      // Read the late drafts here and hand them over, rather than letting the
      // notifier read the store: proposalStore requires the notifier, so the
      // notifier must not require it back.
      const summary = await sweepBreachedProposals({
        proposals: listBreachedOpenProposals({ at: now }),
        at: now,
        correlationId: context.correlationId,
      });
      return {
        status: 200,
        body: {
          considered: summary.considered,
          notified: summary.notified,
          alreadyNotified: summary.alreadyNotified,
          failed: summary.failed,
          // Per-proposal outcomes, ids and statuses only - never the message
          // bodies, which would put the whole sweep's contents in one response.
          results: summary.results.map(function (result) {
            return { proposalId: result.proposalId || null, status: result.status };
          }),
        },
      };
    },
  },
];

module.exports = { proposalRoutes, REFUSAL_STATUS };
