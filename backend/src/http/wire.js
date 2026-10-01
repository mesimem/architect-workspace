// The socket-level mechanics of the HTTP boundary: reading a request body,
// shaping a response, and the structured log line.
//
// WHY THIS IS ITS OWN FILE. Extracted from server.js at STORY-016, for the
// same reason and under the same rule that moved the endpoints into routes/ at
// STORY-005: CLAUDE.md sets a 500-line hard ceiling and requires the next
// change to an oversize file to split it BEFORE adding code. server.js had
// reached 475 lines and this story adds admission control to the pipeline.
//
// The line the split follows, continuing the one server.js's header already
// describes:
//
//   wire.js      how a request body becomes JSON, how a response leaves, how
//                a log line is shaped. Knows about sockets. Knows nothing
//                about routes, roles, or load.
//   server.js    the pipeline - correlation ids, authentication, permissions,
//                admission, the catch-all. Knows nothing about Content-Length.
//   routes/*     what each endpoint does. Never sees `res` at all.
//
// THIS EXTRACTION IS A PURE MOVE. Every function below is byte-for-byte the
// code that was in server.js, with its comments intact. No signature changed,
// no behaviour changed, nothing was "tidied" on the way across - which is the
// whole point: it makes the untouched test suite a valid regression proof. A
// move and an improvement in one commit are indistinguishable from each other
// afterwards, and the improvement is where the bug hides.

"use strict";

const MAX_BODY_BYTES = 64 * 1024;
const SERVICE_NAME = "http-api";

function log(level, event, context) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level,
      service: SERVICE_NAME,
      event: event,
      outcome: level === "error" ? "failure" : "success",
      context: context,
    })
  );
}

function send(res, status, body, correlationId, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(
    status,
    Object.assign(
      {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Correlation-ID": correlationId,
      },
      extraHeaders || {}
    )
  );
  res.end(payload);
}

// One shape for every error, so a client never has to guess. `error` is a
// stable code; `message` is safe to show a human. Internal detail never
// crosses this line.
//
// STORY-016 added the optional sixth argument, the only change made to any of
// this file's moved code. One error needs a header: the 503 from load
// shedding carries Retry-After, and a shed client that does not know when to
// come back retries immediately, which is what turns overload into a retry
// storm. Additive and unused by every existing caller.
function sendError(res, status, code, message, correlationId, extraHeaders) {
  send(
    res,
    status,
    { error: code, message: message, correlationId: correlationId },
    correlationId,
    extraHeaders
  );
}

// Anything past MAX_BODY_BYTES is dropped rather than buffered, but the
// request is still DRAINED so the 413 can actually be delivered. Destroying
// the socket the moment the limit is crossed - the obvious implementation, and
// the one written first here - makes the client see a dropped connection
// instead of a clear error, which is indistinguishable from the server having
// crashed. Only a genuinely pathological upload gets the socket closed.
const ABORT_BODY_BYTES = MAX_BODY_BYTES * 16;

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let tooLarge = false;
    let chunks = [];

    req.on("data", function (chunk) {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks = []; // release what was buffered; it will never be parsed
      } else {
        chunks.push(chunk);
      }

      if (size > ABORT_BODY_BYTES) {
        reject(Object.assign(new Error("body far too large"), { code: "body_too_large" }));
        req.destroy();
      }
    });

    req.on("error", function (error) {
      reject(Object.assign(error, { code: "read_failed" }));
    });

    req.on("end", function () {
      if (tooLarge) {
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error("invalid json"), { code: "invalid_json" }));
      }
    });
  });
}

module.exports = {
  log,
  send,
  sendError,
  readJsonBody,
  MAX_BODY_BYTES,
  ABORT_BODY_BYTES,
  SERVICE_NAME,
};
