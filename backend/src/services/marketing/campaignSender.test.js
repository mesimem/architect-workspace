// STORY-019: the campaign sender with its collaborators injected, so every
// skip reason, the re-send rule and the audit trail are proved without HTTP.
// http/marketing.test.js drives the same rules through the real server.
const assert = require("assert");
const { sendCampaign, SKIP } = require("./campaignSender");
const mailClient = require("./mailClient");

function memStore() {
  const rows = new Map();
  return { get: (k) => rows.get(k), has: (k) => rows.has(k), set: (k, v) => rows.set(k, v), values: () => rows.values(), delete: (k) => rows.delete(k), size: () => rows.size };
}

function harness({ members, contacts, failFor = [], configured = true }) {
  const sent = [];
  const audits = new Map();
  const deps = {
    campaigns: memStore(),
    sends: memStore(),
    getSegment: (id) => (id === "SEG-1" ? { ok: true, segment: { segmentId: "SEG-1" }, members: members.map((c) => ({ customerId: c })) } : { ok: false }),
    getPreferences: (id) => contacts[id] || null,
    isConfigured: () => configured,
    sendEmail: async ({ message }) => {
      if (failFor.includes(message.to)) return { status: "failed", errorClass: "TimeoutError" };
      sent.push(message);
      return { status: "sent", reference: "MAIL-" + sent.length };
    },
    // First write wins, like the real audit log.
    audit: (entry) => { if (!audits.has(entry.auditKey)) audits.set(entry.auditKey, entry); },
  };
  return { deps, sent, audits };
}

const message = { campaignId: "spring-safari-2026", segmentId: "SEG-1", subject: "Safari season", body: "New lodges in the Mara." };
const reasonOf = (report, id) => (report.skipped.find((s) => s.customerId === id) || {}).reason;

async function main() {
  // AC2: opted out, no address and a failed send are each skipped with a reason.
  const h = harness({
    members: ["C-YES", "C-OPTOUT", "C-NOADDR", "C-BOUNCE"],
    contacts: {
      "C-YES": { email: "yes@example.com", optedOut: false },
      "C-OPTOUT": { email: "no@example.com", optedOut: true },
      "C-BOUNCE": { email: "bounce@example.com", optedOut: false },
    },
    failFor: ["bounce@example.com"],
  });
  const first = await sendCampaign({ input: message, actor: "SALES-1", correlationId: "corr-campaign-0001" }, h.deps);
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.report.recipients, 4);
  assert.deepStrictEqual(first.report.sent.map((s) => s.customerId), ["C-YES"]);
  assert.strictEqual(reasonOf(first.report, "C-OPTOUT"), SKIP.OPTED_OUT);
  assert.strictEqual(reasonOf(first.report, "C-NOADDR"), SKIP.NO_EMAIL);
  assert.strictEqual(reasonOf(first.report, "C-BOUNCE"), SKIP.SEND_FAILED);
  assert.strictEqual(first.report.skipped.find((s) => s.customerId === "C-BOUNCE").errorClass, "TimeoutError", "a failure says why");
  assert.deepStrictEqual(h.sent.map((m) => m.to), ["yes@example.com"], "the opted-out customer never reached the mail client");
  console.log("campaignSender: opted-out, address-less and failed recipients are skipped with a reason");

  // AC3: every send and every skip is in the audit trail; no address is.
  const sentEntry = h.audits.get("spring-safari-2026:C-YES:sent");
  assert.ok(sentEntry, "the send is audited");
  assert.strictEqual(sentEntry.event, "marketing.campaign.sent");
  assert.strictEqual(sentEntry.actor, "SALES-1");
  assert.strictEqual(sentEntry.context.reference, "MAIL-1");
  assert.ok(h.audits.get("spring-safari-2026:C-OPTOUT:skipped.opted_out"));
  assert.ok(h.audits.get("spring-safari-2026:C-NOADDR:skipped.no_email_on_file"));
  assert.ok(h.audits.get("spring-safari-2026:campaign.created"));
  assert.ok(!JSON.stringify([...h.audits.values()]).includes("@"), "no email address in the audit trail");
  console.log("campaignSender: every send and skip is audited, without addresses");

  // AC3: re-sending never emails the same customer twice; a failed one is retried.
  h.deps.sendEmail = async ({ message: m }) => { h.sent.push(m); return { status: "sent", reference: "MAIL-" + h.sent.length }; };
  const again = await sendCampaign({ input: message, actor: "SALES-1", correlationId: "corr-campaign-0002" }, h.deps);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.replayed, true);
  assert.strictEqual(reasonOf(again.report, "C-YES"), SKIP.ALREADY_SENT);
  assert.deepStrictEqual(again.report.sent.map((s) => s.customerId), ["C-BOUNCE"], "the failed send is tried again");
  assert.deepStrictEqual(h.sent.map((m) => m.to), ["yes@example.com", "bounce@example.com"], "nobody emailed twice");
  const third = await sendCampaign({ input: message, actor: "SALES-1", correlationId: "corr-campaign-0003" }, h.deps);
  assert.strictEqual(third.report.sent.length, 0, "a third send emails no one");
  assert.strictEqual(h.sent.length, 2);
  assert.ok(h.audits.get("spring-safari-2026:C-YES:skipped.already_sent"), "the refused repeat is audited");
  console.log("campaignSender: re-sending emails only customers not yet reached");

  // A campaign id reused for different content is refused, and sends nothing.
  const reused = await sendCampaign({ input: Object.assign({}, message, { subject: "Different" }), actor: "SALES-1", correlationId: "corr-campaign-0004" }, h.deps);
  assert.strictEqual(reused.ok, false);
  assert.strictEqual(reused.reason, "conflict");
  assert.strictEqual(h.sent.length, 2);
  console.log("campaignSender: a reused campaign id with new content is refused");

  // Refusals before sending leave nothing sent.
  const off = harness({ members: ["C-YES"], contacts: { "C-YES": { email: "yes@example.com", optedOut: false } }, configured: false });
  const notConfigured = await sendCampaign({ input: message, actor: "SALES-1", correlationId: "corr-campaign-0005" }, off.deps);
  assert.strictEqual(notConfigured.reason, "mail_not_configured");
  assert.strictEqual(off.sent.length, 0);
  assert.strictEqual(off.deps.campaigns.size(), 0, "no campaign opened when mail is off");
  const unknown = await sendCampaign({ input: Object.assign({}, message, { segmentId: "SEG-NOPE" }), correlationId: "corr-campaign-0006" }, off.deps);
  assert.strictEqual(unknown.reason, "not_found");
  for (const bad of [null, {}, Object.assign({}, message, { campaignId: "short" }), Object.assign({}, message, { campaignId: "has spaces in it" }),
    Object.assign({}, message, { subject: "" }), Object.assign({}, message, { body: "x".repeat(20001) })]) {
    assert.strictEqual((await sendCampaign({ input: bad, correlationId: "corr-campaign-0007" }, off.deps)).reason, "invalid_request", JSON.stringify(bad));
  }
  console.log("campaignSender: bad input, unknown segments and unconfigured mail send nothing");

  // An empty segment is a successful campaign to no one, not an error.
  const empty = harness({ members: [], contacts: {} });
  const none = await sendCampaign({ input: message, correlationId: "corr-campaign-0008" }, empty.deps);
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.report.recipients, 0);
  console.log("campaignSender: an empty segment sends nothing and says so");

  // An audit failure after a send is surfaced, not hidden; the send still counts.
  const shaky = harness({ members: ["C-YES"], contacts: { "C-YES": { email: "yes@example.com", optedOut: false } } });
  shaky.deps.audit = () => { throw Object.assign(new Error("disk full"), { errorClass: "UpstreamUnavailable" }); };
  const unaudited = await sendCampaign({ input: message, correlationId: "corr-campaign-0009" }, shaky.deps);
  assert.strictEqual(unaudited.report.sent[0].audited, false, "the audit gap is reported");
  assert.ok(shaky.deps.sends.has("spring-safari-2026:C-YES"), "and the send is still recorded, so it is never repeated");
  console.log("campaignSender: an audit failure after a send is reported, and the send is not repeated");

  // The mail client: configuration, retry on timeout, replay by messageId.
  const msg = { messageId: "mail-test:C-1", to: "c1@example.com", subject: "Hi", body: "Hello" };
  assert.strictEqual((await mailClient.sendEmail({ message: msg, token: null })).status, "not_configured");
  assert.strictEqual(mailClient.isConfigured(null), false);
  let calls = 0;
  const flaky = await mailClient.sendEmail({ message: msg, token: "t", timeoutMs: 20, maxAttempts: 2,
    send: () => { calls += 1; return calls === 1 ? new Promise(() => {}) : { reference: "R-1" }; } });
  assert.strictEqual(flaky.status, "sent", "a timeout is retried once");
  assert.strictEqual(calls, 2);
  const rejected = await mailClient.sendEmail({ message: msg, token: "t", send: () => { throw new Error("bad address"); } });
  assert.strictEqual(rejected.status, "failed");
  assert.strictEqual(rejected.errorClass, "UpstreamUnavailable", "a bare Error is classified, not logged as Error");
  const a = await mailClient.sendEmail({ message: msg, token: "t" });
  const b = await mailClient.sendEmail({ message: msg, token: "t" });
  assert.strictEqual(a.reference, b.reference);
  assert.strictEqual(b.replayed, true, "a repeated messageId is a replay at the transport");
  assert.strictEqual(mailClient.getOutbox().filter((m) => m.messageId === msg.messageId).length, 1);
  assert.strictEqual((await mailClient.sendEmail({ message: { messageId: "x" }, token: "t" })).errorClass, "ValidationError");
  console.log("mailClient: configuration, timeout retry, classification and replay");

  console.log("campaignSender: all tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
