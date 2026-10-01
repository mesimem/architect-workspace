// STORY-017: what makes a combined package well-formed, and what makes two
// travel products incompatible. Pure - no I/O, no clock, no store.
//
// WHAT THIS MODULE IS RESPONSIBLE FOR, AND WHAT IT IS NOT. It answers one
// question: "is this package a thing we could sell?" It does NOT write a
// package down, does NOT audit, does NOT price one, and does NOT decide who may
// create one. Those are packageStore.js, the audit log, a later pricing step,
// and the central permission gate respectively. Keeping the rules pure is what
// lets every incompatibility below be tested in isolation, with a fake product
// book and no setup - see packageCompatibility.test.js, which never touches the
// real store.
//
// WHY THE PRODUCT BOOK ARRIVES AS AN ARGUMENT. `resolveProduct` is injected
// rather than required at the top of this file. Two reasons, and the second is
// the real one: a `require` of safariProductStore here would make every test of
// a currency rule depend on seeding the catalog first, and it would couple the
// rules to the ONE product kind that exists today. When a flight or lodging
// module lands, the caller passes a resolver that knows about it; this file
// learns a new entry in COMPONENT_KINDS and nothing else.
//
// THE FOUR INCOMPATIBILITIES, AND WHY EACH IS ONE (docs/stories/STORY-017.md
// carries the same list - this is the implementation of that definition):
//   currency mismatch  - two components priced in different currencies. The
//                        system has a single-currency invariant already
//                        (quotes/quotePricing.js CURRENCIES); a "total" summed
//                        across USD and EUR is not money.
//   duplicate product  - the same productId twice. Selling a customer the same
//                        safari twice is a copy-paste, not an offering.
//   overlapping days   - two day spans that collide. A customer cannot be in
//                        the Masai Mara and the Serengeti on the same day.
//   cross-country      - two day-ADJACENT components in different countries
//   without a gap        with no free day between them. Ending in Kenya on day
//                        6 and starting in Tanzania on day 7 is not an
//                        itinerary anyone can fly.
//
// WHAT IS DELIBERATELY NOT AN INCOMPATIBILITY. A GAP between components - day 4
// ends, day 8 begins - is allowed. Four days at leisure between two safaris is
// a real itinerary that advisors sell, and refusing it would make this module
// wrong in a way the advisor cannot work around. "Suspicious" is not the same
// as "impossible", and only the second belongs in a validator.
//
// WHY startDay EXISTS AT ALL. Without it a package is an unordered bag of
// product ids, and two of the four rules above cannot even be expressed -
// "incompatible" would collapse to "different currency", which is not what an
// advisor means by the word.
//
// EVERY PROBLEM IS REPORTED, NOT THE FIRST. Same rule as
// safariProductValidation.js: an advisor fixing a package form should see every
// fault in one pass, not discover a second one after correcting the first.
//
// WHAT THE PROBLEM STRINGS MAY CONTAIN. Indexes, day numbers, currency codes
// and country names - all of which are either ours or structural. Never the
// caller's strings: see describeValue, and the same rule in quotePricing.js. A
// problem list ends up in an HTTP response and in a log line.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It returns a list of problems. It does not
//     throw and does not mutate its inputs. An empty list means "sellable".
//  2. Will it retry? Nothing to retry. Pure function, no I/O, no clock - the
//     same inputs always give the same answer.
//  3. Recovery path? The caller gets every problem at once and corrects the
//     submission. A resolver that throws is the CALLER's bug, not handled here;
//     packageStore passes a resolver that cannot throw.
//  4. Handled: non-object packages and components, prototype-chain keys, unknown
//     fields, unknown component kinds, unknown product ids, too few and too many
//     components, non-integer and out-of-range startDays, products whose own
//     durationDays is unusable, and all four incompatibilities. NOT handled:
//     calendar dates (a package is expressed in trip-relative day numbers, not
//     departure dates - a departure calendar is a booking concern and STORY-018
//     owns bookings), seasonal availability, and supplier capacity.

// Deliberately requires NOTHING. This module is pure rules, and the one import
// it might plausibly have had - CURRENCIES from quotes/quotePricing.js - is
// explained away in currencyProblems below: comparing components against each
// other outlives a constant that happens to hold one entry today.

// The component kinds this system can combine. ONE entry today, and the list
// exists anyway - see the header. A kind outside this list is refused by name
// rather than ignored, so a typo ("safaris") is a visible error instead of a
// component silently dropped from a package an advisor believes they built.
const COMPONENT_KINDS = Object.freeze(["safari"]);

// What a component may carry. An allow-list: unknown keys are reported by name,
// for the same reason DAY_FIELDS is one in safariProductValidation.js.
const COMPONENT_FIELDS = Object.freeze(["kind", "productId", "startDay"]);

// A "package" of one is just a product, and the requirement is about COMBINING
// products - so one component is refused rather than quietly accepted as a
// degenerate package that duplicates the product book.
const MIN_COMPONENTS = 2;

// More than a dozen products in one offering is a season's programme, not a
// package a customer buys. It also bounds the pairwise checks below, which are
// O(n^2) by nature: at 12 components that is 66 comparisons, which is free.
const MAX_COMPONENTS = 12;

// The longest trip a package may span, end to end. Same spirit as
// MAX_DURATION_DAYS in safariProductValidation.js: a package running longer
// than this is a units slip (someone typed a date where a day number goes), not
// a trip. Two of the longest products the book allows, back to back, fit.
const MAX_PACKAGE_DAYS = 120;

const MAX_NAME_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 2000;

// Describes the SHAPE of a bad value, never the value itself - see the header.
function describeValue(value) {
  if (typeof value === "string") {
    return "a string of length " + value.length;
  }
  if (Array.isArray(value)) {
    return "an array of length " + value.length;
  }
  if (value === null) {
    return "null";
  }
  return "type " + typeof value;
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// hasOwnProperty, not `key in object`: a body of { "constructor": ... } arrives
// from a request more often than anyone expects, and `in` says yes to it.
function ownKeys(object) {
  return Object.keys(object).filter(function (key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  });
}

function unknownFieldProblems(object, allowed, at) {
  const unknown = ownKeys(object).filter(function (key) {
    return !allowed.includes(key);
  });
  return unknown.length === 0 ? [] : [at + "unknown fields: " + unknown.sort().join(", ")];
}

// Validates ONE component's own shape, in isolation. Says nothing about how it
// sits against the others - that is what the four rules below are for.
function validateComponent(component, index) {
  const at = "components[" + index + "]: ";

  if (!isPlainObject(component)) {
    return [at + "must be an object; received " + describeValue(component)];
  }

  const problems = unknownFieldProblems(component, COMPONENT_FIELDS, at);

  if (!COMPONENT_KINDS.includes(component.kind)) {
    problems.push(
      at + "kind must be one of " + COMPONENT_KINDS.join(", ") + "; received " + describeValue(component.kind)
    );
  }

  if (!isNonBlankString(component.productId)) {
    problems.push(at + "productId must be a non-empty string");
  }

  if (
    !Number.isInteger(component.startDay) ||
    component.startDay < 1 ||
    component.startDay > MAX_PACKAGE_DAYS
  ) {
    problems.push(
      at +
        "startDay must be a whole number from 1 to " +
        MAX_PACKAGE_DAYS +
        "; received " +
        describeValue(component.startDay)
    );
  }

  return problems;
}

// Turns the components that passed their own validation into day spans, by
// looking each product up. Returns { spans, problems }: a component whose
// product cannot be resolved, or whose stored duration is unusable, produces a
// problem and NO span - the rules below then simply do not see it, rather than
// comparing against a NaN and reporting nonsense.
//
// The productId is NOT echoed back in the unresolved message. It came from the
// caller, the message ends up in an HTTP response, and the index already says
// exactly which row to fix.
function resolveSpans(components, resolveProduct) {
  const problems = [];
  const spans = [];

  components.forEach(function (entry) {
    const at = "components[" + entry.index + "]: ";
    const product = resolveProduct(entry.component.productId);

    if (!product) {
      problems.push(at + "no " + entry.component.kind + " product exists with that productId");
      return;
    }

    // A stored product with a broken duration cannot be placed on a calendar.
    // This is OUR data being wrong rather than the caller's, so it is reported
    // plainly and the component is dropped from the span checks.
    if (!Number.isInteger(product.durationDays) || product.durationDays < 1) {
      problems.push(at + "the referenced product has no usable duration and cannot be scheduled");
      return;
    }

    spans.push({
      index: entry.index,
      productId: entry.component.productId,
      startDay: entry.component.startDay,
      // Inclusive. A 6-day product starting on day 1 occupies days 1 through 6,
      // so the next product may start on day 7 at the earliest - and days 1-6
      // against 6-11 IS an overlap, which an exclusive end would miss.
      endDay: entry.component.startDay + product.durationDays - 1,
      country: typeof product.country === "string" ? product.country : "",
      currency: product && product.pricing ? product.pricing.currency : undefined,
    });
  });

  return { spans: spans, problems: problems };
}

// A currency code is rendered back to the caller ONLY when it looks like one.
// The value comes from a stored product rather than from this request, but it
// is still data we did not write, and it ends up in an HTTP response.
function describeCurrency(currency) {
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "an unrecognised currency";
}

// RULE 1 - currency mismatch.
//
// HONESTLY: this rule CANNOT FIRE against today's catalog, and it is here
// anyway. CURRENCIES holds one entry ("USD") and safariProductValidation.js
// refuses any product priced in anything else, so every safari product in the
// book agrees by construction. The rule is written against the component's own
// currency rather than against CURRENCIES for exactly that reason - the day a
// flight component arrives priced in KES, or the day CURRENCIES gains a second
// entry, this fires without anyone remembering it needed to. A check that only
// works while the system has one currency is a check that quietly stops
// protecting anything the moment it matters.
//
// It is tested with a fake product book, which is why the resolver is injected.
function currencyProblems(spans) {
  const problems = [];

  spans.forEach(function (span) {
    if (typeof span.currency !== "string" || span.currency.trim() === "") {
      problems.push(
        "components[" + span.index + "]: the referenced product has no usable currency and cannot be packaged"
      );
    }
  });

  const currencies = Array.from(
    new Set(
      spans
        .map(function (span) {
          return span.currency;
        })
        .filter(function (currency) {
          return typeof currency === "string" && currency.trim() !== "";
        })
    )
  ).sort();

  if (currencies.length > 1) {
    problems.push(
      "components are priced in more than one currency (" +
        currencies.map(describeCurrency).join(", ") +
        "); a package must be priced in one"
    );
  }

  return problems;
}

// RULE 2 - the same product listed twice.
function duplicateProblems(spans) {
  const indexesByProduct = new Map();
  spans.forEach(function (span) {
    const seen = indexesByProduct.get(span.productId) || [];
    seen.push(span.index);
    indexesByProduct.set(span.productId, seen);
  });

  return Array.from(indexesByProduct.values())
    .filter(function (indexes) {
      return indexes.length > 1;
    })
    .map(function (indexes) {
      return "the same product is listed more than once (components " + indexes.join(", ") + ")";
    });
}

// Sorted by start day, with the original index breaking a tie so the output is
// deterministic for two components that start on the same day.
function byStartDay(spans) {
  return spans.slice().sort(function (a, b) {
    return a.startDay !== b.startDay ? a.startDay - b.startDay : a.index - b.index;
  });
}

function describeSpan(span) {
  return "components[" + span.index + "] (days " + span.startDay + "-" + span.endDay + ")";
}

// RULE 3 - two components occupying the same day. Every colliding PAIR is
// reported, not just the first: three products all stacked on day 1 is three
// separate mistakes to an advisor reading the list, and reporting one would
// have them fix it and resubmit twice more.
function overlapProblems(spans) {
  const ordered = byStartDay(spans);
  const problems = [];

  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      // Ordered by start day, so ordered[j] starts no earlier than ordered[i].
      // They collide exactly when j starts on or before i ends.
      if (ordered[j].startDay <= ordered[i].endDay) {
        problems.push(describeSpan(ordered[i]) + " and " + describeSpan(ordered[j]) + " overlap");
      }
    }
  }

  return problems;
}

// RULE 4 - different countries with no travel day between them.
//
// Only checked for components that are day-ADJACENT (the next starts the day
// after this one ends). An overlap is already reported by rule 3 and reporting
// it again here as a country fault would send the advisor chasing the wrong
// problem; a gap of one day or more is legal and is the fix for this very
// refusal.
function crossCountryProblems(spans) {
  const ordered = byStartDay(spans);
  const problems = [];

  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const current = ordered[i];
    const next = ordered[i + 1];

    if (next.startDay !== current.endDay + 1) {
      continue;
    }
    if (current.country === "" || next.country === "" || current.country === next.country) {
      continue;
    }

    problems.push(
      "components[" +
        current.index +
        "] ends in " +
        current.country +
        " on day " +
        current.endDay +
        " and components[" +
        next.index +
        "] starts in " +
        next.country +
        " on day " +
        next.startDay +
        "; cross-country components need a travel day between them"
    );
  }

  return problems;
}

// The package must fit inside the calendar its own startDays are bounded by.
// Checked on the resolved spans rather than the submitted startDays, because it
// is the END of the last product that runs off the end, and that is only known
// after the lookup.
function spanLengthProblems(spans) {
  const over = spans.filter(function (span) {
    return span.endDay > MAX_PACKAGE_DAYS;
  });
  if (over.length === 0) {
    return [];
  }
  return [
    "the package runs past day " +
      MAX_PACKAGE_DAYS +
      " (" +
      over
        .map(describeSpan)
        .sort()
        .join(", ") +
      ")",
  ];
}

// THE ENTRY POINT. Returns [] when the package is sellable, or every problem
// found. `resolveProduct` takes a productId and returns the stored product or
// null; it must not throw.
//
// The two phases are deliberately NOT interleaved. Envelope faults are reported
// alone, and the compatibility rules run only on components that passed - a
// component with a startDay of "tomorrow" has no span, and comparing it against
// the others would produce a page of nonsense underneath the one real error.
function validatePackage(candidate, resolveProduct) {
  if (!isPlainObject(candidate)) {
    return ["package must be an object; received " + describeValue(candidate)];
  }
  if (typeof resolveProduct !== "function") {
    // A programming error at the call site, not a bad submission. Reported as a
    // problem rather than thrown so this function keeps its one contract: it
    // returns a list and never throws.
    return ["no product resolver was supplied; the package could not be checked"];
  }

  const problems = [];

  if (!isNonBlankString(candidate.name)) {
    problems.push("name must be a non-empty string");
  } else if (candidate.name.trim().length > MAX_NAME_LENGTH) {
    problems.push("name must be at most " + MAX_NAME_LENGTH + " characters");
  }

  if (!isNonBlankString(candidate.summary)) {
    problems.push("summary must be a non-empty string");
  } else if (candidate.summary.trim().length > MAX_SUMMARY_LENGTH) {
    problems.push("summary must be at most " + MAX_SUMMARY_LENGTH + " characters");
  }

  if (!Array.isArray(candidate.components)) {
    problems.push("components must be an array; received " + describeValue(candidate.components));
    return problems;
  }
  if (candidate.components.length < MIN_COMPONENTS) {
    problems.push(
      "a package must combine at least " + MIN_COMPONENTS + " products; received " + candidate.components.length
    );
  }
  if (candidate.components.length > MAX_COMPONENTS) {
    problems.push(
      "a package may combine at most " + MAX_COMPONENTS + " products; received " + candidate.components.length
    );
    // Returned early: the pairwise rules below are O(n^2) and there is no value
    // in checking the compatibility of a package that is refused on size.
    return problems;
  }

  const wellFormed = [];
  candidate.components.forEach(function (component, index) {
    const componentProblems = validateComponent(component, index);
    if (componentProblems.length > 0) {
      problems.push.apply(problems, componentProblems);
      return;
    }
    wellFormed.push({ index: index, component: component });
  });

  const resolved = resolveSpans(wellFormed, resolveProduct);
  problems.push.apply(problems, resolved.problems);

  const spans = resolved.spans;
  problems.push.apply(problems, spanLengthProblems(spans));
  problems.push.apply(problems, currencyProblems(spans));
  problems.push.apply(problems, duplicateProblems(spans));
  problems.push.apply(problems, overlapProblems(spans));
  problems.push.apply(problems, crossCountryProblems(spans));

  return problems;
}

// The stored form of the components. Sorted by start day so two packages built
// from the same products in a different submission ORDER are the same package -
// which is what makes the store's "did anything actually change?" comparison
// honest. Frozen, because a caller handed a package must not be able to edit
// the book through it.
//
// Only call this on components that have PASSED validatePackage: it assumes the
// shape is good, the same way normaliseItinerary does in
// safariProductValidation.js.
function normaliseComponents(components) {
  return Object.freeze(
    components
      .map(function (component) {
        return Object.freeze({
          kind: component.kind,
          productId: component.productId.trim(),
          startDay: component.startDay,
        });
      })
      .sort(function (a, b) {
        return a.startDay !== b.startDay
          ? a.startDay - b.startDay
          : a.productId.localeCompare(b.productId);
      })
  );
}

module.exports = {
  validatePackage,
  validateComponent,
  normaliseComponents,
  COMPONENT_KINDS,
  COMPONENT_FIELDS,
  MIN_COMPONENTS,
  MAX_COMPONENTS,
  MAX_PACKAGE_DAYS,
  MAX_NAME_LENGTH,
  MAX_SUMMARY_LENGTH,
};
