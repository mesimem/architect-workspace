# STORY-018 — Centralize all bookings and manage their statuses

As an operations manager, I want to centralize all bookings and manage their statuses, so that I can efficiently oversee operations.

**Release:** r3 · Customer Portal and Operations (weeks 7–8)
**Owner:** Operations Manager
**Follows:** STORY-016 (flight module), STORY-017 (packages)

## The requirement this satisfies

- **REQ-012** as cited by the build brief — "The system must centralize all bookings
  and manage their statuses."

**Read that citation with care, for the same reason STORY-017's does.** REQ-012 in
`docs/REQUIREMENTS.md` is a different requirement — "the system must track supplier
information including contracts and rates", already fulfilled by STORY-010, and
`docs/TRACEABILITY.md` row 20 says so. `.colaberry/plan.json` agrees with the file and
not with the brief: its REQ-012 is the supplier one, carrying `fulfilled_by:
["STORY-010"]`.

The centralised-bookings capability is not in either document under any id, and
TRACEABILITY therefore has no row for this story.

That gap is deliberate and is NOT an oversight to be tidied up locally. Both documents
are generated from the platform's plan (16 stories, 18 requirements), which has no
record of STORY-017 or STORY-018. A hand-written requirement here would read as truth
to the next person while disagreeing with the plan every sync republishes — and the
repo has already tried that once: commit `fafedda` reverts exactly such an addition
("Revert REQ-019: restore REQUIREMENTS.md and TRACEABILITY.md"). The honest state is a
story whose requirement reference points at the brief it came from, with the
discrepancy written down.

When the plan is republished with this story in it, the requirement will arrive with
its real id and this section should be rewritten to cite it.

Nothing about the work was ever ambiguous: "centralize all bookings and manage their
statuses" is what got built.

## How to build it

Implement a centralized booking dashboard to manage and update booking statuses.
Ensure real-time updates and audit logging.

## Where "all bookings" already lived, and why nothing new stores them

The central design decision of this story is that **the centralised book of bookings
was not built, because it already existed.**

Every booking path in this system writes to one durable store:
`services/booking/crmTransactionLog.js`, the store named `crm-transactions`, keyed on
`tripId`. A single booking writes one row (`bookTripService.js`). A group booking
writes one row per MEMBER, each carrying a `groupId` pointing back at the group
(`groupBookingService.js`). One row is one person's trip, which is the granularity an
operations manager works at — a group of eight is eight things to arrange, not one.

This matters more than it looks. `bookTripService` keeps its confirmed single bookings
in an in-memory `Map` that does not survive a restart; the ledger row is their only
durable trace. Reading the ledger is therefore not merely the convenient source, it is
the only one that is still correct tomorrow.

**The dashboard reads that ledger live, on every call.** There is no projection to
rebuild, no cache to warm, no overnight job that can have failed. That is what makes
the failure path "dashboard fails to display new bookings" structurally hard rather than
merely tested: a booking appears on the board the instant its ledger row exists, because
the board reads that row.

## Why the status is an overlay, and not a column

The ledger cannot carry the operations status, for a reason that is a feature of it
rather than a flaw: `logTransaction` is idempotent by returning the EXISTING row
untouched when the `tripId` is already present. It cannot be updated through its own
front door, by design, because it is a ledger — and a ledger that rewrites its rows is
not a ledger.

So the status lives beside it, in a second store (`booking-statuses`) keyed on the same
`tripId`, and the dashboard joins the two. An overlay row holds the status, the status
it came from, a version, and who changed it when. It holds **no customer name, no
itinerary and no money** — those are the ledger's.

**The alternative that was refused.** The obvious shape is a bookings table of our own:
copy every ledger row into it, add a status column, let the dashboard read one place.
That buys a simpler query and costs the thing this story's second failure path is about.
A copy has to be kept in step, which means a sync step, which means a sync step that can
fail. An overlay cannot drift from the ledger because it never holds a second copy of
what the ledger says. `packageStore.js` makes the same argument about why a package
stores product ids and not product prices.

**A booking with no overlay row is not missing — it is untouched.** Absence means
operations have never changed it, so its status is the one the booking path wrote.
This is why creating a booking does not have to register anywhere to show up.

## The four statuses, and why two are final

This is the definition the lifecycle module, the error messages and the tests all read
from. REQ-012 asks the system to "manage their statuses", which only means something
once "status" has a fixed vocabulary — a free-form string would have made the
dashboard's status column read as whatever anyone happened to type, and "cancelled",
"Cancelled" and "canceled" are three statuses to a filter and one to a human.

```
confirmed ──▶ in_progress ──▶ completed  (terminal)
    │              │
    └──────┬───────┘
           ▼
       cancelled  (terminal)
```

- **confirmed** — the booking exists and is paid for. The only status the booking path
  itself ever writes, so it is the start state by construction, not by choice.
- **in_progress** — operations have begun arranging it with suppliers.
- **completed** — the customer has travelled. **Terminal.**
- **cancelled** — the booking will not be travelled. **Terminal.**

**Why the two are terminal.** A status is a claim about the real world, and these two
claims are about things that have already happened. Once a trip is travelled, nothing an
operations manager types makes it untravelled; once a booking is cancelled, re-opening it
is a NEW booking with its own payment, not an edit to a dead one. A lifecycle that lets a
record leave a terminal state is one where the status column cannot be trusted, because
it can always be walked backwards.

This is also the testable form of "booking status fails to update". Without terminal
states, the only way to make an update fail is to break the store — which tests a disk,
not a rule.

**Why `confirmed` cannot jump straight to `completed`.** The path is a path: a booking
never arranged with a supplier cannot have been travelled. Allowing the jump would mean
the transition that matters most — "this customer has now had their trip" — could be
recorded with no evidence that anybody did the work. An operations manager who genuinely
needs to skip a step makes two deliberate, separately-audited changes.

**Deliberately absent: `on_hold`.** Real operations teams hold bookings for payment and
document problems, so this is the likely next addition — but nothing in the story or the
requirement asks for it, and a state invented ahead of the requirement that asks for it
is a state nobody can say is correct. Adding it later is one entry in `STATUSES` and two
rows in `ALLOWED_TRANSITIONS`.

**Setting a status to what it already is is not a refusal.** It is a no-op the caller
reports as success, writing and auditing nothing. A retried PATCH — a double-clicked
button, a replayed request — must not append a second audit entry claiming the status
changed twice.

## How every change gets into the audit trail

Writes go through `shared/auditedCommit.js`: save → read back and verify → audit →
**roll back if the audit fails**. No status change exists in the store without a matching
entry in the trail.

The mechanism that makes "ALL changes are logged" true rather than aspirational is the
**version**. `commit` keys its entry on `deriveAuditKey(id, event + ".v" + version)`,
because the audit log is first-write-wins. Keyed on the `tripId` alone, the first status
change would be recorded and every later one silently discarded — leaving the code
passing its other tests while quietly failing the trust criterion.

Refused attempts are audited too, under their own event
(`booking.status.change_refused`). That is more than the criterion asks for: a manager
repeatedly trying to reopen completed bookings is a fact about a person, and those are
what an audit trail exists to hold.

## Failure paths you must handle

- **Booking status fails to update.** Two distinct kinds, handled separately. As a
  RULE: an illegal or terminal transition is refused with a 409 naming the statuses that
  would work. As an OUTAGE: the store refusing, losing or staling the write, or the
  audit log being unavailable — all of which leave the stored status exactly as it was
  and return a 503 meaning "unchanged, repeat the request".
- **Dashboard fails to display new bookings.** Addressed structurally: the board reads
  the ledger live, so there is no sync step between a booking being made and it being
  shown.
- **Unauthorized access to booking management features.** A property of the HTTP
  boundary: every route declares a permission, `server.js` enforces it once and audits
  every denial.

## Acceptance — your stop condition

- [x] Given a new booking is created, when the manager views the booking dashboard, then
      the system displays the booking with its current status.
- [x] Given a booking status is updated, when the manager saves the changes, then the
      system reflects the updated status in the dashboard.
- [x] Trust: the system logs all booking status changes in the audit trail.

Each is proved twice: at the service layer in `opsBookingBoard.test.js` against a trip
booked through `bookTrip` (not a fixture row), and over real HTTP in
`http/opsBookings.test.js` against the audit trail as an admin can actually read it
through `/api/admin/audit`.

## Access control

A sixth role, `operations_manager`, holding `ops.bookings.read` and
`ops.bookings.write` — and no other role holds either.

**Why a new role rather than a grant on an existing one.** The story is written in the
operations manager's voice, and no existing role is that person. Both candidates were
refused because the cheaper change has the larger blast radius: giving it to `admin`
would mean the role that reads the audit trail is also the role that can cancel a
booking; giving it to `sales` would widen a relationship-scoped read into "every
customer's booking at once".

**Read and write are split, and the read is the dangerous half** — the opposite of the
usual intuition. `GET` returns every booking the agency holds; `PATCH` can only move one
booking along a four-state lifecycle that refuses to leave a terminal state. The split is
what lets a future reporting integration be given the board without the ability to cancel
anything.

**What the role deliberately does not hold:** `admin.audit.read` (the trail records what
an operations manager did, and someone who can both change a status and read the record
of changing it is a weaker control than two people), the CRM grants, and every `*.write`
on products, packages, quotes and proposals — operations deliver what was sold, they do
not reprice or re-author it.

## Out of scope — do not build it here

- **Filtering and pagination over HTTP.** `listBookings` takes `status` and `groupId`
  filters and they are tested, but no route passes them: nothing in this pipeline reads
  query strings (`server.js` parses the pathname only, and no route in the system takes a
  query parameter). Adding that is an edit to the central request pipeline every route
  shares, and belongs to whoever needs it, done once for all routes.
- **An `on_hold` status.** See above.
- **Bulk status changes.** Each change is its own audited decision; a bulk endpoint would
  make the trail harder to read for the one case it saves time on.
- **Deleting a booking.** That is what `cancelled` is for.
- **Making single-trip bookings durable.** `bookTripService` holds them in memory and the
  CRM ledger row is their only durable trace. That is a pre-existing limitation this
  story reads around rather than fixes; fixing it is a change to the booking path, not to
  the dashboard.
