# U.S.-based Full-Service Travel Agency Platform — Stories

16 stories across 5 releases, walking-skeleton first:
the earliest release proves the thinnest end-to-end path including the trust
spine, and later releases stack features on top of something already working.

## Before the releases — start here

- **[STORY-000](stories/STORY-000.md)** — Build your Command Center

The first thing you build, on day one, before any part of the system itself. It is
the page you keep open for the rest of the programme and demo from. It belongs to no
release and fulfils none of your requirements, because it is the window onto your
system rather than a part of it.

## r0 · Initial MVP — weeks 1–1

**Goal:** Establish core booking and CRM functionalities with a focus on African travel.
**Done when you can show:** Demonstrate booking a flight, hotel, and safari as a single trip with CRM tracking.

- **[STORY-001](stories/STORY-001.md)** — Book a complete trip including flight, hotel, and safari
- **[STORY-002](stories/STORY-002.md)** — Create a dedicated African travel section
- **[STORY-003](stories/STORY-003.md)** — Flag uncertain requests for advisor review
- **[STORY-004](stories/STORY-004.md)** — Enable integration with accounting software for transaction logging

## r1 · Customer Portal and Security — weeks 2–2

**Goal:** Implement customer portal and security features.
**Done when you can show:** Show customer managing itinerary and secure login process.

- **[STORY-005](stories/STORY-005.md)** — Implement secure customer portal _(waits on STORY-001)_
- **[STORY-006](stories/STORY-006.md)** — Implement role-based permissions _(waits on STORY-001)_
- **[STORY-014](stories/STORY-014.md)** — Implement CRM for tracking leads, customers, and booking history _(waits on STORY-005)_

## r2 · Quotation and Group Travel — weeks 3–3

**Goal:** Enable quotation system and group travel bookings.
**Done when you can show:** Generate a professional quote and book a group trip.

- **[STORY-007](stories/STORY-007.md)** — Generate professional quotes for customers _(waits on STORY-005)_
- **[STORY-008](stories/STORY-008.md)** — Support group travel bookings _(waits on STORY-005)_
- **[STORY-013](stories/STORY-013.md)** — Create customized trip proposals for travel advisors _(waits on STORY-008)_
- **[STORY-015](stories/STORY-015.md)** — Support creation of detailed safari products with itineraries and pricing _(waits on STORY-007)_

## r3 · AI Assistance and Supplier Management — weeks 4–4

**Goal:** Introduce AI features and manage supplier information.
**Done when you can show:** AI suggests trip ideas and supplier data is managed.

- **[STORY-009](stories/STORY-009.md)** — AI suggests trip ideas to customers _(waits on STORY-007)_
- **[STORY-010](stories/STORY-010.md)** — Manage supplier information _(waits on STORY-007)_
- **[STORY-016](stories/STORY-016.md)** — Ensure system scalability for multiple advisors and thousands of customers _(waits on STORY-010)_

## r4 · Payments and Analytics — weeks 5–6

**Goal:** Complete payment processing and analytics capabilities.
**Done when you can show:** Process a payment and display analytics dashboard.

- **[STORY-011](stories/STORY-011.md)** — Process customer payments and track balances _(waits on STORY-009)_
- **[STORY-012](stories/STORY-012.md)** — Provide analytics on revenue and bookings _(waits on STORY-009)_
