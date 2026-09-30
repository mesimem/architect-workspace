// STORY-013: the external boundary of proposal creation, and its one job -
// make sure a slow or broken dependency cannot hang a completion or half-issue
// a proposal.
//
// Separated from proposalStore.js for the same reason quoteWriteGuard.js is
// separated from quoteStore.js, and along the same kind of seam. That file owns
// the LIFECYCLE of a proposal - what issuing means, what counts as a duplicate,
// when the SLA is breached. This file owns the RETRY AND TIMEOUT POLICY at the
// one point where completion talks to something outside itself. The two change
// for different reasons: new trip fields land next door, a change to the retry
// policy lands here and deserves to be reviewed on its own.
//
// NOTHING IN PRODUCTION PASSES `assemble` YET, AND THIS IS NOT PRETEND
// MACHINERY. Pricing is local and synchronous, so there is currently nothing in
// completion that CAN hang. What exists here is the boundary where the first
// slow caller plugs in - STORY-015's itinerary detail is the obvious one, and
// it reads through a catalog source that already has exactly this policy. The
// story names "proposal generation timeout" as a failure path I have to handle,
// and a failure path cannot be handled without a boundary to handle it at.
// Defining it now means that caller inherits the timeout, the capped retries
// and the draft-survives-a-failed-completion guarantee instead of inventing its
// own. It is exercised by a hanging stub, a throwing stub and a junk-returning
// stub in proposalAssembly.test.js.
//
// THE POLICY ITSELF IS NOT DEFINED HERE. It is shared/callWithRetry.js, the
// same one the catalog read and the advisor notification use. "Which failures
// are worth retrying" must not differ depending on which service you happen to
// be calling - so a timeout is retried, capped, and a throw is not.
//
// WHY A SUCCESSFUL CALL IS STILL CHECKED. An upstream that returns 200 with the
// wrong shape is the failure mode a timeout test never catches: the details
// would flow into the pricer, price as nothing, and surface to the advisor as
// "incorrect trip details" - blaming them for a broken dependency. So a bad
// shape is classified as unavailable, which is what it is.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Returns { ok: false, reason, problems }.
//     Never throws, and never returns partial details.
//  2. Will it retry? Only a timeout, at most maxAttempts times - the shared
//     policy. Something that throws is not retried.
//  3. Recovery path? The caller has not written anything yet, by construction:
//     this runs BEFORE pricing and before any store write, so a failure here
//     leaves the draft exactly as it was, clock still running, still
//     completable. The advisor retries and nothing needs cleaning up.
//  4. Handled here: no assemble supplied at all, one that hangs, one that
//     throws, and one that resolves with something that is not a detail set.
//     NOT handled: cancelling the in-flight call after we stop waiting (no JS
//     timeout can - see callWithRetry.js, which is why every side-effecting
//     caller in this repo is keyed), and partial enrichment, where an assemble
//     step returns some lines and silently drops others. We cannot detect that
//     without knowing what it was supposed to return.

const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  callWithRetry,
  classifyFailure,
  logFailure,
} = require("../shared/callWithRetry");

const SERVICE_NAME = "proposals";

const REASONS = Object.freeze({
  GENERATION_TIMEOUT: "generation_timeout",
  GENERATION_UNAVAILABLE: "generation_unavailable",
});

// One message for both, on purpose. The advisor's next action is the same
// either way, and which internal component let us down is neither their
// business nor actionable by them. What they DO need is the reassurance that
// their work is still there - which is the only part of this they cannot see.
const FAILURE_MESSAGE =
  "The proposal could not be assembled in time. The draft is untouched - please try again.";

function refuse(reason) {
  return { ok: false, reason: reason, problems: [FAILURE_MESSAGE] };
}

function isDetailSet(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Returns { ok: true, details } or a refusal.
//
// With no `assemble` this is the identity function, which is the current
// production path: the details the advisor submitted are the details we price.
async function assembleDetails(
  details,
  { assemble = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}
) {
  if (typeof assemble !== "function") {
    return { ok: true, details: details };
  }

  const result = await callWithRetry(assemble, details, timeoutMs, maxAttempts);

  if (!result.ok) {
    const failure = classifyFailure(result);
    // The error CLASS and the attempt count, never the upstream error body: it
    // can carry a URL with a token in it, and these lines persist.
    logFailure(SERVICE_NAME, "proposal_assembly_failed", failure.errorClass, result.attempts, {
      timeoutMs: timeoutMs,
    });
    // Told apart because they call for different client behaviour: try again,
    // versus stop and look at what is broken.
    return refuse(
      failure.status === "timeout" ? REASONS.GENERATION_TIMEOUT : REASONS.GENERATION_UNAVAILABLE
    );
  }

  if (!isDetailSet(result.value)) {
    logFailure(SERVICE_NAME, "proposal_assembly_malformed", "ContractViolation", result.attempts, {});
    return refuse(REASONS.GENERATION_UNAVAILABLE);
  }

  return { ok: true, details: result.value };
}

module.exports = { assembleDetails, REASONS, FAILURE_MESSAGE };
