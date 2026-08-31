const assert = require("assert");
const { triageRequest } = require("./requestTriageService");
const { notifyAdvisor, getOutbox } = require("./advisorNotifier");
const { findReview, getQueuedReviews } = require("./advisorReviewQueue");

// Every request here is unclear on purpose - a clear request never reaches
// the notifier, which is itself asserted at the end.
function unclearRequest(requestId, overrides) {
  return Object.assign(
    {
      requestId: requestId,
      customerId: "CUST-1",
      destination: "Tanzania",
      travelDates: { depart: "", return: "" },
      partySize: 2,
      notes: "Not sure when we can travel.",
    },
    overrides
  );
}

async function main() {
  // Happy path: flagging a request pages an advisor, and the message carries
  // what they need to pick the work up.
  const flagged = await triageRequest(unclearRequest("REQ-NOTIFY-0001"));

  assert.strictEqual(flagged.status, "flagged");
  assert.strictEqual(flagged.notification.status, "notified");
  assert.strictEqual(flagged.notification.notified, true);

  const sent = getOutbox().filter(function (m) {
    return m.requestId === "REQ-NOTIFY-0001";
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].customerId, "CUST-1");
  assert.ok(sent[0].reasons.includes("missing_required_details"));
  assert.ok(sent[0].subject.includes("REQ-NOTIFY-0001"));
  // The customer's own words are deliberately not in the message.
  assert.strictEqual(sent[0].notes, undefined);

  assert.strictEqual(findReview("REQ-NOTIFY-0001").notificationStatus, "notified");

  console.log("advisorNotifier: flagging a request notifies an advisor");

  // Idempotency: replaying the request pages nobody a second time.
  const replay = await triageRequest(unclearRequest("REQ-NOTIFY-0001"));
  assert.strictEqual(replay.notification.status, "already_notified");
  assert.strictEqual(replay.notification.replayed, true);
  assert.strictEqual(
    getOutbox().filter(function (m) {
      return m.requestId === "REQ-NOTIFY-0001";
    }).length,
    1
  );

  console.log("advisorNotifier: a replayed request does not page an advisor twice");

  // FAILURE PATH: advisor notification failure by TIMEOUT. The flag must
  // survive. This is the whole point of the ordering in triageRequest.
  let hangingCalls = 0;
  const timedOut = await triageRequest(unclearRequest("REQ-NOTIFY-TIMEOUT"), {
    notify: function () {
      hangingCalls += 1;
      return new Promise(function () {}); // never settles
    },
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(timedOut.status, "flagged"); // STILL FLAGGED
  assert.strictEqual(timedOut.notification.status, "notification_failed");
  assert.strictEqual(timedOut.notification.errorClass, "TimeoutError");
  assert.strictEqual(hangingCalls, 2); // retried once, then capped

  const stillQueued = findReview("REQ-NOTIFY-TIMEOUT");
  assert.ok(stillQueued, "a request whose notification failed must stay in the queue");
  assert.strictEqual(stillQueued.status, "pending_review");
  assert.strictEqual(stillQueued.notificationStatus, "failed");
  assert.strictEqual(stillQueued.notificationDetail, "TimeoutError");

  console.log("advisorNotifier: notification timeout does not lose the flag");

  // FAILURE PATH: notifier throws. Not retried, still does not lose the flag.
  let brokenCalls = 0;
  const broke = await triageRequest(unclearRequest("REQ-NOTIFY-BROKEN0"), {
    notify: function () {
      brokenCalls += 1;
      return Promise.reject(new Error("smtp connection refused"));
    },
    timeoutMs: 20,
    maxAttempts: 2,
  });

  assert.strictEqual(broke.status, "flagged");
  assert.strictEqual(broke.notification.status, "notification_failed");
  assert.strictEqual(broke.notification.errorClass, "UpstreamUnavailable");
  assert.strictEqual(brokenCalls, 1); // NOT retried
  assert.strictEqual(findReview("REQ-NOTIFY-BROKEN0").notificationStatus, "failed");

  console.log("advisorNotifier: a throwing notifier is not retried and the flag survives");

  // A failed page is not recorded as delivered, so a later attempt can still
  // reach the advisor. A failure that wedged the request forever would be
  // worse than the failure itself.
  const retried = await notifyAdvisor({ review: findReview("REQ-NOTIFY-BROKEN0") });
  assert.strictEqual(retried.status, "notified");
  assert.strictEqual(findReview("REQ-NOTIFY-BROKEN0").notificationStatus, "notified");

  console.log("advisorNotifier: a failed notification can be retried later and succeed");

  // A clear request pages nobody: no review row, nothing in the outbox.
  const outboxBefore = getOutbox().length;
  const queueBefore = getQueuedReviews().length;
  const clear = await triageRequest({
    requestId: "REQ-NOTIFY-CLEAR01",
    customerId: "CUST-2",
    destination: "Tanzania",
    travelDates: { depart: "2026-10-12", return: "2026-10-23" },
    partySize: 2,
    notes: "Serengeti migration safari with a private guide, please.",
  });

  assert.strictEqual(clear.status, "clear");
  assert.strictEqual(clear.notification, undefined);
  assert.strictEqual(getOutbox().length, outboxBefore);
  assert.strictEqual(getQueuedReviews().length, queueBefore);

  console.log("advisorNotifier: a clear request pages nobody");

  // Guard: a review the notifier cannot identify is refused, not sent blind.
  const refused = await notifyAdvisor({ review: { requestId: "short" } });
  assert.strictEqual(refused.status, "invalid_request");
  assert.strictEqual(refused.notified, false);

  console.log("advisorNotifier: an unusable review is refused, not sent blind");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
