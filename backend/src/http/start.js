// Entry point: start the API.
//
//   COLABERRY_API_TOKENS="tok-a:customer:CUST-1,tok-b:advisor:ADV-1" \
//   COLABERRY_DATA_DIR=./data \
//   PORT=3001 \
//   node backend/src/http/start.js
//
// COLABERRY_API_TOKENS is required - the server refuses to start without it,
// see auth.js. COLABERRY_DATA_DIR is optional; without it the audit stores are
// in-memory and everything is lost on restart, which is fine for a local
// poke-around and wrong for anything else.
//
// Shuts down cleanly on SIGTERM and SIGINT (CLAUDE.md's disposability rule):
// in-flight requests are allowed to finish, then the process exits. A hard
// kill mid-request could leave a customer without the answer we already
// committed to their audit trail.

const { createServer } = require("./server");

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";

function log(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: "http-api",
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context || {},
    })
  );
}

let server;
try {
  server = createServer();
} catch (error) {
  // Almost always a missing or malformed COLABERRY_API_TOKENS. The message
  // says what to fix and never echoes a token.
  log("error", "startup_failed", {
    error_class: error.errorClass || error.name || "UnhandledError",
    message: error.message,
  });
  process.exit(1);
}

server.listen(PORT, HOST, function () {
  log("info", "listening", {
    host: HOST,
    port: PORT,
    persistent_storage: Boolean(process.env.COLABERRY_DATA_DIR),
  });
});

["SIGTERM", "SIGINT"].forEach(function (signal) {
  process.on(signal, function () {
    log("info", "shutting_down", { signal: signal });
    server.close(function () {
      process.exit(0);
    });
  });
});
