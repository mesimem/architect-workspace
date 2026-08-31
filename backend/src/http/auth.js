// STORY-003 (boundary work): who is calling, and what are they allowed to do.
//
// This is the minimum honest implementation of the project guardrail "the
// system must support secure authentication and role-based permissions" at the
// one boundary that now exists. It is deliberately NOT the full story:
// REQ-008 / STORY-006 owns real authentication (sessions, password handling,
// rotation, an identity provider). What this gives the build today is that no
// route is reachable without a credential, and no role can do another role's
// work.
//
// TOKENS COME FROM THE ENVIRONMENT, NEVER FROM SOURCE.
//   COLABERRY_API_TOKENS="<token>:<role>:<userId>,<token>:<role>:<userId>"
// If the variable is missing or empty the server refuses to start. An
// authentication layer that silently degrades to "allow everyone" when its
// config is absent is worse than none, because it looks like protection.
//
// Tokens are never logged, never echoed in an error, and never included in a
// response body. Comparison is constant-time, so a caller cannot learn a valid
// token one character at a time by measuring how long a rejection takes.

const crypto = require("crypto");

const ROLES = ["customer", "advisor"];

class AuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthConfigError";
    this.errorClass = "ConfigError";
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

// Compares digests rather than raw strings so both sides are always the same
// length - timingSafeEqual throws on a length mismatch, which would itself
// leak the length of a valid token.
function constantTimeEquals(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Returns [{ tokenDigest, role, userId }]. Throws rather than returning an
// empty list: an empty token table means nobody can call anything, which is a
// misconfiguration, not a valid state.
function loadPrincipals(raw = process.env.COLABERRY_API_TOKENS) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AuthConfigError(
      "COLABERRY_API_TOKENS is not set. Expected \"<token>:<role>:<userId>\" entries " +
        "separated by commas. Refusing to start an unauthenticated API."
    );
  }

  const principals = raw
    .split(",")
    .map(function (entry) {
      return entry.trim();
    })
    .filter(function (entry) {
      return entry !== "";
    })
    .map(function (entry) {
      const parts = entry.split(":");
      if (parts.length !== 3) {
        // Deliberately does not echo the entry - it contains a token.
        throw new AuthConfigError(
          "A COLABERRY_API_TOKENS entry is malformed. Expected exactly " +
            "<token>:<role>:<userId>."
        );
      }
      const [token, role, userId] = parts.map(function (p) {
        return p.trim();
      });
      if (!ROLES.includes(role)) {
        throw new AuthConfigError(
          "Unknown role " + JSON.stringify(role) + ". Known roles: " + ROLES.join(", ") + "."
        );
      }
      if (token.length < 8) {
        throw new AuthConfigError("An API token is shorter than 8 characters; refusing to use it.");
      }
      if (userId === "") {
        throw new AuthConfigError("A COLABERRY_API_TOKENS entry has an empty userId.");
      }
      return { token: token, role: role, userId: userId };
    });

  if (principals.length === 0) {
    throw new AuthConfigError("COLABERRY_API_TOKENS contained no usable entries.");
  }

  return principals;
}

// Returns the principal, or null. Null covers every reason equally - missing
// header, wrong scheme, unknown token - because telling a caller WHICH of
// those went wrong helps an attacker and helps nobody else.
function authenticate(authorizationHeader, principals) {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    return null;
  }
  const presented = match[1].trim();

  for (const principal of principals) {
    if (constantTimeEquals(presented, principal.token)) {
      return { userId: principal.userId, role: principal.role };
    }
  }
  return null;
}

function hasRole(principal, allowedRoles) {
  return Boolean(principal) && allowedRoles.includes(principal.role);
}

module.exports = { loadPrincipals, authenticate, hasRole, ROLES, AuthConfigError };
