// STORY-009: the scorer. Given what a customer said they want and a list of
// trips, decide which ones to put in front of them and say why.
//
// THIS IS THE "AI MODULE", AND IT IS DELIBERATELY NOT A MODEL. CLAUDE.md's core
// principle is that probabilistic components do not decide production outcomes,
// and REQ-011 asks for suggestions, not for a particular technology. So the
// ranking here is a plain weighted match a junior developer can read, reproduce
// and argue with: the same preferences against the same corpus always produce
// the same list, in the same order, with the same stated reasons. That is what
// makes the story's acceptance criteria testable at all.
//
// IT IS A PORT, NOT A DEAD END. The whole module is one function of one
// argument - suggestTrips({ preferences, trips, limit }) - returning a plain
// result object, which is exactly the shape shared/callWithRetry.js wraps. An
// engine that called a model instead would implement the same signature and
// drop in at the single call site in tripSuggestionService.js, inheriting that
// file's timeout, retries, audit trail and advisor flag without touching any of
// them. Nothing else in this story knows which engine ran.
//
// WHAT IT IS PURE OF. No store reads, no logging, no clock, no randomness. Its
// tests hand it a literal array. A scorer that fetched its own corpus could not
// be tested for "irrelevant suggestions" without first arranging for irrelevant
// data to exist in a store.
//
// THE TWO IDEAS WORTH UNDERSTANDING BEFORE READING THE CODE:
//
// 1. ONLY STATED PREFERENCES COUNT. Weights are normalised over the dimensions
//    the customer actually mentioned. A customer who names a budget and nothing
//    else is scored out of the budget weight alone, so every trip in their
//    price range scores 1.0 - rather than 0.2, which is what a fixed
//    denominator would give and would then look like "nothing matches".
//
// 2. SOME MISSES ARE FILTERS, NOT DEDUCTIONS. Three of them:
//    - Budget and duration are ceilings a customer stated about their own life.
//      A trip at triple the budget is not a weaker match, it is not a trip they
//      can take, so it is EXCLUDED rather than ranked low. Both carry a
//      deliberate stretch band first (people do go slightly over), at half
//      credit, so a trip inside the ceiling always beats one just outside it.
//    - Stated interests exclude on ZERO overlap. Matching where somebody wants
//      to go while matching nothing they want to do is the plainest form of an
//      irrelevant suggestion. See scoreInterests for the case that proved it.
//
// AND THE CONSEQUENCE, STATED UP FRONT: a request whose preferences nothing
// matches returns ZERO suggestions. That is the story's "irrelevant
// suggestions" failure path handled at the only place it can be - the ranking -
// and it is why RELEVANCE_FLOOR exists. Padding the list with the least-bad
// safari would make the empty case invisible and teach a customer that our
// suggestions mean nothing. The empty list is handed to the service above,
// which turns it into an advisor flag (REQ-005).
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? Two distinct outcomes, never confused. A
//     preferences object we cannot interpret THROWS InvalidPreferencesError -
//     it is a caller bug and must not be mistaken for "this customer told us
//     nothing", which is a legitimate request with its own criterion. A
//     well-formed request that matches nothing returns an empty list, which is
//     an answer, not an error.
//  2. Will it retry? Not here - this function is pure and synchronous, so a
//     retry would recompute the same answer. The retry envelope lives at the
//     call site precisely because a future engine may be remote.
//  3. Recovery path? Empty suggestions are recovered by a human: the service
//     queues the request for a travel advisor. There is no automatic second
//     attempt with loosened preferences, on purpose - quietly ignoring a
//     customer's stated budget to fill the list is worse than saying nothing.
//  4. Handled here: missing, partial, unknown-field and out-of-range
//     preferences; an empty corpus; corpus entries with missing fields; ties.
//     NOT handled: free-text wishes (advisor/requestTriageService.js owns
//     unstructured requests), dates and seasonality (no date model exists),
//     party size (it does not change which trips are suitable, only the price,
//     which quotes/ owns), and any notion of a customer's history.

const { INTERESTS } = require("./tripCorpus");
const { MAX_TOTAL_CENTS } = require("../quotes/quotePricing");

// Weights for the four signals. They sum to 1 for readability, but what matters
// is their ratio: the denominator is always the weight of the dimensions the
// customer actually stated (see idea 1 above).
const WEIGHTS = Object.freeze({
  countries: 0.35,
  interests: 0.3,
  budget: 0.2,
  duration: 0.15,
});

// How far past a stated ceiling we will still show something, and at half
// credit. 15% and 2 days are judgement calls, written here as named constants
// so they can be argued with in one place rather than rediscovered in a
// conditional.
const BUDGET_STRETCH = 0.15;
const DURATION_STRETCH_DAYS = 2;
const STRETCH_CREDIT = 0.5;

// A trip must satisfy at least half of what was asked to be worth showing.
// Below this it is dropped - see the header.
const RELEVANCE_FLOOR = 0.5;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// Bounds on what a preferences object may say. Generous, but finite: they exist
// so a malformed or hostile body is refused at a known size rather than sorted.
const MAX_COUNTRIES = 10;
const MAX_COUNTRY_LENGTH = 60;
const MAX_DURATION_DAYS = 60;

const PREFERENCE_FIELDS = Object.freeze([
  "countries",
  "interests",
  "maxBudgetPerPersonCents",
  "maxDurationDays",
]);

class InvalidPreferencesError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPreferencesError";
    this.errorClass = "ValidationError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Describes the SHAPE of bad input, never echoes its value. These strings reach
// an HTTP response and a log line, and the input is untrusted.
function describeValue(value) {
  if (Array.isArray(value)) {
    return "an array of " + value.length;
  }
  if (value === null) {
    return "null";
  }
  return "type " + typeof value;
}

// Returns a list of problems - empty means usable. Exported because the service
// validates BEFORE calling the engine, so a bad request becomes a 400 with a
// readable list rather than a thrown error the retry envelope has to classify.
//
// null/undefined is NOT a problem: "I have no preferences" is a real request
// with its own acceptance criterion. A string, a number or an array in that
// position IS a problem - that is a caller bug, and letting it fall through to
// the popular-trips path would hide it behind a plausible-looking answer.
function validatePreferences(preferences) {
  if (preferences === null || preferences === undefined) {
    return [];
  }
  if (!isPlainObject(preferences)) {
    return ["preferences must be an object when present; received " + describeValue(preferences)];
  }

  const problems = [];

  Object.keys(preferences).forEach(function (field) {
    if (!PREFERENCE_FIELDS.includes(field)) {
      problems.push(
        "preferences: unknown field " + JSON.stringify(field) + "; expected any of " +
          PREFERENCE_FIELDS.join(", ")
      );
    }
  });

  const countries = preferences.countries;
  if (countries !== undefined && countries !== null) {
    if (!Array.isArray(countries) || countries.length === 0) {
      problems.push("preferences: countries must be a non-empty array; received " + describeValue(countries));
    } else if (countries.length > MAX_COUNTRIES) {
      problems.push("preferences: countries must name at most " + MAX_COUNTRIES + " countries");
    } else if (!countries.every(isNonBlankString)) {
      problems.push("preferences: countries must all be non-empty strings");
    } else if (!countries.every(function (c) { return c.length <= MAX_COUNTRY_LENGTH; })) {
      problems.push("preferences: a country name must be at most " + MAX_COUNTRY_LENGTH + " characters");
    }
  }

  const interests = preferences.interests;
  if (interests !== undefined && interests !== null) {
    if (!Array.isArray(interests) || interests.length === 0) {
      problems.push("preferences: interests must be a non-empty array; received " + describeValue(interests));
    } else {
      // Refused, not ignored. An interest we do not know is a client sending a
      // vocabulary we do not share, and silently dropping it would return
      // confident suggestions that answer a different question.
      const unknown = interests.filter(function (interest) {
        return !INTERESTS.includes(interest);
      });
      if (unknown.length > 0) {
        problems.push(
          "preferences: " + unknown.length + " unknown interest(s); expected any of " + INTERESTS.join(", ")
        );
      }
    }
  }

  const budget = preferences.maxBudgetPerPersonCents;
  if (budget !== undefined && budget !== null) {
    if (!Number.isInteger(budget) || budget <= 0 || budget > MAX_TOTAL_CENTS) {
      problems.push(
        "preferences: maxBudgetPerPersonCents must be a whole number of cents between 1 and " +
          MAX_TOTAL_CENTS + "; received " + describeValue(budget)
      );
    }
  }

  const duration = preferences.maxDurationDays;
  if (duration !== undefined && duration !== null) {
    if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_DURATION_DAYS) {
      problems.push(
        "preferences: maxDurationDays must be a whole number of days between 1 and " +
          MAX_DURATION_DAYS + "; received " + describeValue(duration)
      );
    }
  }

  return problems;
}

// Which of the four dimensions this customer actually spoke to. An empty list
// here is what "no preferences" means, and it is checked rather than inferred
// from `preferences === undefined`: `{}`, `{ countries: null }` and a missing
// body are the same request and must take the same path.
function statedDimensions(preferences) {
  if (!isPlainObject(preferences)) {
    return [];
  }
  return [
    Array.isArray(preferences.countries) && preferences.countries.length > 0 ? "countries" : null,
    Array.isArray(preferences.interests) && preferences.interests.length > 0 ? "interests" : null,
    Number.isInteger(preferences.maxBudgetPerPersonCents) ? "budget" : null,
    Number.isInteger(preferences.maxDurationDays) ? "duration" : null,
  ].filter(Boolean);
}

function hasAnyPreference(preferences) {
  return statedDimensions(preferences).length > 0;
}

function sameCountry(left, right) {
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

function formatUsd(cents) {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

// Score one dimension. Each returns { credit, reason, excluded } where credit is
// 0..1 within that dimension, reason is the plain-English fact that earned it
// (null if it earned nothing), and excluded means "do not show this trip at
// all" - see idea 2 in the header.
function scoreCountries(trip, wanted) {
  const hit = wanted.some(function (country) {
    return sameCountry(country, trip.country);
  });
  return {
    credit: hit ? 1 : 0,
    reason: hit ? "in " + trip.country + ", which you asked for" : null,
    excluded: false,
  };
}

// Stated interests are a filter on ZERO overlap, and a score above that.
//
// WHY, AND THIS WAS FOUND BY A TEST RATHER THAN BY THINKING. Scoring alone let
// a customer asking for a BEACH trip in Botswana be shown a Botswana safari: it
// took the country credit, cleared the floor on that alone, and arrived looking
// like an answer. Matching where somebody wants to go while matching nothing
// they want to do is the plainest form of an irrelevant suggestion, which is a
// failure path this story names. So: a trip that hits none of the stated
// interests is not shown. One overlap out of three still is - partial interest
// is how people actually describe a holiday.
function scoreInterests(trip, wanted) {
  const matched = wanted.filter(function (interest) {
    return trip.interests.includes(interest);
  });
  if (matched.length === 0) {
    return { credit: 0, reason: null, excluded: true };
  }
  return {
    credit: matched.length / wanted.length,
    reason: "matches your interest in " + matched.join(" and "),
    excluded: false,
  };
}

function scoreBudget(trip, maxCents) {
  if (trip.pricePerPersonCents <= maxCents) {
    return {
      credit: 1,
      reason: formatUsd(trip.pricePerPersonCents) + " per person, within your budget",
      excluded: false,
    };
  }
  if (trip.pricePerPersonCents <= Math.round(maxCents * (1 + BUDGET_STRETCH))) {
    return {
      credit: STRETCH_CREDIT,
      // Says so out loud. A suggestion over a stated budget that does not
      // mention it reads as a suggestion inside it.
      reason: formatUsd(trip.pricePerPersonCents) + " per person, a little over your budget",
      excluded: false,
    };
  }
  return { credit: 0, reason: null, excluded: true };
}

function scoreDuration(trip, maxDays) {
  if (trip.durationDays <= maxDays) {
    return {
      credit: 1,
      reason: trip.durationDays + " days, within the " + maxDays + " you have",
      excluded: false,
    };
  }
  if (trip.durationDays <= maxDays + DURATION_STRETCH_DAYS) {
    return {
      credit: STRETCH_CREDIT,
      reason: trip.durationDays + " days, slightly longer than the " + maxDays + " you have",
      excluded: false,
    };
  }
  return { credit: 0, reason: null, excluded: true };
}

// Scores to 4 decimal places. Floating-point sums of weights produce values
// like 0.6499999999999999, which compare badly against RELEVANCE_FLOOR and read
// badly in an audit entry. Rounding once, here, means the number a test asserts
// is the number an advisor reads.
function round(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function scoreTrip(trip, preferences, dimensions) {
  const reasons = [];
  let earned = 0;
  let available = 0;

  const scorers = {
    countries: function () { return scoreCountries(trip, preferences.countries); },
    interests: function () { return scoreInterests(trip, preferences.interests); },
    budget: function () { return scoreBudget(trip, preferences.maxBudgetPerPersonCents); },
    duration: function () { return scoreDuration(trip, preferences.maxDurationDays); },
  };

  for (let i = 0; i < dimensions.length; i += 1) {
    const dimension = dimensions[i];
    const weight = WEIGHTS[dimension];
    const outcome = scorers[dimension]();
    if (outcome.excluded) {
      return null;
    }
    available += weight;
    earned += weight * outcome.credit;
    if (outcome.reason) {
      reasons.push(outcome.reason);
    }
  }

  // available is never 0 here: dimensions is non-empty by the time we score.
  return { score: round(earned / available, 4), reasons: reasons };
}

// What a caller sees. The corpus entry's own fields are passed through as they
// are, so a suggestion can be matched back to a product without a second read.
function buildSuggestion(trip, score, reasons) {
  return Object.freeze({
    tripId: trip.tripId,
    name: trip.name,
    country: trip.country,
    durationDays: trip.durationDays,
    currency: trip.currency,
    pricePerPersonCents: trip.pricePerPersonCents,
    source: trip.source,
    score: score,
    reasons: Object.freeze(reasons),
  });
}

// Highest score first; then the editorial popularity order; then tripId. The
// second and third keys are what make the output an exact list rather than a
// set, which is the difference between a test that catches a ranking regression
// and one that cannot.
function byScoreThenPopularity(left, right) {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.popularityRank !== right.popularityRank) {
    return left.popularityRank - right.popularityRank;
  }
  return left.tripId < right.tripId ? -1 : left.tripId > right.tripId ? 1 : 0;
}

function resolveLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(limit, MAX_LIMIT);
}

// THE PORT. One argument in, one plain object out:
//
//   { strategy, suggestions, confidence, confidenceBasis }
//
//   strategy          "matched" when preferences were stated, "popular" when
//                     they were not. The caller audits this, so "why did I get
//                     these?" is answerable from the log alone.
//   confidence        0..1, the top suggestion's score, or 0 when nothing
//                     cleared the floor.
//   confidenceBasis   "preference_match" or "none_stated". NULL confidence is
//                     avoided; the basis is how a caller knows whether the
//                     number means anything. A customer who stated nothing
//                     cannot have been misunderstood, so the service must not
//                     treat their 0 as a reason to trouble an advisor.
function suggestTrips({ preferences, trips, limit } = {}) {
  const problems = validatePreferences(preferences);
  if (problems.length > 0) {
    // Thrown, not returned. callWithRetry does not retry a throw (only a
    // timeout), which is right: a malformed request does not fix itself.
    throw new InvalidPreferencesError(problems.join("; "));
  }
  if (!Array.isArray(trips)) {
    throw new InvalidPreferencesError("trips must be an array; received " + describeValue(trips));
  }

  const count = resolveLimit(limit);
  const dimensions = statedDimensions(preferences);

  // CRITERION 2: nothing stated, so the answer is the popular trips, in the
  // corpus's own order. No scoring happens - there is nothing to score against,
  // and inventing a score here would put a meaningless number in the audit log.
  if (dimensions.length === 0) {
    return Object.freeze({
      strategy: "popular",
      confidence: 0,
      confidenceBasis: "none_stated",
      suggestions: Object.freeze(
        trips.slice(0, count).map(function (trip) {
          return buildSuggestion(trip, 0, ["one of our most-booked trips"]);
        })
      ),
    });
  }

  // CRITERION 1: score, drop anything under the floor, rank, cut to size.
  const scored = [];
  trips.forEach(function (trip) {
    const outcome = scoreTrip(trip, preferences, dimensions);
    if (outcome === null || outcome.score < RELEVANCE_FLOOR) {
      return;
    }
    scored.push({
      trip: trip,
      score: outcome.score,
      reasons: outcome.reasons,
      popularityRank: trip.popularityRank,
      tripId: trip.tripId,
    });
  });

  scored.sort(byScoreThenPopularity);
  const top = scored.slice(0, count);

  return Object.freeze({
    strategy: "matched",
    confidence: top.length > 0 ? top[0].score : 0,
    confidenceBasis: "preference_match",
    suggestions: Object.freeze(
      top.map(function (entry) {
        return buildSuggestion(entry.trip, entry.score, entry.reasons);
      })
    ),
  });
}

module.exports = {
  suggestTrips,
  validatePreferences,
  hasAnyPreference,
  statedDimensions,
  InvalidPreferencesError,
  WEIGHTS,
  RELEVANCE_FLOOR,
  BUDGET_STRETCH,
  DURATION_STRETCH_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_DURATION_DAYS,
  PREFERENCE_FIELDS,
};
