// STORY-006: who holds which role, how that changes, and what it costs to change it.
//
// permissions.js answers "what may a role do?" and is a frozen table. This
// module answers "what role does this PERSON have?", which is the half that
// changes at runtime and therefore the half that has to be audited.
//
// TWO SOURCES OF ROLE, AND WHICH ONE WINS.
//   DIRECTORY   - the baseline, from COLABERRY_API_TOKENS (see http/auth.js)
//                 and from logging in to the portal. This is how the FIRST
//                 admin exists: you cannot assign a role when there is nobody
//                 with the authority to assign it, so the bootstrap admin is
//                 declared in the environment by an operator with shell access.
//   ASSIGNMENT  - a row in this store, written by an admin through
//                 assignRole(). Takes precedence over the directory.
//
// Assignment winning is what makes a role change effective without a redeploy.
// The risk it carries is the obvious one - a bad row here silently overrides
// what the environment says - and the answer to that risk is that there is no
// way to write a row except through assignRole(), which is admin-only, refuses
// the dangerous cases below, and audits every attempt including the refusals.
//
// WHY THERE IS NO "YOU MAY NOT GRANT ABOVE YOUR OWN LEVEL" RULE. That is the
// standard escalation guard and it is wrong for this model, because the model
// is not a hierarchy (see permissions.js). An admin does not hold
// portal.trips.read, so a subset rule would forbid an admin from assigning
// somebody the CUSTOMER role - the most ordinary act there is. The guards that
// actually bound escalation here are different and are listed below.
//
// THE FOUR REFUSALS, AND THE ATTACK EACH ONE CLOSES.
//   not_permitted    - the caller lacks admin.roles.assign. Closes the direct
//                      attempt: a customer promoting themselves.
//   self_assignment  - nobody changes their own role, admin included. Closes
//                      the quiet one: an admin who is about to be investigated
//                      re-grading themselves, and an admin locking themselves
//                      out by accident. A real role change for an admin needs a
//                      second admin, which is the point.
//   last_admin       - the final admin cannot be demoted. Closes the denial of
//                      service that cannot be undone from inside the system:
//                      zero admins means nobody can ever assign a role again,
//                      and recovery needs shell access to the environment.
//   unknown_role     - only roles in the permission table may be assigned.
//                      Closes the typo that creates a role with no permissions
//                      ("admn"), which reads in the store like a real grant and
//                      behaves like a lockout.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? A refused assignment returns
//     { ok: false, reason } and writes nothing to the store - but it is still
//     AUDITED, because a rejected attempt to become an admin is the single most
//     interesting line in an audit trail. An unauditable assignment is a
//     different matter: recordAudit throws, and this module lets it, so the
//     change is refused rather than made off the record.
//  2. Will it retry? No. The only I/O is a local synchronous write. The caller
//     may retry safely: assigning a role somebody already holds reports
//     `unchanged` and writes no second audit entry, and the audit key is
//     derived from the caller's correlation id so a replayed request dedups.
//  3. Recovery path? A wrong assignment is corrected by a second assignment,
//     which is itself audited - the store is current state, the audit log is
//     history, and neither is rewritten. If the store is lost entirely, every
//     user falls back to their directory role, which is the safe direction: the
//     bootstrap admin still works and every granted role has to be re-granted.
//  4. Handled here: unauthorised callers, self-assignment, last-admin
//     demotion, unknown roles, malformed and oversized user ids,
//     prototype-chain user ids, replayed requests, and loss on restart. NOT
//     handled: time-bounded roles, approval workflows for a grant, and
//     per-resource scoping ("advisor for THESE customers") - none of which
//     REQ-008 asks for, all of which need a policy engine rather than a table.

const { createJsonFileStore } = require("../shared/jsonFileStore");
const { recordAudit, deriveAuditKey } = require("../audit/auditLog");
const { can, isKnownRole, PERMISSIONS } = require("./permissions");

// Durable when COLABERRY_DATA_DIR is set, in-memory otherwise. Unlike sessions,
// losing these rows is not harmless - it silently reverts every role change
// ever made - so production must set the variable. The fallback direction is at
// least safe: see recovery, above.
const ASSIGNMENTS = createJsonFileStore("role-assignments");

// Bounded and character-restricted because a user id is concatenated into an
// audit key and into log lines. Matches the id shape the portal routes already
// accept.
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const REASONS = {
  ASSIGNED: "assigned",
  UNCHANGED: "unchanged",
  NOT_PERMITTED: "not_permitted",
  SELF_ASSIGNMENT: "self_assignment",
  LAST_ADMIN: "last_admin",
  UNKNOWN_ROLE: "unknown_role",
  INVALID_TARGET: "invalid_target",
};

const ADMIN_ROLE = "admin";

function isValidUserId(userId) {
  return typeof userId === "string" && USER_ID_PATTERN.test(userId);
}

// hasOwnProperty via the store's own `has`, not a bare lookup - the store is
// Map-backed, so "constructor" is safe, but isValidUserId rejects it first
// anyway. Belt and braces, because this is the function every access decision
// downstream depends on.
function findAssignment(userId) {
  if (!isValidUserId(userId)) {
    return null;
  }
  return ASSIGNMENTS.get(userId) || null;
}

// THE FUNCTION THE BOUNDARY CALLS ON EVERY REQUEST.
//
// `directoryRole` is what the credential itself claims - the role baked into
// the API token, or the role on the session. An assignment overrides it.
// Returns null when neither source knows this user, and null is not a role:
// can(null, anything) is false, so an unknown user is denied by default rather
// than defaulting to "customer".
function resolveRole(userId, directoryRole) {
  const assignment = findAssignment(userId);
  if (assignment && isKnownRole(assignment.role)) {
    return assignment.role;
  }
  // An assignment naming a role that no longer exists (the table was edited and
  // a role retired) is ignored rather than honoured, and the directory answer
  // stands. Honouring it would grant a role with no permissions, which reads as
  // a lockout nobody can explain.
  return isKnownRole(directoryRole) ? directoryRole : null;
}

// Every user the system knows about, with their EFFECTIVE role. The directory
// is passed in rather than imported so this module never reads the environment
// - the boundary owns that, and tests can hand it whatever they need.
//
// Union of the two sources: a user may exist only in the directory (never
// re-assigned) or only in the store (assigned a role before their credential
// was provisioned).
function listRoles(directory = []) {
  const roles = new Map();

  for (const principal of directory) {
    if (principal && isValidUserId(principal.userId)) {
      roles.set(principal.userId, {
        userId: principal.userId,
        role: resolveRole(principal.userId, principal.role),
        source: findAssignment(principal.userId) ? "assignment" : "directory",
      });
    }
  }

  for (const assignment of ASSIGNMENTS.values()) {
    if (assignment && isValidUserId(assignment.userId) && !roles.has(assignment.userId)) {
      roles.set(assignment.userId, {
        userId: assignment.userId,
        role: resolveRole(assignment.userId, null),
        source: "assignment",
      });
    }
  }

  return Array.from(roles.values()).sort(function (a, b) {
    return a.userId.localeCompare(b.userId);
  });
}

function countAdmins(directory) {
  return listRoles(directory).filter(function (entry) {
    return entry.role === ADMIN_ROLE;
  }).length;
}

// Audits a refusal and returns it. Pulled out because there are five refusal
// paths and every one of them must be audited - a refusal that returns without
// writing is exactly the hole AC-3 exists to close, and it is an easy one to
// leave in by adding a sixth refusal later. One helper means the audit is not
// something a new branch has to remember.
function refuse(reason, { actorUserId, targetUserId, role, correlationId }) {
  recordAudit({
    auditKey: deriveAuditKey("role-assign:" + correlationId, reason),
    event: "authz.role_assignment.refused",
    outcome: "failure",
    actor: actorUserId,
    // A refusal for an INVALID target still records what was asked for, but the
    // resource field takes only well-formed ids; the raw value goes in context,
    // where redaction and depth limits apply.
    resource: isValidUserId(targetUserId) ? targetUserId : null,
    correlationId: correlationId,
    context: {
      reason: reason,
      requestedRole: typeof role === "string" ? role.slice(0, 64) : String(role),
      targetShape: isValidUserId(targetUserId) ? "valid" : "rejected",
    },
  });
  return { ok: false, reason: reason };
}

// Changes a user's role. Returns { ok, reason, assignment? } and never throws
// for a bad REQUEST - only for an unauditable one.
//
// `directory` is the baseline principal list, needed for the last-admin count.
// `now` is injectable so tests do not depend on the clock.
//
// ============================ THIS FUNCTION MUST NOT YIELD ============================
//
// It is SYNCHRONOUS from the first line to the last, and that is load-bearing,
// not incidental. Everything it touches is synchronous too: resolveRole,
// countAdmins, recordAudit, and the store's set() (fs.writeFileSync
// underneath). Node therefore cannot interleave two calls, and the
// read-then-write below is atomic by construction.
//
// WHAT BREAKS THE MOMENT SOMEONE ADDS AN `await`. The last-admin guard reads
// the admin count and then writes; between those two points there must be no
// suspension. With one, two concurrent mutual demotions - A demoting B while B
// demotes A - would BOTH read a count of 2, both conclude they are not
// removing the last admin, and both commit. The system lands on zero admins,
// which is the one state nothing inside it can recover from: no admin means no
// one can ever assign a role again, and the fix needs shell access to the
// environment.
//
// So: do not make this async. Do not await anything inside it. Do not call
// anything from it that might become async later without re-checking this.
// When this repo moves to Postgres, the guard becomes a transaction with the
// admin count read FOR UPDATE, not an await bolted onto this shape.
//
// Defended by adminConcurrency.test.js, which asserts this is not an
// AsyncFunction and drives the mutual-demotion race over real HTTP.
// =====================================================================================
function assignRole(
  { actorUserId, actorRole, targetUserId, role, reason, correlationId },
  { directory = [], now = Date.now() } = {}
) {
  // A correlation id is required, not optional. It is the audit key's base, and
  // an audit trail whose entries cannot be tied back to a request is evidence
  // of nothing. The boundary always has one.
  if (typeof correlationId !== "string" || correlationId.trim() === "") {
    throw new Error("assignRole requires a correlationId; the audit key is derived from it.");
  }

  const audited = {
    actorUserId: isValidUserId(actorUserId) ? actorUserId : null,
    targetUserId: targetUserId,
    role: role,
    correlationId: correlationId,
  };

  // PERMISSION FIRST, before anything else is even validated. Checking the
  // target's shape first would let an unauthorised caller probe which user ids
  // are well-formed, and it would put their attempt in the audit trail under a
  // validation reason rather than under "tried to assign a role without
  // permission", which is the line an incident review is looking for.
  if (!can(actorRole, PERMISSIONS.ADMIN_ROLES_ASSIGN)) {
    return refuse(REASONS.NOT_PERMITTED, audited);
  }

  if (!isValidUserId(targetUserId)) {
    return refuse(REASONS.INVALID_TARGET, audited);
  }

  if (!isKnownRole(role)) {
    return refuse(REASONS.UNKNOWN_ROLE, audited);
  }

  if (actorUserId === targetUserId) {
    return refuse(REASONS.SELF_ASSIGNMENT, audited);
  }

  const currentRole = resolveRole(targetUserId, directoryRoleOf(directory, targetUserId));

  // Idempotent: the state is already what was asked for. Reported distinctly
  // from `assigned` so a caller can tell "I changed something" from "it was
  // already so", and audited as a success because the attempt did happen.
  if (currentRole === role) {
    recordAudit({
      auditKey: deriveAuditKey("role-assign:" + correlationId, REASONS.UNCHANGED),
      event: "authz.role_assignment.unchanged",
      outcome: "success",
      actor: actorUserId,
      resource: targetUserId,
      correlationId: correlationId,
      context: { role: role },
    });
    return { ok: true, reason: REASONS.UNCHANGED, assignment: findAssignment(targetUserId) };
  }

  // LAST ADMIN. Only bites when this change would REMOVE an admin, so promoting
  // somebody to admin is never blocked by it.
  if (currentRole === ADMIN_ROLE && countAdmins(directory) <= 1) {
    return refuse(REASONS.LAST_ADMIN, audited);
  }

  // WRITE-AHEAD. The audit entry is written BEFORE the store changes, using the
  // "pending" outcome that auditLog.js provides for exactly this. If the
  // process dies between the two lines, the trail says an assignment was
  // attempted and does not claim it succeeded - which is recoverable. The other
  // order (change, then audit) loses the entry for a change that really
  // happened, and a change nobody can see is the one thing an audit trail
  // exists to prevent.
  const previousRole = currentRole;
  recordAudit({
    auditKey: deriveAuditKey("role-assign:" + correlationId, "pending"),
    event: "authz.role_assignment.attempted",
    outcome: "pending",
    actor: actorUserId,
    resource: targetUserId,
    correlationId: correlationId,
    context: { fromRole: previousRole, toRole: role },
  });

  const assignment = Object.freeze({
    userId: targetUserId,
    role: role,
    previousRole: previousRole,
    assignedBy: actorUserId,
    assignedAt: new Date(now).toISOString(),
    // Free text from an admin, bounded and stored for the incident review that
    // will one day ask "why does this person have this?".
    reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim().slice(0, 280) : null,
    correlationId: correlationId,
  });

  ASSIGNMENTS.set(targetUserId, assignment);

  recordAudit({
    auditKey: deriveAuditKey("role-assign:" + correlationId, REASONS.ASSIGNED),
    event: "authz.role_assignment.changed",
    outcome: "success",
    actor: actorUserId,
    resource: targetUserId,
    correlationId: correlationId,
    context: { fromRole: previousRole, toRole: role, reason: assignment.reason },
  });

  return { ok: true, reason: REASONS.ASSIGNED, assignment: assignment };
}

// The role the directory claims for a user, or null. Kept private: callers
// outside this module should ask resolveRole, which applies assignments.
function directoryRoleOf(directory, userId) {
  for (const principal of directory) {
    if (principal && principal.userId === userId) {
      return principal.role;
    }
  }
  return null;
}

// Test-only. Named so it cannot be mistaken for part of the operational
// surface: there is deliberately no "revoke" or "delete assignment" API, since
// the way to undo a role change is another, audited, role change.
function __resetAssignmentsForTests() {
  for (const key of Array.from(ASSIGNMENTS.keys())) {
    ASSIGNMENTS.delete(key);
  }
}

module.exports = {
  assignRole,
  resolveRole,
  findAssignment,
  listRoles,
  countAdmins,
  isValidUserId,
  REASONS,
  ADMIN_ROLE,
  __resetAssignmentsForTests,
};
