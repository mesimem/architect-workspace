# STORY-017 — Combine multiple travel products into one package

As a travel advisor, I want to combine multiple travel products into one package, so that I can offer comprehensive travel solutions.

**Release:** r3 · Customer Portal and Operations (weeks 7–8)
**Owner:** Travel Advisor
**Blocked by:** STORY-015

## The requirement this satisfies

- **REQ-009** as cited by the build brief — "The system must allow advisors to combine
  multiple travel products into one package."

**Read that citation with care.** REQ-009 in `docs/REQUIREMENTS.md` is a different
requirement — "the system must generate professional quotes and itineraries for
customers", already fulfilled by STORY-007. The packaging capability is not in that
file under any id, and `docs/TRACEABILITY.md` therefore has no row for this story.

That gap is deliberate and is NOT an oversight to be tidied up locally. Both documents
are generated from the platform's plan (`.colaberry/plan.json`, 16 stories, 18
requirements, last written 2026-08-31), which has no record of STORY-017. A
hand-written requirement here would read as truth to the next person while disagreeing
with the plan every sync republishes. The honest state is a story whose requirement
reference points at the brief it came from, with the discrepancy written down.

When the plan is republished with this story in it, the requirement will arrive with
its real id and this section should be rewritten to cite it.

Nothing about the work was ever ambiguous: "combine multiple travel products into one
package" is what got built.

## How to build it

Develop functionality to combine travel products into packages. Ensure compatibility
checks and seamless integration with booking systems.

## What a "travel product" is here, and why

The repo has exactly one authored inventory of sellable travel products: the safari
product book from STORY-015 (`services/products/safariProductStore.js`), twelve seeded
Kenya and Tanzania packages each carrying a country, a duration, a day-by-day itinerary
and USD pricing with an internal cost. There is no flight, lodging or transfer inventory
anywhere in the system, and the requirement does not ask for one.

So a package combines **safari products, by reference**. Each component is written

```json
{ "kind": "safari", "productId": "safari_…", "startDay": 1 }
```

The `kind` discriminator is present from day one and is validated against a known list,
even though that list has one entry today. That is the whole provision for what comes
next: when a flight or lodging module lands, a new `kind` is an addition to the list and
a new branch in the component resolver — not a migration of every package already
written. Storing a bare `productId` with no `kind` would have been two fewer lines now
and a rewrite of the stored shape later.

Components are **referenced, never copied**. A package holds ids; the product book holds
the itinerary and the price. Copying a product's price into the package would mean a
repricing in STORY-015 silently failing to reach packages that sell it, which is the
same stale-copy bug the store header warns about for indexes.

## What makes two products incompatible

This is the definition the validator, the error messages and the tests all read from.
A package is refused if any of these holds:

1. **Currency mismatch** — two components priced in different currencies. The system has
   a single-currency invariant already (`quotes/quotePricing.js`, `CURRENCIES`); summing
   USD and EUR into one "package total" would produce a number that is not money.
2. **Duplicate product** — the same `productId` listed twice. Selling a customer the same
   safari twice is a copy-paste, not an offering.
3. **Overlapping days** — two components whose day spans collide, where a span is
   `startDay` through `startDay + durationDays - 1`. A customer cannot be in the Masai
   Mara and the Serengeti on the same day.
4. **Cross-country without a gap** — two components in different countries that are
   day-adjacent, with no free travel day between them. Ending in Kenya on day 6 and
   starting in Tanzania on day 7 is not an itinerary anyone can fly.

Rules 3 and 4 are the pair that justifies `startDay` existing at all. A package that was
just an unordered bag of product ids could not express either, and "incompatible" would
collapse to "different currency", which is not what an advisor means by the word.

Note what is deliberately NOT a compatibility rule: a **gap** between components (day 4
ends, day 8 begins) is allowed. A customer with four days at leisure between two safaris
is a real itinerary, and refusing it would make the checker wrong in a way an advisor
cannot work around.

## Failure paths you must handle

- Incompatible products are combined into a package.
- Package creation fails due to system error.
- Unauthorized access to package creation feature.

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given an advisor selects multiple travel products, when they create a package, then the system combines them into a single offering.
- [x] Given an advisor tries to combine incompatible products, when they attempt to save, then the system displays an error message.
- [x] Trust: The system logs all package creation and modification details in the audit trail.

Where each is proved, so the ticks can be checked rather than trusted:

| Criterion | Proof |
|---|---|
| 1 — combines into one offering | `http/packages.test.js` — an advisor POSTs two products and gets one `packageId` back, priced at the sum of its parts (`$7,400`), listed in the book, and readable by id. Also `packageStore.test.js`. |
| 2 — error on incompatible products | `packageCompatibility.test.js` proves all four rules and the three non-rules; `http/packages.test.js` proves the overlap, cross-country and duplicate cases come back as HTTP 400 with a message naming the components and the days. |
| 3 — creation and modification audited | `http/packages.test.js` reads `packages.created` and `packages.updated` back through `GET /api/admin/audit`, including the margin, and asserts the creation entry survives the modification. Refusals are audited too. |

When every box above is ticked, stop and show the demo.

## Access control

`packages.read` and `packages.write` are new permissions in
`services/authz/permissions.js`, granted to **advisor** and **product_manager**. The
story is written in the advisor's voice and composing a package is selling work, not
authoring work — but a product manager who authors the components is the other principal
who composes them, and the grant is made deliberately rather than inherited.

Enforcement is the existing central gate in `http/server.js`, against the permission each
route declares. There is no second check inside the package service, for the reason
`productRoutes.js` states: two policies can disagree.

## Out of scope — do not build it here

- **Booking a package.** STORY-018 centralises bookings and their statuses. A package is
  an offering; turning one into a booking is that story's job.
- **Deleting a package.** Same reasoning as the product book: erasing a package erases
  the subject of its own audit trail. Retirement is a status question a later story owns.
- **Quoting from a package.** `quotes/` prices explicit line items and is unchanged.
