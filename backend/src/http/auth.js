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
// STORY-005 ADDS A SECOND KIND OF CREDENTIAL. There are now two, and they are
// for two different callers:
//
//   API TOKEN  - a long-lived string from the environment. A service or an
//                advisor tool calling us. Never expires; rotated by an
//                operator editing COLABERRY_API_TOKENS.
//   SESSION    - issued by POST /api/portal/login when a customer presents a
//                password. Expires (idle and absolute), revocable, and
//                belongs to exactly one customer.
//
// BOTH ARE CHECKED BY THE SAME FUNCTION, on purpose. The tempting alternative
// - a second middleware for portal routes - means every new route has to pick
// the right one, and the first route that picks wrong is a hole nobody sees.
// One function, one call site in server.js, both credential kinds.
//
// The API-token table is tried FIRST, and that ordering is deliberate: it is a
// small in-memory list of digest comparisons, while a session lookup hits the
// session store. Neither is expensive, but the cheap, bounded one going first
// means an attacker spraying random bearer tokens cannot preferentially load
// the store.
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

const {
  verifySession,
  REASONS: SESSION_REASONS,
} = require("../services/portal/portalSessions");

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

// Pulls the bearer token out of the header, or null. Exported because the
// logout route needs the presented token itself, not just who it belongs to -
// you cannot revoke a session you cannot name.
function bearerTokenFrom(authorizationHeader) {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1].trim() : null;
}

// Returns { ok: true, principal } or { ok: false, reason }.
//
// CONTRACT CHANGE (STORY-005): this returned a bare principal-or-null before.
// It has to say more now, because ONE rejection is worth distinguishing: a
// session that was valid and has since expired. A customer whose session timed
// out needs to be told to sign in again, and "unauthorized" does not tell them
// that. Every OTHER rejection stays deliberately indistinguishable - missing
// header, wrong scheme, unknown token and revoked session all report
// `unauthorized`, because telling a caller which one went wrong helps an
// attacker and helps nobody else.
//
// Distinguishing expiry leaks nothing: only the holder of a token we really
// issued can see it, and they already had access.
//
// `verify` is injected so this module can be reasoned about, and tested,
// without the session store's clock.
function authenticate(authorizationHeader, principals, { verify = verifySession } = {}) {
  const presented = bearerTokenFrom(authorizationHeader);
  if (presented === null) {
    return { ok: false, reason: "unauthorized" };
  }

  for (const principal of principals) {
    if (constantTimeEquals(presented, principal.token)) {
      return {
        ok: true,
        principal: {
          userId: principal.userId,
          role: principal.role,
          credential: "api_token",
          sessionId: null,
        },
      };
    }
  }

  const session = verify(presented);
  if (session.ok) {
    return {
      ok: true,
      principal: {
        userId: session.session.customerId,
        role: session.session.role,
        credential: "session",
        sessionId: session.session.sessionId,
      },
    };
  }

  const expired =
    session.reason === SESSION_REASONS.IDLE_TIMEOUT ||
    session.reason === SESSION_REASONS.ABSOLUTE_TIMEOUT;

  return { ok: false, reason: expired ? "session_expired" : "unauthorized" };
}

function hasRole(principal, allowedRoles) {
  return Boolean(principal) && allowedRoles.includes(principal.role);
}

module.exports = {
  loadPrincipals,
  authenticate,
  bearerTokenFrom,
  hasRole,
  ROLES,
  AuthConfigError,
};
