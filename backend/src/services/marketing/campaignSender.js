// STORY-019: send one campaign to one segment, and report what happened to
// every customer in it.
//
// THE ORDER, PER RECIPIENT, AND WHY:
//   1. already emailed for this campaign?  -> skipped, already_sent
//   2. opted out?                          -> skipped, opted_out
//   3. no address on file?                 -> skipped, no_email_on_file
//   4. send; if it fails                   -> skipped, send_failed (+ errorClass)
//   5. record the send, then audit it      -> sent
// Opt-out is checked before the address is even read, so a customer who said
// no is never handed to the mail client at all.
//
// NEVER TWICE. A send is recorded in SENDS under "<campaignId>:<customerId>"
// the moment the mail client accepts it, and that key is checked first. So
// re-sending a campaign - a retry after a timeout, a double click, a second
// request - emails only the customers it has not reached yet. The same key is
// the mail client's messageId, a second guard if the record write itself is
// lost after the provider accepted the message.
//
// A FAILED SEND IS NOT RECORDED AS SENT, deliberately - same rule as a declined
// payment in booking/bookTripService.js. Re-sending the campaign tries that
// customer again; recording the failure would wedge them out forever.
//
// EVERY OUTCOME IS AUDITED, keyed so a repeat of the same outcome is one entry
// (the audit log is first-write-wins) but different outcomes for the same
// customer are each kept. Email addresses never go into the trail.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Refusals before sending (bad input, unknown
//     segment, mail not configured, campaign id reused for different content)
//     return { ok:false } having sent nothing. Once sending starts, a failure
//     for one customer is reported for that customer and the rest continue.
//  2. Will it retry? The mail client retries a timeout (capped). The campaign
//     itself is retried by sending it again, which is safe - see NEVER TWICE.
//  3. Recovery path? Re-send. If an audit write fails after a send, the result
//     says audited:false for that customer and the error is logged; the email
//     cannot be unsent, so that gap is surfaced rather than hidden.
//  4. NOT handled: scheduling, unsubscribe links, two processes sending the
//     same campaign at the same instant (single-process store; the real fix is
//     a unique constraint in the database).

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");
const { getSegment } = require("./segmentStore");
const { getPreferences } = require("./contactPreferences");
const mailClient = require("./mailClient");

const CAMPAIGNS = createJsonFileStore("marketing-campaigns");
const SENDS = createJsonFileStore("marketing-campaign-sends");

const MIN_ID = 8;
const MAX_ID = 64;
const MAX_SUBJECT = 200;
const MAX_BODY = 20000;

const REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  MAIL_NOT_CONFIGURED: "mail_not_configured",
});

const SKIP = Object.freeze({
  ALREADY_SENT: "already_sent",
  OPTED_OUT: "opted_out",
  NO_EMAIL: "no_email_on_file",
  SEND_FAILED: "send_failed",
});

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ field: "body", problem: "must be an object" }];
  const problems = [];
  if (typeof input.campaignId !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.campaignId) ||
      input.campaignId.length < MIN_ID || input.campaignId.length > MAX_ID) {
    problems.push({ field: "campaignId", problem: MIN_ID + "-" + MAX_ID + " letters, digits, - or _; it is what makes a re-send safe" });
  }
  if (typeof input.segmentId !== "string" || input.segmentId.trim() === "") problems.push({ field: "segmentId", problem: "is required" });
  if (typeof input.subject !== "string" || input.subject.trim() === "" || input.subject.length > MAX_SUBJECT) {
    problems.push({ field: "subject", problem: "must be 1-" + MAX_SUBJECT + " characters" });
  }
  if (typeof input.body !== "string" || input.body.trim() === "" || input.body.length > MAX_BODY) {
    problems.push({ field: "body", problem: "must be 1-" + MAX_BODY + " characters" });
  }
  return problems;
}

function safeAudit(audit, entry) {
  try {
    audit(entry);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), level: "error", service: "marketing", event: "campaign_audit_failed",
      outcome: "failure", error_class: (error && error.errorClass) || (error && error.name) || "UnknownError",
      correlation_id: entry.correlationId, context: { auditKey: entry.auditKey },
    }));
    return false;
  }
}

// Same campaignId must mean the same campaign. A reused id with a different
// segment or message is refused, not merged into the earlier one's sends.
function openCampaign(input, actor, correlationId, deps) {
  const store = deps.campaigns || CAMPAIGNS;
  const fields = { segmentId: input.segmentId, subject: input.subject, body: input.body };
  const existing = store.get(input.campaignId);
  if (existing) {
    const same = existing.segmentId === fields.segmentId && existing.subject === fields.subject && existing.body === fields.body;
    return same ? { ok: true, campaign: existing, replayed: true }
      : { ok: false, reason: REASONS.CONFLICT, problems: ["This campaignId was already used for a different campaign. Use a new id."] };
  }
  const campaign = Object.freeze(Object.assign({ campaignId: input.campaignId }, fields, {
    createdAt: new Date().toISOString(), createdBy: actor || null,
  }));
  store.set(input.campaignId, campaign);
  safeAudit(deps.audit || recordAudit, {
    auditKey: deriveAuditKey(input.campaignId, "campaign.created"), event: "marketing.campaign.created", outcome: "success",
    actor: actor, resource: input.campaignId, correlationId: correlationId, context: { segmentId: input.segmentId },
  });
  return { ok: true, campaign: campaign, replayed: false };
}

async function deliver(campaign, member, actor, correlationId, deps) {
  const sends = deps.sends || SENDS;
  const audit = deps.audit || recordAudit;
  const key = campaign.campaignId + ":" + member.customerId;
  const base = { actor: actor, resource: campaign.campaignId, correlationId: correlationId };
  const skip = function (reason, extra, auditBase) {
    const audited = safeAudit(audit, Object.assign({}, base, {
      auditKey: deriveAuditKey(auditBase || key, "skipped." + reason), event: "marketing.campaign.skipped", outcome: "failure",
      context: Object.assign({ campaignId: campaign.campaignId, customerId: member.customerId, reason: reason }, extra || {}),
    }));
    return Object.assign({ customerId: member.customerId, outcome: "skipped", reason: reason, audited: audited }, extra || {});
  };

  if (sends.has(key)) return skip(SKIP.ALREADY_SENT, { reference: sends.get(key).reference });
  const contact = (deps.getPreferences || getPreferences)(member.customerId);
  if (contact && contact.optedOut) return skip(SKIP.OPTED_OUT);
  if (!contact || !contact.email) return skip(SKIP.NO_EMAIL);

  const result = await (deps.sendEmail || mailClient.sendEmail)({
    message: { messageId: key, to: contact.email, subject: campaign.subject, body: campaign.body },
  });
  if (result.status !== "sent") {
    // Keyed per request, so each failed attempt is its own fact in the trail.
    return skip(SKIP.SEND_FAILED, { errorClass: result.errorClass || "UpstreamUnavailable" }, key + ":" + correlationId);
  }
  sends.set(key, { campaignId: campaign.campaignId, customerId: member.customerId, reference: result.reference, sentAt: new Date().toISOString() });
  const audited = safeAudit(audit, Object.assign({}, base, {
    auditKey: deriveAuditKey(key, "sent"), event: "marketing.campaign.sent", outcome: "success",
    context: { campaignId: campaign.campaignId, customerId: member.customerId, reference: result.reference },
  }));
  return { customerId: member.customerId, outcome: "sent", reference: result.reference, audited: audited };
}

async function sendCampaign({ input, actor, correlationId }, deps = {}) {
  const problems = validate(input);
  if (problems.length > 0) return { ok: false, reason: REASONS.INVALID_REQUEST, problems: problems };
  const found = (deps.getSegment || getSegment)(input.segmentId);
  if (!found.ok) return { ok: false, reason: REASONS.NOT_FOUND, problems: ["No segment with that id."] };
  if (!(deps.isConfigured || mailClient.isConfigured)()) {
    return { ok: false, reason: REASONS.MAIL_NOT_CONFIGURED, problems: ["Email is not configured (COLABERRY_MAIL_API_TOKEN), so nothing was sent."] };
  }
  const opened = openCampaign(input, actor, correlationId, deps);
  if (!opened.ok) return opened;

  const results = [];
  for (const member of found.members) {
    results.push(await deliver(opened.campaign, member, actor, correlationId, deps));
  }
  return {
    ok: true,
    replayed: opened.replayed,
    report: {
      campaignId: opened.campaign.campaignId,
      segmentId: opened.campaign.segmentId,
      recipients: results.length,
      sent: results.filter(function (r) { return r.outcome === "sent"; }),
      skipped: results.filter(function (r) { return r.outcome === "skipped"; }),
    },
  };
}

module.exports = { sendCampaign, REASONS, SKIP };
