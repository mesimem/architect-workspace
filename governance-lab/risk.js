// risk.js — scores an action against the factors in policy.json.
//
// Every factor in the model is scored on every action, including the ones that
// find nothing. A factor that scored zero is a fact the approver was shown and
// can rely on; a factor silently omitted is a fact nobody checked. The pending
// file carries all five for exactly that reason.
//
// The thresholds are in policy.json, not here. This file knows how to add up
// points and find the band a total falls in; it does not know what a risky
// refund looks like.

import { NUMERIC_OPS, compare, read } from './facts.js';

function needsNumber(factor) {
  return (factor.tiers ?? []).some((tier) => NUMERIC_OPS.has(tier.op));
}

function scoreFactor(action, factor) {
  const found = read(action, factor.field);
  const value = found === undefined ? (factor.whenMissing ?? null) : found;

  const base = {
    id: factor.id,
    label: factor.label,
    field: factor.field,
    value,
  };

  // A limit that cannot be compared is a limit that cannot be cleared. Without
  // this, a refund carrying a null amount would score zero on the amount
  // factor and read as "within the $500 limit".
  if (needsNumber(factor) && typeof value !== 'number') {
    const fallback = factor.uncomparable ?? {
      points: 0,
      note: `${factor.id} could not be compared`,
    };
    return { ...base, points: fallback.points, note: fallback.note };
  }

  // First matching tier wins, so tiers are ordered most severe first.
  for (const tier of factor.tiers ?? []) {
    if (compare(tier.op, value, tier.value)) {
      return { ...base, points: tier.points, note: tier.note };
    }
  }

  return {
    ...base,
    points: factor.points ?? 0,
    note: factor.note ?? 'no signal',
  };
}

export function assess(action, model) {
  if (!model || !Array.isArray(model.factors) || !Array.isArray(model.bands)) {
    throw new Error(
      'policy.json rule is missing a risk model with factors and bands'
    );
  }

  const factors = model.factors.map((factor) => scoreFactor(action, factor));
  const score = factors.reduce((total, factor) => total + factor.points, 0);

  // The last band carries no max and catches everything above the others.
  const band = model.bands.find((b) => b.max === undefined || score <= b.max);
  if (!band) {
    throw new Error(
      `policy.json risk bands do not cover a score of ${score}; the last band must have no max`
    );
  }

  return { score, verdict: band.verdict, factors };
}

export function ceilingFor(model, verdict) {
  return model.bands.find((band) => band.verdict === verdict)?.max;
}
