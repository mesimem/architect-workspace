// STORY-019: the one door campaign email goes out through.
//
// NO REAL EMAIL IS SENT. No email provider or credential exists for this repo,
// so the default sender is an in-memory outbox behind an injected `send`
// function - the same pattern as accounting/accountingClient.js. Pointing this
// at a real provider means passing a different `send`; nothing that calls
// sendEmail changes.
//
// CONFIGURED BY ENVIRONMENT. COLABERRY_MAIL_API_TOKEN must be set, as a real
// provider would require. Unset, nothing is sent and the caller learns that
// BEFORE it starts a campaign (isConfigured), rather than half-way through.
// The token is never logged.
//
// IDEMPOTENT AT THE TRANSPORT. Every message carries a messageId (the campaign
// sender uses "<campaignId>:<customerId>"), and the outbox treats a repeated
// messageId as a replay. A real provider is passed the same id as its
// idempotency key. This is the second guard against a double send; the first
// is the campaign sender's own record of who has already been emailed.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? { status: "failed", errorClass } - never a
//     throw. The campaign sender reports that recipient as skipped, send_failed.
//  2. Will it retry? Only a timeout, at most DEFAULT_MAX_ATTEMPTS, via
//     shared/callWithRetry.js. A rejected message does not fix itself.
//  3. Recovery path? Re-send the campaign: failed recipients were not recorded
//     as sent, so they are tried again, and sent ones are not.
//  4. Handled: missing token, malformed message, timeout, sender throwing.
//     NOT handled: bounces and delivery receipts (nothing reports them back).

const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  callWithRetry,
  classifyFailure,
  logFailure,
} = require("../shared/callWithRetry");

const SERVICE_NAME = "marketing-mail";
const OUTBOX = [];
const MAX_SUBJECT = 200;
const MAX_BODY = 20000;

function readConfiguredToken() {
  const token = process.env.COLABERRY_MAIL_API_TOKEN;
  return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

function isConfigured(token = readConfiguredToken()) {
  return typeof token === "string" && token.trim() !== "";
}

function validateMessage(message) {
  if (!message || typeof message !== "object") return ["message must be an object"];
  const problems = [];
  if (typeof message.messageId !== "string" || message.messageId.trim() === "") problems.push("messageId is required");
  if (typeof message.to !== "string" || !message.to.includes("@")) problems.push("to must be an email address");
  if (typeof message.subject !== "string" || message.subject.trim() === "" || message.subject.length > MAX_SUBJECT) problems.push("subject is required");
  if (typeof message.body !== "string" || message.body.trim() === "" || message.body.length > MAX_BODY) problems.push("body is required");
  return problems;
}

// The stand-in provider. Replays a repeated messageId instead of queueing a
// second copy, which is what a provider honouring an idempotency key does.
async function defaultSender({ message, token }) {
  if (!isConfigured(token)) {
    const error = new Error("No credential was presented to the mail provider.");
    error.name = "AuthError";
    throw error;
  }
  const existing = OUTBOX.find(function (row) { return row.messageId === message.messageId; });
  if (existing) return { reference: existing.reference, replayed: true };
  const reference = "MAIL-" + String(OUTBOX.length + 1).padStart(6, "0");
  OUTBOX.push({ reference: reference, messageId: message.messageId, to: message.to, subject: message.subject, body: message.body });
  return { reference: reference, replayed: false };
}

async function sendEmail({
  message,
  send = defaultSender,
  token = readConfiguredToken(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const problems = validateMessage(message);
  if (problems.length > 0) {
    logFailure(SERVICE_NAME, "mail_refused", "ValidationError", 0, { messageId: message && message.messageId });
    return { status: "failed", errorClass: "ValidationError", problems: problems };
  }
  if (!isConfigured(token)) {
    logFailure(SERVICE_NAME, "mail_not_configured", "ConfigError", 0, { messageId: message.messageId });
    return { status: "not_configured", errorClass: "ConfigError" };
  }
  const started = Date.now();
  const result = await callWithRetry(function () {
    return send({ message: message, token: token });
  }, undefined, timeoutMs, maxAttempts);
  if (!result.ok) {
    const failure = classifyFailure(result);
    logFailure(SERVICE_NAME, "mail_send_failed", failure.errorClass, result.attempts, {
      messageId: message.messageId,
      duration_ms: Date.now() - started,
    });
    return { status: "failed", errorClass: failure.errorClass, attempts: result.attempts };
  }
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: "info", service: SERVICE_NAME, event: "mail_sent",
    outcome: "success", duration_ms: Date.now() - started,
    context: { messageId: message.messageId, reference: result.value.reference, attempts: result.attempts },
  }));
  return { status: "sent", reference: result.value.reference, replayed: Boolean(result.value.replayed) };
}

function getOutbox() {
  return OUTBOX.map(function (row) { return Object.assign({}, row); });
}

module.exports = { sendEmail, isConfigured, getOutbox };
