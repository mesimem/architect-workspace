// STORY-008: is this group booking request complete enough to act on?
//
// PURE. No I/O, no clock, no state, no store. It takes a submitted request and
// returns either a normalized group or the full list of what is missing. That
// makes the acceptance criterion - "given a group booking is incomplete, when
// submitted, then the system prompts for missing information" - testable
// exhaustively without a payment processor, a store or a booking anywhere near
// it.
//
// WHY THIS IS NOT INSIDE groupBookingService.js. The same seam quotePricing.js
// sits on next door: the service owns the SEQUENCE (validate, price, charge,
// confirm, log) and this file owns the JUDGEMENT of one request. They change
// for different reasons - a new member field lands here, a new step in the
// booking flow lands there - and separating them means the twenty-odd validity
// cases below are tested against a function that cannot charge anyone.
//
// EVERY PROBLEM AT ONCE, NEVER THE FIRST ONE. A group organizer filling in
// eight travellers should be told about all four they got wrong in one pass.
// Returning the first problem turns one bad form into four round trips, and
// the fourth is where people give up. Same rule as leadStore.js and
// quotePricing.js.
//
// PROBLEMS NAME POSITIONS, NEVER VALUES. A message says "members[2]: fullName
// is required", not "member 'Robert'); DROP TABLE--' is invalid". The index is
// OUR number and is safe to echo; the submitted value came from outside the
// trust boundary and may end up in a log, an email or an advisor's screen. The
// same rule is enforced by the regression test in leadStore.test.js that
// asserts a rejected value never reaches the audit trail.
//
// A GROUP IS TWO OR MORE PEOPLE. One traveller is not a group, it is a trip,
// and bookTripService.js already books those. Accepting a group of one would
// give the system two different code paths to the same outcome, priced and
// logged differently, and nothing to say which one is correct.
//
// AND AT MOST MAX_GROUP_SIZE. The member list drives both a payment amount and
// a write per member, so an unbounded array is an unbounded charge and an
// unbounded write. 25 is a judgement call - a plausible ceiling for a tour
// group - not a discovered constant. It is here so that the limit is one named
// number in one place rather than whatever the first caller happens to send.
//
// FAILURE-FIRST (CLAUDE.md requires these four answers in writing):
//  1. What happens if this fails? It cannot fail in the sense of throwing. A
//     bad request is a RETURN VALUE - { ok: false, missing: [...] } - because
//     an incomplete form is an ordinary thing a user does, not an exception.
//     Non-objects, nulls and arrays where objects belong are all handled as
//     missing information rather than crashing on a property read.
//  2. Will it retry? Nothing to retry. Pure function, same answer every time.
//  3. Recovery path? The caller shows `missing` to the organizer and they
//     resubmit. That is the whole recovery, and it is why the list is complete.
//  4. Handled here: missing or blank ids, a missing itinerary, an itinerary
//     that is not an object, a members list that is absent/empty/not an array/
//     too small/too large, members that are not objects, blank member fields,
//     duplicate members, over-long strings, and prototype-chain keys. NOT
//     handled: whether the itinerary legs actually EXIST (that is availability,
//     which needs the inventory and belongs to the service), whether the
//     organizer is a real account (identity belongs to portalCredentials.js),
//     passport or visa details (no such model exists yet), and per-member
//     itinerary variations - this story ships a SHARED itinerary, which is what
//     REQ-010 asks for.

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 200;

// See the header for why these two bounds exist and why they are judgement
// calls rather than discovered constants.
const MIN_GROUP_SIZE = 2;
const MAX_GROUP_SIZE = 25;

// The three legs a trip is made of, shared by every member of the group. Named
// once here so the validator and its messages cannot fall out of step with each
// other; the same three names are what bookTripService.js prices.
const ITINERARY_LEGS = Object.freeze(["flightId", "hotelId", "safariId"]);

function isUsableId(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_ID_LENGTH;
}

function isUsableName(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME_LENGTH;
}

// "ABSENT" AND "TOO LONG" ARE DIFFERENT PROMPTS, and conflating them is a real
// defect against this story's criterion. Telling someone who typed a 700-
// character name that the field "is required" sends them looking for an empty
// box that is not there. The prompt has to name what is actually wrong.
//
// Note what this does NOT do: truncate. An over-long name is refused rather
// than silently cut to fit, because a shortened name on an airline ticket is
// a name that does not match the passport at the gate. Length-capping is fine
// for a note and wrong for a person.
function lengthProblem(value, label, maxLength) {
  return typeof value === "string" && value.trim() !== "" && value.length > maxLength
    ? label + " is longer than " + maxLength + " characters."
    : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// hasOwnProperty, not `in`. A submitted member of { "constructor": ... } arrives
// from the internet more often than anyone expects, and reading it off the
// prototype chain yields a function where a string should be - which then
// passes a truthiness check and fails much later, somewhere less obvious.
function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function trimTo(value, maxLength) {
  return value.trim().slice(0, maxLength);
}

// The shared itinerary. One object for the whole group - not a copy per member
// - because REQ-010 asks for "shared itinerary information" and two copies of
// an itinerary is two itineraries the day one of them is edited.
function checkItinerary(itinerary, missing) {
  if (!isPlainObject(itinerary)) {
    missing.push("itinerary is required: the flight, hotel and safari the group shares.");
    return null;
  }

  const legs = {};
  ITINERARY_LEGS.forEach(function (leg) {
    const value = own(itinerary, leg);
    if (!isUsableId(value)) {
      missing.push(
        lengthProblem(value, "itinerary." + leg, MAX_ID_LENGTH) || "itinerary." + leg + " is required."
      );
      return;
    }
    legs[leg] = trimTo(value, MAX_ID_LENGTH);
  });

  return Object.keys(legs).length === ITINERARY_LEGS.length ? Object.freeze(legs) : null;
}

// One member. Reported by POSITION - see the header on why the submitted value
// never appears in a message.
function checkMember(member, index, seenIds, missing) {
  const where = "members[" + index + "]";

  if (!isPlainObject(member)) {
    missing.push(where + " must be an object with a memberId and a fullName.");
    return null;
  }

  const memberId = own(member, "memberId");
  const fullName = own(member, "fullName");
  let usable = true;

  if (!isUsableId(memberId)) {
    missing.push(
      lengthProblem(memberId, where + ".memberId", MAX_ID_LENGTH) || where + ".memberId is required."
    );
    usable = false;
  } else if (seenIds.has(memberId.trim())) {
    // Two rows for one person is not a bigger group, it is a double charge and
    // two seats booked for someone who can only sit in one. Caught here rather
    // than deduped silently: silently dropping a row would confirm a group of
    // seven when the organizer asked for eight and told them nothing.
    missing.push(where + ".memberId duplicates an earlier member - each traveller appears once.");
    usable = false;
  } else {
    // Recorded AS SOON AS THE ID ITSELF IS USABLE, and deliberately not at the
    // end once the whole member has passed. An earlier member who is rejected
    // for some OTHER reason - a blank name, say - still occupies their id, and
    // skipping the record here would hide a later duplicate until the organizer
    // had fixed the name and resubmitted. That is the second round trip this
    // file exists to avoid, and the smoke test that found it is now the
    // "reports a duplicate even when the first member is otherwise broken" case
    // in groupValidation.test.js.
    seenIds.add(memberId.trim());
  }

  if (!isUsableName(fullName)) {
    // An airline ticket needs a name on it. A group booking with a blank
    // traveller is not a booking anyone can actually fly on - and one with a
    // 700-character name is a broken client that must be told so specifically.
    missing.push(
      lengthProblem(fullName, where + ".fullName", MAX_NAME_LENGTH) ||
        where + ".fullName is required - a ticket needs a name."
    );
    usable = false;
  }

  if (!usable) {
    return null;
  }

  // The id is already in `seenIds` - recorded above, at the point it was known
  // to be usable rather than here.
  return Object.freeze({
    memberId: trimTo(memberId, MAX_ID_LENGTH),
    fullName: trimTo(fullName, MAX_NAME_LENGTH),
  });
}

function checkMembers(members, missing) {
  if (!Array.isArray(members)) {
    missing.push("members is required: the list of travellers on this group booking.");
    return null;
  }
  if (members.length < MIN_GROUP_SIZE) {
    // Stated as a rule rather than a bare count, because "at least 2" reads
    // like an arbitrary limit until you know a single traveller has its own
    // booking path.
    missing.push(
      "members must list at least " +
        MIN_GROUP_SIZE +
        " travellers - a single traveller is booked as an ordinary trip."
    );
    return null;
  }
  if (members.length > MAX_GROUP_SIZE) {
    missing.push(
      "members lists " +
        members.length +
        " travellers; the maximum for one group booking is " +
        MAX_GROUP_SIZE +
        "."
    );
    return null;
  }

  const seenIds = new Set();
  const checked = members.map(function (member, index) {
    return checkMember(member, index, seenIds, missing);
  });

  // All or nothing: one unusable member means the whole group is incomplete.
  // Returning the good ones would invite a caller to book the subset, and
  // "confirms the booking for all members" is the criterion.
  return checked.every(Boolean) ? Object.freeze(checked) : null;
}

// Returns { ok: true, group } or { ok: false, missing }.
//
// `group` is NORMALIZED - trimmed, length-capped and frozen - so the service
// downstream works from checked values rather than re-deriving them from the
// raw submission. A validator that hands back the original object invites the
// caller to use the unchecked one by mistake.
function validateGroupRequest({ organizerId, groupName, itinerary, members } = {}) {
  const missing = [];

  if (!isUsableId(organizerId)) {
    missing.push(
      lengthProblem(organizerId, "organizerId", MAX_ID_LENGTH) ||
        "organizerId is required - a group booking records who arranged it."
    );
  }

  const legs = checkItinerary(itinerary, missing);
  const travellers = checkMembers(members, missing);

  if (missing.length > 0) {
    return { ok: false, missing: missing };
  }

  return {
    ok: true,
    group: Object.freeze({
      organizerId: trimTo(organizerId, MAX_ID_LENGTH),
      // Optional: a group is identifiable by its id and its members. A label
      // is a convenience for the advisor's screen, so its absence is null
      // rather than a problem to report.
      groupName: isUsableName(groupName) ? trimTo(groupName, MAX_NAME_LENGTH) : null,
      itinerary: legs,
      members: travellers,
    }),
  };
}

module.exports = {
  validateGroupRequest,
  ITINERARY_LEGS,
  MIN_GROUP_SIZE,
  MAX_GROUP_SIZE,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
};
