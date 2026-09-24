// STORY-006: the admin surface. The first routes in this build that exist to
// operate the SYSTEM rather than to serve a trip.
//
// Three endpoints, and they are deliberately the three that make the
// acceptance criteria demonstrable rather than merely true:
//
//   GET  /api/admin/roles  - who holds what, and where that role came from
//   POST /api/admin/roles  - change one, with every refusal audited
//   GET  /api/admin/audit  - read the trail, so "the system logs this" can be
//                            checked through the API instead of by reading a
//                            JSON file over someone's shoulder
//
// EACH ONE NAMES A DIFFERENT PERMISSION, and that is not decoration. Reading
// who is an admin and being able to MAKE one are different powers, and a later
// role - a compliance reviewer, say - should be able to hold the first without
// the second. Collapsing them into one `admin.everything` would make that
// impossible without re-cutting every route.
//
// NOTHING HERE RE-CHECKS THE CALLER'S ROLE. The pipeline in ../server.js has
// already refused anyone without the route's permission, and a second check
// inside the handler is not defence in depth - it is a second policy, which
// can disagree with the first. The one exception is assignRole(), which checks
// the permission itself because it is also callable from a script with no HTTP
// boundary in front of it.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A refused assignment comes back as a status
//     and a stable reason code, never a partial change - roleAssignments.js
//     writes nothing on any refusal path. A read that finds nothing returns an
//     empty list, not a 404: "no roles have been assigned" is a real answer.
//  2. Will it retry? No, and the caller does not need to. POST is idempotent
//     on the state (assigning a role somebody already holds reports
//     `unchanged`) and on the audit trail (the entry is keyed on the
//     correlation id, so a replayed request writes nothing new).
//  3. Recovery path? A wrong assignment is corrected by another assignment,
//     which is itself audited. There is deliberately no delete.
//  4. Handled here: malformed and oversized bodies, unknown roles, unusable
//     target ids, self-assignment, last-admin demotion, and a caller without
//     the permission. NOT handled: bulk assignment, pagination of the audit
//     trail beyond a hard cap, and filtering it by actor or date - all of
//     which want query parameters, and the pipeline does not parse a query
//     string yet. Adding one is a change to server.js, not to this file.

const {
  assignRole,
  listRoles,
  REASONS: ASSIGN_REASONS,
} = require("../../services/authz/roleAssignments");
const { getAuditEntries } = require("../../services/audit/auditLog");
const { PERMISSIONS, ROLES } = require("../../services/authz/permissions");

// Bounds the free-text field an admin may attach to an assignment. Long enough
// for a real justification ("covering the Nairobi desk while J is on leave"),
// short enough that it cannot be used to write a novel into the audit store.
const MAX_REASON_LENGTH = 280;
const MAX_USER_ID_LENGTH = 64;

// How many audit entries one read returns. A hard cap rather than "all of
// them": the store holds every event ever recorded, and an unbounded response
// is a memory spike on the server and a timeout on the client, on exactly the
// endpoint someone reaches for during an incident.
const AUDIT_PAGE_SIZE = 100;

// Refusal reason -> HTTP status. A table, for the same reason the login route
// uses one: a reason added to the service later shows up here as an explicit
// 500 rather than being quietly reported as success.
//
// WHY last_admin IS 409 AND NOT 403. A 403 says "you may not do this" - but
// this admin may demote people, and would succeed on any other target. What
// failed is a SYSTEM INVARIANT: there must always be at least one admin. 409
// Conflict says that, and it tells the caller the fix is to change the world
// (promote a second admin) rather than to find someone with more authority.
const ASSIGN_STATUS_CODES = {
  [ASSIGN_REASONS.ASSIGNED]: 200,
  [ASSIGN_REASONS.UNCHANGED]: 200,
  [ASSIGN_REASONS.NOT_PERMITTED]: 403,
  [ASSIGN_REASONS.SELF_ASSIGNMENT]: 403,
  [ASSIGN_REASONS.LAST_ADMIN]: 409,
  [ASSIGN_REASONS.UNKNOWN_ROLE]: 400,
  [ASSIGN_REASONS.INVALID_TARGET]: 400,
};

// Human-readable text per refusal. Separate from the reason code on purpose:
// the code is a stable contract for a client to branch on, the message is for
// the person reading the response, and conflating them means changing the
// wording is a breaking API change.
const ASSIGN_MESSAGES = {
  [ASSIGN_REASONS.NOT_PERMITTED]: "You do not have permission to assign roles.",
  [ASSIGN_REASONS.SELF_ASSIGNMENT]:
    "You cannot change your own role. Ask another admin to make this change.",
  [ASSIGN_REASONS.LAST_ADMIN]:
    "This is the last admin. Promote another admin before changing this one.",
  [ASSIGN_REASONS.UNKNOWN_ROLE]: "Unknown role. Known roles: " + ROLES.join(", ") + ".",
  [ASSIGN_REASONS.INVALID_TARGET]:
    "userId must be 1-" + MAX_USER_ID_LENGTH + " characters of letters, digits, hyphen or underscore.",
};

// Envelope validation only - is this the right SHAPE? Whether the role may
// actually be assigned to this person is the service's judgement, and
// duplicating those rules here would give us two sets that drift. In
// particular this does NOT check that `role` is a known role: that refusal is
// audited by the service, and rejecting it here would lose the audit entry.
function validateAssignBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  const problems = [];

  if (typeof body.userId !== "string" || body.userId === "") {
    problems.push("userId must be a non-empty string");
  } else if (body.userId.length > MAX_USER_ID_LENGTH) {
    problems.push("userId must be at most " + MAX_USER_ID_LENGTH + " characters");
  }

  if (typeof body.role !== "string" || body.role === "") {
    problems.push("role must be a non-empty string");
  }

  if (body.reason !== undefined && typeof body.reason !== "string") {
    problems.push("reason, when given, must be a string");
  } else if (typeof body.reason === "string" && body.reason.length > MAX_REASON_LENGTH) {
    problems.push("reason must be at most " + MAX_REASON_LENGTH + " characters");
  }

  return problems;
}

const adminRoutes = [
  {
    method: "GET",
    pattern: /^\/api\/admin\/roles$/,
    permission: PERMISSIONS.ADMIN_ROLES_READ,
    handler: async function (context) {
      // `source` tells an operator whether a role came from the environment or
      // from an assignment. Without it, "why is this person an advisor?" has
      // two possible answers and no way to tell them apart - which is the
      // first question asked when a permission looks wrong.
      const roles = listRoles(context.directory);
      return {
        status: 200,
        body: { count: roles.length, roles: roles },
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/roles$/,
    permission: PERMISSIONS.ADMIN_ROLES_ASSIGN,
    handler: async function (context) {
      const problems = validateAssignBody(context.body);
      if (problems.length > 0) {
        // A malformed submission is not an assignment ATTEMPT, so it is not
        // audited as one - the same line the login route draws. A client
        // sending the wrong shape never reached the decision.
        return { status: 400, body: { error: "invalid_request_body", problems: problems } };
      }

      const result = assignRole(
        {
          actorUserId: context.principal.userId,
          // The role the pipeline resolved, not anything from the body. A
          // request cannot nominate the authority it is acting under.
          actorRole: context.principal.role,
          targetUserId: context.body.userId,
          role: context.body.role,
          reason: context.body.reason,
          correlationId: context.correlationId,
        },
        { directory: context.directory }
      );

      const status = ASSIGN_STATUS_CODES[result.reason] || 500;

      if (!result.ok) {
        return {
          status: status,
          body: {
            error: result.reason,
            message: ASSIGN_MESSAGES[result.reason] || "The role change was refused.",
          },
        };
      }

      return {
        status: status,
        body: {
          status: result.reason,
          userId: context.body.userId,
          role: context.body.role,
          // Null on an `unchanged` result for a role that came from the
          // directory and has never been assigned - there is no row to show.
          assignment: result.assignment || null,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/admin\/audit$/,
    permission: PERMISSIONS.ADMIN_AUDIT_READ,
    handler: async function () {
      const all = getAuditEntries();
      // Newest first: during an incident the interesting entry is the last one
      // written, and making someone scroll to the bottom of 100 rows to find
      // it is a small cruelty. `total` is reported alongside so a truncated
      // response is obvious rather than looking like the whole trail.
      const page = all
        .slice()
        .sort(function (a, b) {
          return b.recordedAt.localeCompare(a.recordedAt);
        })
        .slice(0, AUDIT_PAGE_SIZE);

      return {
        status: 200,
        body: {
          total: all.length,
          returned: page.length,
          truncated: all.length > page.length,
          entries: page,
        },
      };
    },
  },
];

module.exports = { adminRoutes, validateAssignBody, AUDIT_PAGE_SIZE, MAX_REASON_LENGTH };
