// STORY-012: the analytics use case. Reads the booking log, hands the rows to
// revenueAnalytics.js, and writes one audit entry for every generation - the
// story's trust criterion ("the system logs all analytics generation
// activities").
//
// WHAT THIS MODULE IS RESPONSIBLE FOR. The I/O around the arithmetic: reading
// the source, timing the run, the audit entry and the structured log line. It
// does not do the arithmetic (revenueAnalytics.js) and does not decide who may
// call it - routes declare a permission and server.js enforces it.
//
// WHERE THE DATA COMES FROM. The CRM booking log (crmTransactionLog.js), for
// the reason opsBookingBoard.js gives: it is the one durable store every
// booking path writes to. Read per call; there is no cached projection to go
// stale, so "analytics not generated because the cache was cold" cannot happen.
//
// NO AUDIT ENTRY, NO ANALYTICS. Every run - including one that fails to read
// the data - is audited BEFORE anything is returned. If the audit write itself
// fails, the figures are withheld and the caller is told analytics were not
// generated. Showing a manager numbers the audit trail has no record of would
// break the guardrail quietly; refusing breaks nothing and says why.
//
// IDEMPOTENT. Generating analytics changes no business data. The audit key is
// derived from the caller's correlationId, so a retried request records one
// entry, not two (auditLog is first-write-wins).
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Nothing throws. A failed read or a failed
//     audit write returns { ok: false, reason } and is logged with an
//     error_class; a malformed request returns reason "invalid_request".
//  2. Will it retry? No. Both calls are synchronous local store reads/writes;
//     an immediate in-process retry hits the same disk and the same error. The
//     caller may retry the request, which is safe (see IDEMPOTENT).
//  3. Recovery path? Nothing to unwind - no business data was written. The
//     error log line names the correlation id so the operator can trace it.
//  4. Handled: unreadable booking log, audit store failure, invalid
//     actor/correlation id, and every data-quality case revenueAnalytics.js
//     reports (incomplete rows, duplicates, mixed currency, no data). NOT
//     handled: a booking log that is wrong about what was sold - that is the
//     booking path's contract, not this module's.

const { getLoggedTransactions } = require("../booking/crmTransactionLog");
const { recordAudit } = require("../audit/auditLog");
const { generateRevenueAnalytics } = require("./revenueAnalytics");

const AUDIT_EVENT = "analytics.revenue.generated";
const RESOURCE = "analytics:revenue";

// Stable strings: the route maps them onto HTTP status codes and tests assert on them.
const FAILURE_REASONS = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  SOURCE_UNAVAILABLE: "source_unavailable",
  AUDIT_UNAVAILABLE: "audit_unavailable",
});

// Same bounds as every other key in this repo (auditLog uses 8-128). The audit
// key adds a prefix, so the id's own ceiling leaves room for it.
const MIN_CORRELATION_ID_LENGTH = 8;
const MAX_CORRELATION_ID_LENGTH = 100;

const DEFAULT_DEPS = Object.freeze({
  readBookings: getLoggedTransactions,
  recordAudit: recordAudit,
  now: () => Date.now(),
});

function requestProblems(actor, correlationId) {
  const problems = [];
  if (typeof actor !== "string" || actor.trim() === "") {
    problems.push("actor is required and must be a non-empty string");
  }
  if (
    typeof correlationId !== "string" ||
    correlationId.trim().length < MIN_CORRELATION_ID_LENGTH ||
    correlationId.length > MAX_CORRELATION_ID_LENGTH
  ) {
    problems.push(
      `correlationId is required and must be ${MIN_CORRELATION_ID_LENGTH}-${MAX_CORRELATION_ID_LENGTH} characters`
    );
  }
  return problems;
}

function errorClassOf(error) {
  return error && error.name && error.name !== "Error" ? error.name : "UpstreamUnavailable";
}

function logAnalyticsEvent(level, event, outcome, fields) {
  console.error(
    JSON.stringify(
      Object.assign(
        {
          timestamp: new Date().toISOString(),
          level,
          service: "analytics",
          event,
          outcome,
        },
        fields
      )
    )
  );
}

// What goes in the audit entry: enough to say what the manager was shown and
// how complete it was, without copying the figures (the log is not a report).
function auditContext(analytics, durationMs) {
  return {
    status: analytics.status,
    totalRecords: analytics.coverage.totalRecords,
    includedRecords: analytics.coverage.includedRecords,
    missingDataCount: analytics.missingData.length,
    mismatchCount: analytics.mismatches.length,
    durationMs,
  };
}

function readRows(deps) {
  try {
    return { ok: true, rows: deps.readBookings() };
  } catch (error) {
    return { ok: false, error };
  }
}

function writeAudit(deps, entry) {
  try {
    deps.recordAudit(entry);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function generateAnalytics({ actor, correlationId } = {}, overrides = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, overrides);
  const problems = requestProblems(actor, correlationId);
  if (problems.length > 0) {
    return { ok: false, reason: FAILURE_REASONS.INVALID_REQUEST, problems };
  }

  const startedAt = deps.now();
  const read = readRows(deps);
  const analytics = read.ok ? generateRevenueAnalytics(read.rows) : null;
  const durationMs = deps.now() - startedAt;

  const audited = writeAudit(deps, {
    auditKey: `analytics-revenue:${correlationId}`,
    event: AUDIT_EVENT,
    outcome: read.ok ? "success" : "failure",
    actor,
    resource: RESOURCE,
    correlationId,
    context: read.ok
      ? auditContext(analytics, durationMs)
      : { reason: FAILURE_REASONS.SOURCE_UNAVAILABLE, errorClass: errorClassOf(read.error), durationMs },
  });

  if (!audited.ok) {
    logAnalyticsEvent("error", "analytics.audit_failed", "failure", {
      correlation_id: correlationId,
      duration_ms: durationMs,
      error_class: errorClassOf(audited.error),
      context: { message: audited.error && audited.error.message },
    });
    return { ok: false, reason: FAILURE_REASONS.AUDIT_UNAVAILABLE, correlationId };
  }

  if (!read.ok) {
    logAnalyticsEvent("error", "analytics.source_unavailable", "failure", {
      correlation_id: correlationId,
      duration_ms: durationMs,
      error_class: errorClassOf(read.error),
      context: { message: read.error && read.error.message },
    });
    return { ok: false, reason: FAILURE_REASONS.SOURCE_UNAVAILABLE, correlationId };
  }

  logAnalyticsEvent("info", "analytics.generated", analytics.status === "complete" ? "success" : "partial", {
    correlation_id: correlationId,
    duration_ms: durationMs,
    context: { status: analytics.status, includedRecords: analytics.coverage.includedRecords },
  });
  return { ok: true, correlationId, analytics };
}

module.exports = { generateAnalytics, FAILURE_REASONS, AUDIT_EVENT };
