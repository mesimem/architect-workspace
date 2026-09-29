// STORY-008, ACCEPTANCE CRITERION 2: "given a group booking is incomplete,
// when submitted, then the system prompts for missing information."
//
// The criterion is about the PROMPT, not just the refusal, so these tests
// assert on the CONTENT of `missing` rather than only on `ok === false`. A
// validator that rejects everything with an empty list passes "it refused" and
// fails the criterion: nobody can fix a form they are not told about.
//
// groupValidation is pure, so there is no store, no payment processor and no
// clock here. That is the whole reason it was split out of the service.

const assert = require("assert");
const {
  validateGroupRequest,
  MIN_GROUP_SIZE,
  MAX_GROUP_SIZE,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
} = require("./groupValidation");

// A complete request, used as the base every case below deviates from. Written
// once so a test that changes one field is visibly about that one field.
function completeRequest(overrides) {
  return Object.assign(
    {
      organizerId: "CUST-ORG",
      groupName: "Kenya 2026",
      itinerary: { flightId: "FL-100", hotelId: "HT-200", safariId: "SF-300" },
      members: [
        { memberId: "M-1", fullName: "Ada Lovelace" },
        { memberId: "M-2", fullName: "Grace Hopper" },
      ],
    },
    overrides || {}
  );
}

// Asserts the list CONTAINS a problem mentioning each needle. Substring rather
// than exact match on purpose: the wording of a prompt is allowed to improve
// without breaking a test, but the field it names is the contract.
function assertMentions(missing, needles) {
  needles.forEach(function (needle) {
    assert.ok(
      missing.some(function (problem) {
        return problem.includes(needle);
      }),
      "expected a problem mentioning " + JSON.stringify(needle) + "; got " + JSON.stringify(missing)
    );
  });
}

function main() {
  // ---------------------------------------------------------------- complete

  const valid = validateGroupRequest(completeRequest());
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.group.organizerId, "CUST-ORG");
  assert.strictEqual(valid.group.groupName, "Kenya 2026");
  assert.deepStrictEqual(valid.group.itinerary, {
    flightId: "FL-100",
    hotelId: "HT-200",
    safariId: "SF-300",
  });
  assert.strictEqual(valid.group.members.length, 2);
  assert.strictEqual(valid.group.members[0].memberId, "M-1");
  assert.strictEqual(valid.group.members[0].fullName, "Ada Lovelace");

  // FROZEN, so a caller cannot edit the checked group and hand the mutated
  // version to the service as if it had been validated.
  assert.throws(function () {
    "use strict";
    valid.group.members.push({ memberId: "M-3", fullName: "Sneaked In" });
  });

  console.log("groupValidation: a complete request is accepted and normalized");

  // An optional label is absent, not a problem. A group is identified by its
  // id and its members; the name is for the advisor's screen.
  const unnamed = validateGroupRequest(completeRequest({ groupName: undefined }));
  assert.strictEqual(unnamed.ok, true);
  assert.strictEqual(unnamed.group.groupName, null);

  console.log("groupValidation: groupName is optional and becomes null");

  // NORMALIZATION. Whitespace is trimmed, so the same group submitted by a
  // form that pads its inputs matches the one submitted by a form that does
  // not - which is what keeps the service's replay fingerprint stable.
  const padded = validateGroupRequest(
    completeRequest({
      organizerId: "  CUST-ORG  ",
      members: [
        { memberId: "  M-1  ", fullName: "  Ada Lovelace  " },
        { memberId: "M-2", fullName: "Grace Hopper" },
      ],
    })
  );
  assert.strictEqual(padded.ok, true);
  assert.strictEqual(padded.group.organizerId, "CUST-ORG");
  assert.strictEqual(padded.group.members[0].memberId, "M-1");
  assert.strictEqual(padded.group.members[0].fullName, "Ada Lovelace");

  console.log("groupValidation: values are trimmed so a padded resubmission is the same group");

  // ------------------------------------------------- criterion 2: the prompt

  // EVERY PROBLEM AT ONCE. The point of the criterion: an organizer who got
  // four things wrong is told about four things, not the first one.
  const empty = validateGroupRequest({});
  assert.strictEqual(empty.ok, false);
  assertMentions(empty.missing, ["organizerId", "itinerary", "members"]);
  assert.ok(empty.missing.length >= 3, "an empty submission should report all three");

  console.log("groupValidation: an empty submission reports every missing section at once");

  // Called with no argument at all. A caller that forgot the body must get the
  // prompt, not a TypeError on a property read.
  const nothing = validateGroupRequest();
  assert.strictEqual(nothing.ok, false);
  assert.ok(nothing.missing.length >= 3);

  console.log("groupValidation: a missing body prompts rather than throwing");

  // Each itinerary leg is named individually, so a half-filled itinerary tells
  // the organizer WHICH legs to supply.
  const partialItinerary = validateGroupRequest(
    completeRequest({ itinerary: { flightId: "FL-100" } })
  );
  assert.strictEqual(partialItinerary.ok, false);
  assertMentions(partialItinerary.missing, ["itinerary.hotelId", "itinerary.safariId"]);
  assert.ok(
    !partialItinerary.missing.some(function (problem) {
      return problem.includes("itinerary.flightId");
    }),
    "the leg that WAS supplied must not be reported missing"
  );

  console.log("groupValidation: a half-filled itinerary names exactly the legs that are missing");

  // An itinerary that is not an object at all - a string, an array, null.
  [null, "FL-100", [], 42].forEach(function (bad) {
    const result = validateGroupRequest(completeRequest({ itinerary: bad }));
    assert.strictEqual(result.ok, false, "itinerary " + JSON.stringify(bad) + " must be refused");
    assertMentions(result.missing, ["itinerary is required"]);
  });

  console.log("groupValidation: a non-object itinerary is missing information, not a crash");

  // Members that are not a list.
  [null, undefined, "M-1", { memberId: "M-1" }].forEach(function (bad) {
    const result = validateGroupRequest(completeRequest({ members: bad }));
    assert.strictEqual(result.ok, false);
    assertMentions(result.missing, ["members is required"]);
  });

  console.log("groupValidation: a members list that is not an array is refused");

  // --------------------------------------------------------- group size

  // A GROUP IS TWO OR MORE. One traveller is a trip, and bookTripService books
  // those - see the header. The message says so rather than stating a bare
  // minimum, because "at least 2" reads as arbitrary without the reason.
  [[], [{ memberId: "M-1", fullName: "Ada Lovelace" }]].forEach(function (tooFew) {
    const result = validateGroupRequest(completeRequest({ members: tooFew }));
    assert.strictEqual(result.ok, false);
    assertMentions(result.missing, ["at least " + MIN_GROUP_SIZE, "ordinary trip"]);
  });

  console.log("groupValidation: fewer than " + MIN_GROUP_SIZE + " travellers is not a group");

  // AND AT MOST MAX_GROUP_SIZE. The list drives a payment amount and a write
  // per member, so an unbounded array is an unbounded charge.
  const tooMany = [];
  for (let index = 0; index < MAX_GROUP_SIZE + 1; index += 1) {
    tooMany.push({ memberId: "M-" + index, fullName: "Traveller " + index });
  }
  const oversize = validateGroupRequest(completeRequest({ members: tooMany }));
  assert.strictEqual(oversize.ok, false);
  assertMentions(oversize.missing, ["maximum for one group booking is " + MAX_GROUP_SIZE]);

  // The boundary itself is allowed - an off-by-one here would refuse a legal
  // group of exactly the maximum size.
  const atLimit = validateGroupRequest(completeRequest({ members: tooMany.slice(0, MAX_GROUP_SIZE) }));
  assert.strictEqual(atLimit.ok, true);
  assert.strictEqual(atLimit.group.members.length, MAX_GROUP_SIZE);

  console.log("groupValidation: " + MAX_GROUP_SIZE + " travellers is allowed, one more is not");

  // ------------------------------------------------------------ one member

  const blankName = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1", fullName: "   " },
        { memberId: "M-2", fullName: "Grace Hopper" },
      ],
    })
  );
  assert.strictEqual(blankName.ok, false);
  assertMentions(blankName.missing, ["members[0].fullName", "a ticket needs a name"]);

  console.log("groupValidation: a traveller with no name cannot be ticketed");

  const blankId = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1", fullName: "Ada Lovelace" },
        { fullName: "Grace Hopper" },
      ],
    })
  );
  assert.strictEqual(blankId.ok, false);
  assertMentions(blankId.missing, ["members[1].memberId"]);

  console.log("groupValidation: a traveller with no id is reported by position");

  // A member that is not an object at all.
  const notAnObject = validateGroupRequest(
    completeRequest({ members: [{ memberId: "M-1", fullName: "Ada Lovelace" }, "Grace Hopper"] })
  );
  assert.strictEqual(notAnObject.ok, false);
  assertMentions(notAnObject.missing, ["members[1] must be an object"]);

  console.log("groupValidation: a member that is not an object is reported, not read into");

  // ------------------------------------------------------------- duplicates

  const duplicate = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1", fullName: "Ada Lovelace" },
        { memberId: "M-1", fullName: "Ada Lovelace Again" },
      ],
    })
  );
  assert.strictEqual(duplicate.ok, false);
  assertMentions(duplicate.missing, ["members[1].memberId duplicates"]);

  console.log("groupValidation: the same traveller twice is a double charge, and is refused");

  // REGRESSION, and the reason this case exists. The first version recorded a
  // member's id in `seenIds` only once the WHOLE member had passed, so an
  // earlier member rejected for some other reason - a blank name - freed their
  // id and the later duplicate went unreported. The organizer would fix the
  // name, resubmit, and only THEN be told about the duplicate: the second
  // round trip this validator exists to avoid. Both problems must appear in
  // one pass.
  const duplicateBehindABrokenMember = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1" },
        { memberId: "M-1", fullName: "Ada Lovelace" },
      ],
    })
  );
  assert.strictEqual(duplicateBehindABrokenMember.ok, false);
  assertMentions(duplicateBehindABrokenMember.missing, [
    "members[0].fullName",
    "members[1].memberId duplicates",
  ]);

  console.log("groupValidation: a duplicate is reported even when the first member is broken too");

  // Trimming happens before the comparison, so padding is not a way to sneak
  // the same traveller onto a booking twice.
  const paddedDuplicate = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1", fullName: "Ada Lovelace" },
        { memberId: "  M-1  ", fullName: "Ada Lovelace" },
      ],
    })
  );
  assert.strictEqual(paddedDuplicate.ok, false);
  assertMentions(paddedDuplicate.missing, ["members[1].memberId duplicates"]);

  console.log("groupValidation: whitespace is not a way to book the same traveller twice");

  // ------------------------------------------- hostile and malformed input

  // PROBLEMS NAME POSITIONS, NEVER VALUES. A submitted value can reach a log,
  // an email or an advisor's screen, so it must not be echoed back. Same rule
  // leadStore.test.js enforces for the audit trail.
  const injection = "Robert'); DROP TABLE members;--";
  const hostile = validateGroupRequest(
    completeRequest({
      organizerId: injection,
      members: [
        { memberId: injection, fullName: "" },
        { memberId: "M-2", fullName: "Grace Hopper" },
      ],
    })
  );
  assert.strictEqual(hostile.ok, false);
  const reported = hostile.missing.join(" ");
  assert.ok(
    !reported.includes("DROP TABLE"),
    "a rejected value must never appear in the prompt: " + reported
  );

  console.log("groupValidation: a rejected value is never echoed back in the prompt");

  // PROTOTYPE-CHAIN KEYS. A body of { "constructor": ... } arrives from the
  // internet more often than anyone expects. Reading it off the prototype
  // yields a function where a string belongs, which passes a truthiness check
  // and fails much later somewhere less obvious.
  const prototypePollution = validateGroupRequest(
    completeRequest({
      members: [Object.create({ memberId: "M-INHERITED", fullName: "Not Really There" }), { memberId: "M-2", fullName: "Grace Hopper" }],
    })
  );
  assert.strictEqual(prototypePollution.ok, false);
  assertMentions(prototypePollution.missing, ["members[0].memberId", "members[0].fullName"]);

  console.log("groupValidation: inherited properties do not count as supplied values");

  // OVER-LONG INPUT IS REFUSED, NOT TRUNCATED, and the prompt says which
  // problem it is. Two things are being asserted here and both matter:
  //
  //   1. It is refused. Silently cutting a 700-character name down to 200
  //      produces a ticket whose name does not match the passport at the gate
  //      - a failure discovered at the airport rather than at the form.
  //   2. The message distinguishes "too long" from "required". The first
  //      version of this validator said "fullName is required" for a name
  //      that had very much been supplied, which sends the organizer looking
  //      for an empty box that is not there. An unactionable prompt does not
  //      satisfy "prompts for missing information".
  const longName = "A".repeat(MAX_NAME_LENGTH + 500);
  const overlong = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1", fullName: longName },
        { memberId: "M-2", fullName: "Grace Hopper" },
      ],
    })
  );
  assert.strictEqual(overlong.ok, false);
  assertMentions(overlong.missing, ["members[0].fullName is longer than " + MAX_NAME_LENGTH]);
  assert.ok(
    !overlong.missing.some(function (problem) {
      return problem.includes("fullName is required");
    }),
    "a supplied-but-too-long name must not be reported as missing"
  );
  // And the rejected value itself still never appears in the prompt.
  assert.ok(!overlong.missing.join(" ").includes(longName));

  console.log("groupValidation: an over-long name is refused, and the prompt says why");

  // The same distinction on an id, so the rule is the module's and not one
  // field's special case.
  const longId = "M-" + "9".repeat(MAX_ID_LENGTH);
  const overlongId = validateGroupRequest(completeRequest({ organizerId: longId }));
  assert.strictEqual(overlongId.ok, false);
  assertMentions(overlongId.missing, ["organizerId is longer than " + MAX_ID_LENGTH]);

  console.log("groupValidation: the too-long prompt is the module's rule, not one field's");

  // ----------------------------------------------------------- all or nothing

  // One unusable member fails the WHOLE group. Returning the good ones would
  // invite a caller to book the subset, and "confirms the booking for all
  // members" is the criterion.
  const oneBad = validateGroupRequest(
    completeRequest({
      members: [
        { memberId: "M-1", fullName: "Ada Lovelace" },
        { memberId: "M-2", fullName: "Grace Hopper" },
        { memberId: "M-3" },
      ],
    })
  );
  assert.strictEqual(oneBad.ok, false);
  assert.strictEqual(oneBad.group, undefined, "a refusal must not hand back a partial group");

  console.log("groupValidation: one unusable traveller fails the whole group, with no partial result");

  console.log("groupValidation: all tests passed");
}

main();
