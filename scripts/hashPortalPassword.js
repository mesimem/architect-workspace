#!/usr/bin/env node
// STORY-005: mint a portal password hash for COLABERRY_PORTAL_CREDENTIALS.
//
//   node scripts/hashPortalPassword.js               -> prints just the hash
//   node scripts/hashPortalPassword.js CUST-1        -> prints CUST-1:<hash>
//
// The password is read from STDIN, never from argv. That is not fussiness:
// an argument lands in the operator's shell history, in `ps` output while the
// process runs, and in any shell-audit log the machine keeps. A password
// typed once and hashed immediately leaves none of those traces.
//
// When run in a terminal the input is not echoed, so it does not stay on
// screen or in a scrollback buffer. When run in a pipe it just reads stdin, so
// it composes with a password manager:
//
//   op read op://vault/portal/CUST-1 | node scripts/hashPortalPassword.js CUST-1
//
// WHAT THIS SCRIPT DOES NOT DO, on purpose:
//   - it does not write to any file, so it cannot leave a hash lying around
//   - it does not touch .env, because that file is not the store of record
//     (production reads env vars set on the host - see CLAUDE.md's 12-factor
//     rules) and editing it here would invite committing a credential
//   - it does not print the password back, ever, not even on an error
//
// Guidance goes to stderr and the hash alone goes to stdout, so the useful
// part can be piped or captured without capturing the prose around it.

const readline = require("readline");

const { hashPassword, MIN_NEW_PASSWORD_LENGTH } = require("../backend/src/services/portal/portalCredentials");

const customerId = process.argv[2];

function note(message) {
  process.stderr.write(message + "\n");
}

// Reads one line without echoing it. Raw mode is handled by hand rather than
// with a library, since the repo has no dependencies: Enter ends the line,
// backspace deletes, and Ctrl-C aborts without leaving the terminal in raw
// mode - which is the bug every hand-rolled version of this has.
function readSecretFromTty() {
  return new Promise(function (resolve, reject) {
    process.stderr.write("Portal password (not shown): ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let secret = "";

    function restore() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004" /* Ctrl-D */) {
          restore();
          process.stderr.write("\n");
          resolve(secret);
          return;
        }
        if (character === "\u0003" /* Ctrl-C */) {
          // Ctrl-C. Restore the terminal before leaving, or the operator's
          // shell stops echoing their own typing.
          restore();
          process.stderr.write("\nAborted.\n");
          reject(Object.assign(new Error("aborted"), { aborted: true }));
          return;
        }
        if (character === "\u007f" /* backspace */ || character === "\b") {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += character;
      }
    }

    process.stdin.on("data", onData);
  });
}

function readSecretFromPipe() {
  return new Promise(function (resolve, reject) {
    const rl = readline.createInterface({ input: process.stdin });
    let first = null;
    rl.on("line", function (line) {
      if (first === null) {
        first = line; // a password manager may add a trailing newline
      }
    });
    rl.on("close", function () {
      resolve(first === null ? "" : first);
    });
    rl.on("error", reject);
  });
}

async function main() {
  const password = process.stdin.isTTY ? await readSecretFromTty() : await readSecretFromPipe();

  if (password.length < MIN_NEW_PASSWORD_LENGTH) {
    // Says the rule, not the input. The length of what was typed is itself
    // worth not repeating back into a terminal someone else may be watching.
    note(
      "Refused: a portal password must be at least " +
        MIN_NEW_PASSWORD_LENGTH +
        " characters. Nothing was hashed."
    );
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);

  process.stdout.write((customerId ? customerId + ":" : "") + hash + "\n");

  note("");
  note("Add it to COLABERRY_PORTAL_CREDENTIALS as <customerId>:<hash>, comma-separated:");
  note('  COLABERRY_PORTAL_CREDENTIALS="' + (customerId || "CUST-1") + ':<the hash above>"');
  note("");
  note("Set it as an environment variable on the host. Do NOT commit it.");
}

main().catch(function (error) {
  if (error && error.aborted) {
    process.exitCode = 130; // conventional exit code for SIGINT
    return;
  }
  note("Failed: " + (error && error.message ? error.message : "unknown error"));
  process.exitCode = 1;
});
