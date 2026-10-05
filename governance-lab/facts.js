// facts.js — reading a field out of an action, and comparing it.
//
// Shared by gate.js (does this rule apply?) and risk.js (does this factor
// fire?). Both ask the same two questions of the same shapes, so the operator
// table lives in one place: a new operator becomes available to rules and risk
// factors at the same moment, and cannot mean two different things.

const OPS = {
  eq: (actual, expected) => actual === expected,
  neq: (actual, expected) => actual !== expected,
  gt: (actual, expected) => actual > expected,
  gte: (actual, expected) => actual >= expected,
  lt: (actual, expected) => actual < expected,
  lte: (actual, expected) => actual <= expected,
};

// Comparisons that are meaningless unless both sides are numbers. `null > 500`
// is false, which would read as "within the limit" — see risk.js, which treats
// an uncomparable value as unable to clear the limit rather than as cleared.
export const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

// Dotted paths so a rule can reach into context, e.g. "context.rowCount".
export function read(source, field) {
  return field
    .split('.')
    .reduce((value, key) => (value == null ? undefined : value[key]), source);
}

export function compare(op, actual, expected) {
  const fn = OPS[op];
  if (!fn) {
    throw new Error(`policy.json uses an unknown operator "${op}"`);
  }
  return fn(actual, expected);
}
