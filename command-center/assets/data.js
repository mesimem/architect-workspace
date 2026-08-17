/* ============================================================
   Command Center — single source of truth
   Every page reads from REAL_DATA (and, in Sample mode, from
   the SAMPLE_DATA overlay produced by buildSampleData()).
   Nothing here is invented beyond what the plan states; fields
   with no real value yet are left null / empty and rendered as
   explicit empty states by site.js.
   ============================================================ */

var REAL_DATA = {

  meta: {
    title: "Full-Service Travel Agency Platform",
    sector: "U.S.-based, African travel specialist",
    oneLiner: "A full-service travel agency platform for African travel — flights, hotels, and safaris booked as one trip, a customer self-service portal, AI-assisted trip ideas, and the CRM, quoting, and supplier tools an advisor team runs it on.",
    todayISO: "2026-08-17",
    demoDayISO: "2026-10-08",
    buildEndsISO: "2026-10-01"
  },

  // REQ-xxx — full requirement set from the plan.
  requirements: [
    { id: "REQ-001", category: "FUNC",       priority: "must",   text: "The system must allow customers to book flights, hotels, and safaris as part of a single trip." },
    { id: "REQ-002", category: "FUNC",       priority: "must",   text: "The system must support a major section dedicated to African travel, including safaris and cultural experiences." },
    { id: "REQ-003", category: "FUNC",       priority: "must",   text: "The system must enable travel advisors to create customized trip proposals within 30 minutes." },
    { id: "REQ-004", category: "CONSTRAINT", priority: "must",   text: "The system must integrate with accounting software for financial tracking." },
    { id: "REQ-005", category: "SAFE",       priority: "must",   text: "The system must flag uncertain customer requests for travel advisor review." },
    { id: "REQ-006", category: "FUNC",       priority: "must",   text: "The system must provide a CRM to track leads, customers, and booking history." },
    { id: "REQ-007", category: "FUNC",       priority: "must",   text: "The system must allow customers to view and manage their itineraries through a secure portal." },
    { id: "REQ-008", category: "SAFE",       priority: "must",   text: "The system must support secure authentication and role-based permissions." },
    { id: "REQ-009", category: "FUNC",       priority: "must",   text: "The system must generate professional quotes and itineraries for customers." },
    { id: "REQ-010", category: "FUNC",       priority: "must",   text: "The system must handle group travel bookings with shared itinerary information." },
    { id: "REQ-011", category: "FUNC",       priority: "should", text: "The system must support AI capabilities to assist customers in exploring destinations and generating trip ideas." },
    { id: "REQ-012", category: "FUNC",       priority: "must",   text: "The system must track supplier information including contracts and rates." },
    { id: "REQ-013", category: "FUNC",       priority: "must",   text: "The system must allow customers to make payments and track their remaining balances." },
    { id: "REQ-014", category: "FUNC",       priority: "must",   text: "The system must support the creation of detailed safari products with itineraries and pricing." },
    { id: "REQ-015", category: "FUNC",       priority: "should", text: "The system must provide analytics on revenue, bookings, and customer data." },
    { id: "REQ-016", category: "FUNC",       priority: "should", text: "The system must support marketing capabilities such as email campaigns and customer segmentation." },
    { id: "REQ-017", category: "SAFE",       priority: "must",   text: "The system must maintain audit logs for all transactions and changes." },
    { id: "REQ-018", category: "NFR",        priority: "must",   text: "The system must support scalability to accommodate multiple advisors and thousands of customers." }
  ],

  // Guardrails: the SAFE requirements, and what (if anything) enforces them today.
  guardrails: [
    {
      id: "REQ-005",
      promise: "The system must flag uncertain customer requests for travel advisor review.",
      enforcedBy: null,
      note: "No triage logic exists yet — this is a r3 (AI Assistance) capability, STORY-009."
    },
    {
      id: "REQ-008",
      promise: "The system must support secure authentication and role-based permissions.",
      enforcedBy: null,
      note: "Scoped for r1 (Customer Portal and Security) — STORY-005, STORY-006. Not built yet."
    },
    {
      id: "REQ-017",
      promise: "The system must maintain audit logs for all transactions and changes.",
      enforcedBy: null,
      note: "No story explicitly owns this yet — worth flagging for scoping before r4 (Payments) ships."
    }
  ],

  // STORY-xxx — id, title, release, due date, owning role, and (real) status.
  // Status is intentionally null for every story: nothing has shipped yet.
  stories: [
    { id: "STORY-001", title: "Book a complete trip including flight, hotel, and safari",            release: "r0", due: "2026-08-15", owner: "Travel Advisor",     reqIds: ["REQ-001"] },
    { id: "STORY-002", title: "Create a dedicated African travel section",                            release: "r0", due: "2026-08-17", owner: "Travel Advisor",     reqIds: ["REQ-002"] },
    { id: "STORY-003", title: "Flag uncertain requests for advisor review",                            release: "r0", due: "2026-08-19", owner: "Travel Advisor",     reqIds: ["REQ-005"] },
    { id: "STORY-004", title: "Enable integration with accounting software for transaction logging",  release: "r0", due: "2026-08-21", owner: "Development Team",   reqIds: ["REQ-004"] },

    { id: "STORY-005", title: "Implement secure customer portal",                                      release: "r1", due: "2026-08-24", owner: "Customer Support",   reqIds: ["REQ-007", "REQ-008"] },
    { id: "STORY-006", title: "Implement role-based permissions",                                      release: "r1", due: "2026-08-27", owner: "System Administrator", reqIds: ["REQ-008"] },
    { id: "STORY-014", title: "Implement CRM for tracking leads, customers, and booking history",      release: "r1", due: "2026-08-29", owner: "Development Team",   reqIds: ["REQ-006"] },

    { id: "STORY-007", title: "Generate professional quotes for customers",                            release: "r2", due: "2026-08-31", owner: "Travel Advisor",     reqIds: ["REQ-009"] },
    { id: "STORY-008", title: "Support group travel bookings",                                         release: "r2", due: "2026-09-02", owner: "Travel Advisor",     reqIds: ["REQ-010"] },
    { id: "STORY-013", title: "Create customized trip proposals for travel advisors",                  release: "r2", due: "2026-09-04", owner: "Development Team",   reqIds: ["REQ-003"] },
    { id: "STORY-015", title: "Support creation of detailed safari products with itineraries and pricing", release: "r2", due: "2026-09-07", owner: "Development Team", reqIds: ["REQ-014"] },

    { id: "STORY-009", title: "AI suggests trip ideas to customers",                                   release: "r3", due: "2026-09-09", owner: "AI Developer",       reqIds: ["REQ-011"] },
    { id: "STORY-010", title: "Manage supplier information",                                           release: "r3", due: "2026-09-12", owner: "Travel Advisor",     reqIds: ["REQ-012"] },
    { id: "STORY-016", title: "Ensure system scalability for multiple advisors and thousands of customers", release: "r3", due: "2026-09-15", owner: "Development Team", reqIds: ["REQ-018"] },

    { id: "STORY-011", title: "Process customer payments and track balances",                          release: "r4", due: "2026-09-23", owner: "Finance Manager",    reqIds: ["REQ-013"] },
    { id: "STORY-012", title: "Provide analytics on revenue and bookings",                              release: "r4", due: "2026-10-01", owner: "Business Analyst",   reqIds: ["REQ-015"] }
  ],

  releases: [
    { id: "r0", name: "Initial MVP",                          start: "2026-08-15", end: "2026-08-21", isDemoTarget: false },
    { id: "r1", name: "Customer Portal and Security",         start: "2026-08-24", end: "2026-08-29", isDemoTarget: true  },
    { id: "r2", name: "Quotation and Group Travel",           start: "2026-08-31", end: "2026-09-07", isDemoTarget: false },
    { id: "r3", name: "AI Assistance and Supplier Management",start: "2026-09-09", end: "2026-09-15", isDemoTarget: false },
    { id: "r4", name: "Payments and Analytics",                start: "2026-09-23", end: "2026-10-01", isDemoTarget: false }
  ],

  // Roles as written in the user stories ("As a <role>, I want ...").
  roles: ["customer", "travel advisor", "admin", "group organizer", "manager", "sales manager"],

  // Story owners — these are the people/teams responsible for each story,
  // not a scoped roster of AI agents. See agents.html for the distinction.
  owners: [
    { name: "Travel Advisor",      storyIds: ["STORY-001", "STORY-002", "STORY-003", "STORY-007", "STORY-008", "STORY-010"] },
    { name: "Development Team",    storyIds: ["STORY-004", "STORY-013", "STORY-014", "STORY-015", "STORY-016"] },
    { name: "Customer Support",    storyIds: ["STORY-005"] },
    { name: "System Administrator",storyIds: ["STORY-006"] },
    { name: "AI Developer",        storyIds: ["STORY-009"] },
    { name: "Finance Manager",     storyIds: ["STORY-011"] },
    { name: "Business Analyst",    storyIds: ["STORY-012"] }
  ],

  // No numeric outcome targets defined in the plan yet.
  outcomes: [],

  // No external systems named in the plan yet.
  systems: []
};

/* ------------------------------------------------------------
   Sample data: a believable illustrative overlay, used only in
   Sample mode so the empty tabs (Outcomes, Systems) and the
   not-yet-real fields (story status, guardrail enforcement,
   owner skills) show their eventual shape. Every value here is
   fabricated and must render with a visible SAMPLE tag.
   ------------------------------------------------------------ */
function buildSampleData(real) {
  var sample = JSON.parse(JSON.stringify(real));

  var sampleStatusByStory = {
    "STORY-001": "done", "STORY-002": "done", "STORY-003": "in-progress", "STORY-004": "not-started",
    "STORY-005": "not-started", "STORY-006": "not-started", "STORY-014": "not-started",
    "STORY-007": "not-started", "STORY-008": "not-started", "STORY-013": "not-started", "STORY-015": "not-started",
    "STORY-009": "not-started", "STORY-010": "not-started", "STORY-016": "not-started",
    "STORY-011": "not-started", "STORY-012": "not-started"
  };
  sample.stories.forEach(function (s) { s.status = sampleStatusByStory[s.id] || "not-started"; });

  sample.guardrails[0].enforcedBy = "(sample) Request triage service — confidence-score check on intake";
  sample.guardrails[1].enforcedBy = null;
  sample.guardrails[2].enforcedBy = null;

  sample.owners.forEach(function (o) {
    o.skills = ["(sample) placeholder skill A", "(sample) placeholder skill B"];
  });

  sample.outcomes = [
    { id: "OUT-1", label: "(Sample) Advisor proposal turnaround", value: "22 min avg", target: "< 30 min (REQ-003)" },
    { id: "OUT-2", label: "(Sample) Portal adoption", value: "61% of customers", target: "no target set yet" },
    { id: "OUT-3", label: "(Sample) Flagged-request accuracy", value: "88% precision", target: "no target set yet" }
  ];

  sample.systems = [
    { id: "SYS-1", name: "(Sample) QuickBooks Online", purpose: "accounting sync — REQ-004", status: "unknown" },
    { id: "SYS-2", name: "(Sample) Amadeus / GDS", purpose: "flight & hotel inventory", status: "unknown" },
    { id: "SYS-3", name: "(Sample) Stripe", purpose: "customer payments — REQ-013", status: "unknown" }
  ];

  return sample;
}

var SAMPLE_DATA = buildSampleData(REAL_DATA);
