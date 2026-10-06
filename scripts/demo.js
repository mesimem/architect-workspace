#!/usr/bin/env node
// A live, narrated walkthrough of the travel platform for Demo Day.
//
//   node scripts/demo.js          pauses for Enter between steps (present live)
//   node scripts/demo.js --auto   runs straight through (rehearsal, recording)
//
// It starts the REAL backend inside this process on a random local port,
// drives it over HTTP the way a client would, and shuts it down at the end -
// the same way the test suite runs it. Nothing is written to disk: every run
// starts from an empty, in-memory system, so the demo is identical every time.
//
// Booking has no HTTP route in this build (bookTrip is called by the app, see
// backend/src/services/booking/bookTripService.js), so step 1 calls it
// directly and says so on screen. Every other step goes through the API.
//
// No real email, payment or accounting system is contacted: those are the
// in-app stand-ins the build uses. The "tokens" below are demo values, not
// secrets.

process.env.COLABERRY_ACCOUNTING_API_TOKEN = "demo-accounting-token";
process.env.COLABERRY_MAIL_API_TOKEN = "demo-mail-token";
delete process.env.COLABERRY_DATA_DIR;

const readline = require("readline");
const { createServer } = require("../backend/src/http/server");
const { loadPrincipals } = require("../backend/src/http/auth");
const { hashPassword } = require("../backend/src/services/portal/portalCredentials");
const { bookTrip } = require("../backend/src/services/booking/bookTripService");

const AUTO = process.argv.includes("--auto");
const CUSTOMER = { id: "CUST-AMARA", password: "serengeti-at-dawn-2026" };
const STAFF = {
  advisor: "demo-advisor-token:advisor:ADV-JOSEPH",
  admin: "demo-admin-token:admin:ADMIN-GRACE",
  sales: "demo-sales-token:sales:SALES-NIA",
};
const tokenOf = (role) => STAFF[role].split(":")[0];

// ---- Presentation helpers ------------------------------------------------
const C = { bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m", reset: "\x1b[0m" };
const say = (text) => console.log(text);
const money = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
const mask = (token) => String(token).slice(0, 6) + "...";

function step(number, title, why) {
  say("\n" + C.bold + C.cyan + "STEP " + number + "  " + title + C.reset);
  if (why) say(C.dim + why + C.reset);
}
function request(method, path, who) {
  say(C.yellow + "  -> " + method + " " + path + C.reset + C.dim + (who ? "   (as " + who + ")" : "") + C.reset);
}
function result(status, text) {
  const colour = status < 300 ? C.green : C.red;
  say("  " + colour + "<- " + status + C.reset + "  " + text);
}
function point(text) {
  say("     " + text);
}

// One reader for the whole run. A reader per pause loses keypresses: the
// first one swallows everything already typed and the rest wait forever.
// Enter presses queue up, and if input closes the demo carries on unattended.
let reader = null;
const pressed = [];
const waiting = [];
let inputClosed = false;
function startReader() {
  reader = readline.createInterface({ input: process.stdin });
  reader.on("line", () => (waiting.length ? waiting.shift()() : pressed.push(true)));
  reader.on("close", () => { inputClosed = true; while (waiting.length) waiting.shift()(); });
}
async function pause() {
  if (AUTO) return;
  if (!reader) startReader();
  process.stdout.write(C.dim + "\n  [Enter] to continue" + C.reset);
  if (pressed.length) { pressed.shift(); return say(""); }
  if (inputClosed) return say("");
  await new Promise((resolve) => waiting.push(resolve));
  say("");
}

// ---- The walkthrough -----------------------------------------------------
async function main() {
  const credentials = new Map([[CUSTOMER.id, await hashPassword(CUSTOMER.password)]]);
  const server = createServer({ principals: loadPrincipals(Object.values(STAFF).join(",")), credentials });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  async function api(method, path, token, body) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  try {
    say(C.bold + "\nAfrican travel platform - live walkthrough" + C.reset);
    say(C.dim + "Real backend, running in this window at " + base + ". Fresh, empty system on every run." + C.reset);
    await pause();

    // 1. Book a complete trip
    step(1, "A customer books a flight, hotel and safari as ONE trip",
      "Booking is called the way the app calls it (no HTTP route for it in this build).");
    const booking = await bookTrip({ customerId: CUSTOMER.id, flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300", idempotencyKey: "demo-booking-amara-0001" });
    result(200, "Trip " + C.bold + booking.tripId + C.reset + " " + booking.status + " for " + CUSTOMER.id);
    point("Flight " + booking.legs.flightId + " + hotel " + booking.legs.hotelId + " + safari " + booking.legs.safariId);
    point("Charged " + money(booking.amountCents) + " " + booking.currency + "; accounting: " + booking.accounting.status);
    await pause();

    // 2. Retry safety
    step(2, "The same booking is sent again (a retry, a double click)",
      "Same idempotency key -> the original trip comes back. No second trip, no second charge.");
    const retry = await bookTrip({ customerId: CUSTOMER.id, flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300", idempotencyKey: "demo-booking-amara-0001" });
    result(200, "Trip " + retry.tripId + " - replayed: " + C.bold + retry.replayed + C.reset);
    await pause();

    // 3. Portal sign-in and itinerary
    step(3, "The customer signs in to the secure portal and sees their trip");
    request("POST", "/api/portal/login", CUSTOMER.id);
    const login = await api("POST", "/api/portal/login", null, { customerId: CUSTOMER.id, password: CUSTOMER.password });
    result(login.status, "Signed in - session token " + mask(login.body.token) + " (the password is never stored, only a hash)");
    const session = login.body.token;
    request("GET", "/api/portal/trips", CUSTOMER.id);
    const trips = await api("GET", "/api/portal/trips", session);
    const tripList = trips.body.itineraries || [];
    result(trips.status, tripList.length + " trip(s) on the itinerary - only this customer's, taken from the session");
    tripList.forEach((t) => point(t.tripId + "  " + t.status + "  " + t.legs.flightId + " / " + t.legs.hotelId + " / " + t.legs.safariId + "  " + money(t.amountCents)));
    const wrongPassword = await api("POST", "/api/portal/login", null, { customerId: CUSTOMER.id, password: "guess" });
    request("POST", "/api/portal/login", "someone with the wrong password");
    result(wrongPassword.status, "Refused - and the failed attempt is recorded");
    await pause();

    // 4. Role-based permissions
    step(4, "Role-based permissions: everyone sees only their own job",
      "Guardrail REQ-008. Admin is not a superuser either.");
    for (const [label, token, path] of [
      ["customer", session, "/api/admin/audit"],
      ["travel advisor", tokenOf("advisor"), "/api/admin/audit"],
      ["admin", tokenOf("admin"), "/api/portal/trips"],
      ["sales", tokenOf("sales"), "/api/advisor/reviews"],
    ]) {
      request("GET", path, label);
      const res = await api("GET", path, token);
      result(res.status, res.status === 403 ? "Forbidden - not this role's job" : "allowed");
    }
    await pause();

    // 5. Uncertain requests go to a human
    step(5, "An unclear request is flagged for a travel advisor",
      "Guardrail REQ-005: the system does not guess when a request is uncertain.");
    const request1 = { requestId: "DEMO-REQ-CLEAR-01", customerId: CUSTOMER.id, destination: "Tanzania",
      travelDates: { depart: "2026-11-12", return: "2026-11-23" }, partySize: 2, notes: "Serengeti migration with a private guide." };
    request("POST", "/api/requests/triage", CUSTOMER.id + ' - "Tanzania, 12-23 Nov, 2 people"');
    const clear = await api("POST", "/api/requests/triage", session, request1);
    result(clear.status, "status: " + C.bold + clear.body.status + C.reset);
    const request2 = Object.assign({}, request1, { requestId: "DEMO-REQ-VAGUE-01", travelDates: { depart: "", return: "" }, notes: "Not sure when, somewhere warm." });
    request("POST", "/api/requests/triage", CUSTOMER.id + ' - "Not sure when, somewhere warm"');
    const vague = await api("POST", "/api/requests/triage", session, request2);
    result(vague.status, "status: " + C.bold + vague.body.status + C.reset + (vague.body.reasons ? "  reasons: " + vague.body.reasons.join(", ") : ""));
    request("GET", "/api/advisor/reviews", "travel advisor");
    const queue = await api("GET", "/api/advisor/reviews", tokenOf("advisor"));
    const reviews = queue.body.reviews || [];
    result(queue.status, reviews.length + " request(s) waiting for an advisor: " + reviews.map((r) => r.requestId).join(", "));
    await pause();

    // 6. Marketing campaign
    step(6, "Sales sends a campaign to a customer segment - nobody is emailed twice");
    request("POST", "/api/marketing/segments", "sales");
    const segment = await api("POST", "/api/marketing/segments", tokenOf("sales"), { name: "Safari customers", criteria: { minBookings: 1 } });
    result(segment.status, 'Segment "' + segment.body.segment.name + '" matches ' + segment.body.members.length + " customer(s)");
    await api("PUT", "/api/marketing/contacts/" + CUSTOMER.id, tokenOf("sales"), { email: "amara@example.com" });
    const campaign = { campaignId: "demo-dry-season", segmentId: segment.body.segment.segmentId, subject: "New lodges for the dry season", body: "Your next safari is waiting." };
    for (const attempt of ["first send", "sent again"]) {
      request("POST", "/api/marketing/campaigns", "sales - " + attempt);
      const sent = await api("POST", "/api/marketing/campaigns", tokenOf("sales"), campaign);
      const skipped = sent.body.report.skipped.map((s) => s.customerId + " (" + s.reason + ")").join(", ");
      result(sent.status, "sent: " + sent.body.report.sent.length + "   skipped: " + (skipped || "none"));
    }
    point(C.dim + "(Email goes to an in-app outbox in this build - no real email is sent.)" + C.reset);
    await pause();

    // 7. The audit trail
    step(7, "Bookings, sign-ins, refusals and campaign sends are all in the audit trail",
      "Guardrail REQ-017. Only admin can read it - and admin cannot book or sell. (Flagged requests live in the advisor queue from step 5.)");
    request("GET", "/api/admin/audit", "admin");
    const audit = await api("GET", "/api/admin/audit", tokenOf("admin"));
    // The endpoint returns newest first, capped at 100, with the full count in `total`.
    const entries = audit.body.entries || [];
    result(audit.status, audit.body.total + " audit entries recorded during this demo. Newest first:");
    entries.slice(0, 12).forEach((e) => point((e.outcome === "success" ? C.green : C.red) + e.outcome.padEnd(8) + C.reset + " " + e.event.padEnd(32) + " " + C.dim + (e.actor || "") + C.reset));

    say("\n" + C.bold + "End of walkthrough." + C.reset + C.dim + " Project status: the Command Center." + C.reset + "\n");
  } finally {
    server.close();
    if (reader) reader.close();
  }
}

main().catch((error) => {
  console.error("\nThe demo stopped: " + (error && error.message ? error.message : error));
  process.exit(1);
});
