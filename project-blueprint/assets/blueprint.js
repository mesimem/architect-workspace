const BLUEPRINT = {
  meta: {
    title: "Boutique Travel Concierge",
    oneLiner: "An internal booking system where human travel agents manage client profiles, itineraries, marketing, and bookkeeping — with a dedicated orchestration service guaranteeing every supplier reservation and payment happens exactly once.",
    idea: "A boutique travel agency for niche/luxury clientele (adventure, honeymoon, luxury travelers), featuring safaris and cruises alongside flights, hotels, and tours. Human travel agents design and book curated trips on behalf of clients, and also handle marketing — drafting social media posts and using marketing insights and recommendations to grow the client base. Software exists to support and coordinate the human agents: client intake, preference/profile capture, itinerary building, supplier (flight/hotel/tour operator/cruise line/safari operator) coordination, payment/booking processing, marketing content support, and bookkeeping — not to replace agents with self-serve search or fully autonomous marketing. The one thing it must do well on day one: reliable booking — booking a flight, hotel, or package with a supplier must work correctly every single time, with no double-booking and no payment errors.",
    dayOne: "Reliable booking: no double-booking, no payment errors — every time."
  },

  components: [
    { name: "Agent Dashboard", kind: "frontend", sentence: "The web application travel agents use to manage clients, build itineraries, submit bookings, draft marketing posts, and view financial reports.", requiredBy: "the idea names “human travel agents” as the users of every function, so this stays one internal tool rather than separate apps." },
    { name: "Client & Itinerary Service", kind: "backend", sentence: "Owns client profiles, travel preferences, and the itineraries agents build for them, across every trip type including safaris and cruises.", requiredBy: "“client intake, preference/profile capture, itinerary building.”" },
    { name: "Booking Orchestration Service", kind: "backend", sentence: "Coordinates each booking as a single reliable transaction — checks whether it already ran, reserves with the supplier, charges the client, then records the booking as confirmed.", requiredBy: "“must work correctly every single time — no double-booking and no payment errors.” This is the component built specifically to guarantee the day-one requirement." },
    { name: "Marketing Content Service", kind: "ai", sentence: "AI-assisted drafting of social post copy and marketing insights/recommendations, for an agent to review and approve before anything publishes.", requiredBy: "“agents... do marketing with social media posts, marketing insights, recommendations.”" },
    { name: "Bookkeeping Service", kind: "backend", sentence: "Turns confirmed bookings, payments, and supplier commissions into invoices, revenue and expense records, and the reports agents view.", requiredBy: "“book keeping.”" },
    { name: "Agency Database", kind: "data", sentence: "A relational database storing client profiles, itineraries, bookings, and financial ledger entries, enforcing strict uniqueness and transactional guarantees.", requiredBy: "bookings and financial records both need strict rules like “never book the same seat twice.”" },
    { name: "Supplier APIs", kind: "external", sentence: "The external flight, hotel, tour-operator, cruise-line, and safari-operator booking systems the agency reserves inventory through.", requiredBy: "“supplier (flight/hotel/tour operator/cruise line/safari operator) coordination.”" },
    { name: "Payment Processor", kind: "external", sentence: "The external payment gateway that charges the client for a confirmed booking, once, correctly.", requiredBy: "“payment/booking processing.”" },
    { name: "Social Platforms", kind: "external", sentence: "The external social media platforms where approved posts publish, and where engagement data is pulled back from to feed marketing insights.", requiredBy: "“social media posts, marketing insights” — posts need somewhere to go and insights need real engagement data." }
  ],

  notComponents: [
    { thing: "Safaris & cruises", reason: "Handled as additional trip and supplier types inside the existing Client & Itinerary Service and Supplier APIs — no separate booking flow or data shape, so no separate component." }
  ],

  diagram: {
    mermaid: "flowchart TD\n" +
      "    TravelAgent([\"Travel Agent\"])\n" +
      "    AgentDashboard[\"Agent Dashboard\"]\n" +
      "    ClientItineraryService[\"Client & Itinerary Service\"]\n" +
      "    BookingOrchestrationService[\"Booking Orchestration Service\"]\n" +
      "    MarketingContentService[\"Marketing Content Service\"]\n" +
      "    BookkeepingService[\"Bookkeeping Service\"]\n" +
      "    AgencyDatabase[(\"Agency Database\")]\n" +
      "    SupplierAPIs{{\"Supplier APIs (flight / hotel / tour operator / cruise line / safari operator)\"}}\n" +
      "    PaymentProcessor{{\"Payment Processor\"}}\n" +
      "    SocialPlatforms{{\"Social Platforms\"}}\n" +
      "\n" +
      "    TravelAgent -->|\"logs in, manages a client\"| AgentDashboard\n" +
      "    AgentDashboard -->|\"submits client profile & preferences\"| ClientItineraryService\n" +
      "    ClientItineraryService -->|\"writes profile & itinerary\"| AgencyDatabase\n" +
      "\n" +
      "    AgentDashboard -->|\"submits booking request\"| BookingOrchestrationService\n" +
      "    BookingOrchestrationService -->|\"checks idempotency key\"| AgencyDatabase\n" +
      "    BookingOrchestrationService -->|\"reserves inventory\"| SupplierAPIs\n" +
      "    SupplierAPIs -->|\"reservation confirmation\"| BookingOrchestrationService\n" +
      "    BookingOrchestrationService -->|\"charges client\"| PaymentProcessor\n" +
      "    PaymentProcessor -->|\"payment confirmation\"| BookingOrchestrationService\n" +
      "    BookingOrchestrationService -->|\"writes confirmed booking (transaction)\"| AgencyDatabase\n" +
      "    BookingOrchestrationService -->|\"booking confirmation\"| AgentDashboard\n" +
      "    AgentDashboard -->|\"shows confirmation\"| TravelAgent\n" +
      "\n" +
      "    AgentDashboard -->|\"requests a post draft or insights\"| MarketingContentService\n" +
      "    MarketingContentService -->|\"reads client segment & trip preference data\"| AgencyDatabase\n" +
      "    MarketingContentService -->|\"pulls engagement & performance data\"| SocialPlatforms\n" +
      "    MarketingContentService -->|\"drafted post & recommendations\"| AgentDashboard\n" +
      "    AgentDashboard -->|\"agent approves post\"| MarketingContentService\n" +
      "    MarketingContentService -->|\"publishes approved post\"| SocialPlatforms\n" +
      "\n" +
      "    AgentDashboard -->|\"requests financial report\"| BookkeepingService\n" +
      "    BookkeepingService -->|\"reads bookings, payments & commissions\"| AgencyDatabase\n" +
      "    BookkeepingService -->|\"writes ledger entries\"| AgencyDatabase\n" +
      "    BookkeepingService -->|\"financial report\"| AgentDashboard\n",
    interpretation: "Three journeys share one backbone: booking always goes through the Booking Orchestration Service before touching the database, marketing always stops at the agent for approval before publishing, and bookkeeping only ever reads what booking already confirmed — nothing bypasses the Agency Database."
  },

  sequences: [
    {
      id: "booking",
      title: "Booking a trip",
      mermaid: "sequenceDiagram\n" +
        "    participant A as Travel Agent\n" +
        "    participant D as Agent Dashboard\n" +
        "    participant B as Booking Orchestration Service\n" +
        "    participant DB as Agency Database\n" +
        "    participant S as Supplier APIs\n" +
        "    participant P as Payment Processor\n" +
        "    A->>D: Submit booking request\n" +
        "    D->>B: Forward booking request\n" +
        "    B->>DB: Check idempotency key\n" +
        "    DB-->>B: No existing booking found\n" +
        "    B->>S: Reserve inventory\n" +
        "    S-->>B: Reservation confirmed\n" +
        "    B->>P: Charge client\n" +
        "    P-->>B: Payment confirmed\n" +
        "    B->>DB: Write confirmed booking (transaction)\n" +
        "    B-->>D: Booking confirmation\n" +
        "    D-->>A: Show confirmation\n",
      interpretation: "Nothing is written as “confirmed” until both the supplier and the payment processor have agreed — that ordering is the entire double-booking guarantee."
    },
    {
      id: "marketing",
      title: "Drafting & publishing a post",
      mermaid: "sequenceDiagram\n" +
        "    participant A as Travel Agent\n" +
        "    participant D as Agent Dashboard\n" +
        "    participant M as Marketing Content Service\n" +
        "    participant DB as Agency Database\n" +
        "    participant SP as Social Platforms\n" +
        "    A->>D: Request a post draft or insights\n" +
        "    D->>M: Forward request\n" +
        "    M->>DB: Read client segment & trip data\n" +
        "    M->>SP: Pull engagement & performance data\n" +
        "    M-->>D: Draft post + recommendations\n" +
        "    D-->>A: Show draft for review\n" +
        "    A->>D: Approve post\n" +
        "    D->>M: Approval\n" +
        "    M->>SP: Publish approved post\n",
      interpretation: "The service never publishes on its own — every post passes through an explicit agent-approval step before it reaches Social Platforms."
    },
    {
      id: "bookkeeping",
      title: "Generating a financial report",
      mermaid: "sequenceDiagram\n" +
        "    participant A as Travel Agent\n" +
        "    participant D as Agent Dashboard\n" +
        "    participant K as Bookkeeping Service\n" +
        "    participant DB as Agency Database\n" +
        "    A->>D: Request financial report\n" +
        "    D->>K: Forward request\n" +
        "    K->>DB: Read bookings, payments & commissions\n" +
        "    K->>DB: Write ledger entries\n" +
        "    K-->>D: Financial report\n" +
        "    D-->>A: Show report\n",
      interpretation: "Bookkeeping only ever reads what the Booking Orchestration Service already confirmed — it never creates or alters a booking, it just accounts for it."
    }
  ],

  buildOrder: {
    note: "Weeks below are relative sequencing and rough effort, not fixed calendar dates.",
    ganttMermaid: "gantt\n" +
      "    dateFormat  YYYY-MM-DD\n" +
      "    axisFormat  W%W\n" +
      "    title Build Order (relative sequencing)\n" +
      "    section Phase 1 - Reliable Booking Core\n" +
      "    Booking Core (make-or-break)   :crit, p1, 2026-01-05, 4w\n" +
      "    section Phase 2 - Bookkeeping\n" +
      "    Bookkeeping                    :p2, after p1, 2w\n" +
      "    section Phase 3 - Marketing\n" +
      "    Marketing                      :p3, after p2, 3w\n" +
      "    section Phase 4 - Supplier Breadth & Hardening\n" +
      "    Supplier Breadth & Hardening   :p4, after p3, 3w\n",
    phases: [
      {
        n: 1, name: "Reliable Booking Core", weeks: 4, critical: true,
        components: ["Agent Dashboard (minimal)", "Client & Itinerary Service", "Booking Orchestration Service", "Agency Database", "Supplier APIs (initial set)", "Payment Processor"],
        proves: "The day-one non-negotiable: a booking never double-books or double-charges, end to end against at least one real supplier and Stripe."
      },
      {
        n: 2, name: "Bookkeeping", weeks: 2, critical: false,
        components: ["Bookkeeping Service", "Agency Database (ledger tables)"],
        proves: "Confirmed bookings and payments translate into accurate, reviewable financial records without touching the booking guarantee."
      },
      {
        n: 3, name: "Marketing", weeks: 3, critical: false,
        components: ["Marketing Content Service", "Social Platforms integration", "Approval workflow in Agent Dashboard"],
        proves: "Agents can draft, review, and publish content — and that publishing never happens without an explicit approval step."
      },
      {
        n: 4, name: "Supplier Breadth & Hardening", weeks: 3, critical: false,
        components: ["Additional Supplier APIs (safaris, cruises)", "Manual-confirmation fallback", "Retries / circuit breaker"],
        proves: "The booking guarantee holds across the full supplier mix, including suppliers that can't be called programmatically."
      }
    ]
  },

  assumptions: [
    { text: "Agents operate from a single internal dashboard; there is no client-facing booking site.", impact: "Keeps day-one scope to one frontend. If clients later want self-serve browsing, a second read-only frontend would need to be added without touching the booking guarantees." },
    { text: "One shared Agency Database holds clients, itineraries, bookings, and the financial ledger, rather than separate databases per domain.", impact: "Simpler and cheaper to run at boutique-agency volume. If booking or financial volume grows substantially, the ledger tables may need to move to a separate store so one workload can't slow the other." },
    { text: "Marketing posts always go through agent approval before publishing; the Marketing Content Service never posts autonomously.", impact: "Protects brand voice and prevents an AI error from becoming a public post, at the cost of agents needing to review every draft — no fully hands-off marketing on day one." },
    { text: "Major suppliers (flights, hotels) expose a programmatic booking API; boutique safari and cruise operators may not.", impact: "The automatic “reserve, then confirm” guarantee only fully applies to API-connected suppliers. Non-API suppliers need a manual-confirmation state, or the no-double-booking guarantee silently doesn't cover them — see the open question." },
    { text: "Postgres transactions plus an idempotency-key table are sufficient to guarantee no double-booking at boutique-agency volume.", impact: "Keeps the Booking Orchestration Service simple. If booking volume grows or supplier calls need long asynchronous retries, this may need to become a dedicated workflow/orchestration layer." }
  ],

  notCovered: [
    "A client-facing website or app for travelers to browse or self-book trips.",
    "Loyalty programs, referral tracking, or multi-agency/franchise support.",
    "Multi-currency pricing or jurisdiction-specific tax/compliance handling beyond basic bookkeeping records.",
    "Real-time chat or messaging with clients.",
    "Automated, unsupervised marketing publishing (every post is agent-approved by design).",
    "A finished fallback flow for suppliers with no booking API — flagged as the open question below, not yet designed."
  ],

  openQuestion: {
    question: "Do all suppliers — especially boutique safari and luxury tour operators — actually expose a booking API, or do many require phone/email confirmation?",
    branchA: { label: "APIs available", detail: "The Booking Orchestration Service's automatic reserve-then-confirm flow, as designed, covers every supplier uniformly." },
    branchB: { label: "Manual confirmation required", detail: "The booking record needs an explicit “pending manual confirmation” state, an agent task to confirm it, and the no-double-booking guarantee shifts from system-enforced to system-enforced (API suppliers) plus process-enforced (agent discipline + a UI lock) for manual ones." }
  },

  techStack: [
    { component: "Agent Dashboard", tech: "React + Vite (TypeScript)", fit: "green", why: "This is a login-only tool for your own agents, not a public website, so you don't need the extra machinery (like search-engine optimization) that bigger frontend frameworks add.", prompt: "Explain React + Vite to me like I'm new to frontend frameworks, using my Boutique Travel Concierge Agent Dashboard as the example. What would the screens actually look like?" },
    { component: "Client & Itinerary Service", tech: "Node.js + Express (TypeScript)", fit: "green", why: "A straightforward service that saves and fetches client and itinerary records — this pairs naturally with a React frontend since both speak the same language (TypeScript).", prompt: "Explain Node.js and Express to me like I'm new to backend services, using my Client & Itinerary Service as the example. What would a “create itinerary” request look like end to end?" },
    { component: "Booking Orchestration Service", tech: "Node.js + Express (TypeScript), PostgreSQL transactions + idempotency-key table", fit: "yellow", why: "This is the piece that must never double-book or double-charge, so it checks “have I already done this booking?” before touching anything, using the database's ability to make several steps succeed or fail together as one unit.", prompt: "Explain database transactions and idempotency keys to me like I'm new to reliability engineering, using my Booking Orchestration Service as the example. Walk me through what happens if the payment step times out." },
    { component: "Marketing Content Service", tech: "Anthropic Claude API (Claude Sonnet 5)", fit: "green", why: "This drafts social posts and surfaces insights for an agent to review and approve — it never publishes on its own, which matches an AI tool you review rather than one you trust blindly.", prompt: "Explain the Claude API to me like I'm new to AI tools, using my Marketing Content Service as the example. How would I ask it to draft a post and get back something an agent can edit?" },
    { component: "Bookkeeping Service", tech: "Node.js + Express (TypeScript)", fit: "green", why: "It reads confirmed bookings and payments and turns them into ledger entries and reports — ordinary record-keeping logic, no special technology needed beyond what the rest of the backend already uses.", prompt: "Explain how a bookkeeping/reporting service is usually structured, using my Bookkeeping Service as the example. What would an invoice record look like in the database?" },
    { component: "Agency Database", tech: "PostgreSQL 16", fit: "green", why: "Client profiles, itineraries, bookings, and financial records all need strict rules (like “never book the same seat twice”) that this type of database is specifically built to enforce.", prompt: "Explain PostgreSQL to me like I'm new to databases, using my Boutique Travel Concierge as the example. What tables would I actually have, and how would the booking table prevent duplicates?" },
    { component: "Supplier APIs", tech: "Direct API integration per supplier (e.g. Duffel for flights), with a manual-confirmation fallback", fit: "red", why: "Major flight and hotel suppliers have modern booking APIs, but boutique safari and luxury tour operators very often don't — some still confirm bookings by phone or email, which the “reserve automatically” design doesn't account for.", prompt: "Explain what it takes to integrate with travel supplier APIs (flights, hotels, tour operators) to me like I'm new to third-party integrations, using my Boutique Travel Concierge as the example. What do I do about suppliers with no API at all?" },
    { component: "Payment Processor", tech: "Stripe", fit: "green", why: "Stripe is built to charge a client once and confirm it once, which is exactly the “no payment errors” guarantee this project's day-one requirement demands, and it keeps you out of the business of handling raw card numbers.", prompt: "Explain Stripe to me like I'm new to payment processing, using my Boutique Travel Concierge as the example. How would it plug into my Booking Orchestration Service so a retry never double-charges a client?" },
    { component: "Social Platforms", tech: "Meta Graph API (Facebook & Instagram)", fit: "yellow", why: "This is the one official way to publish approved posts and pull back engagement data from the two platforms your idea specifically names.", prompt: "Explain the Meta Graph API to me like I'm new to social media integrations, using my Marketing Content Service as the example. What does the approval-then-publish flow look like in practice?" }
  ],

  fitKey: [
    { fit: "green", label: "great fit", detail: "matches this idea's scale and needs well; no meaningful downside for a boutique agency running this internally." },
    { fit: "yellow", label: "good fit", detail: "works, but there's a real tradeoff worth knowing before you commit." },
    { fit: "red", label: "consider carefully", detail: "likely to cause friction because it doesn't fully match how this specific idea's suppliers actually operate." }
  ],

  techNotes: [
    "Agent Dashboard, Client & Itinerary Service, Booking Orchestration Service, and Bookkeeping Service are all recommended as one shared Node.js + TypeScript codebase style (even if split into separate deployable services later) — this keeps a small team from context-switching languages for what is, day one, a handful of internal-facing services.",
    "The red flag on Supplier APIs isn't a technology problem — no library fixes it. It's a process problem: the “reserve inventory” step needs a defined fallback (an agent manually confirms and marks the booking reserved) for any supplier that can't be called programmatically, or the “no double-booking” guarantee silently doesn't apply to those bookings.",
    "Least confident: the Booking Orchestration Service call — Postgres transactions plus an idempotency table is the simpler choice and fits a boutique agency's volume, but if booking volume grows or supplier calls start needing long asynchronous retries, this may need to become a dedicated workflow/orchestration layer later."
  ]
};

const SECTIONS = [
  { id: "summary", title: "Summary", file: "01-summary.html", desc: "The idea in one paragraph, and the one-line description.", countFn: function () { return "1 idea"; } },
  { id: "components", title: "Components", file: "02-components.html", desc: "What each piece is and why the idea needed it.", countFn: function () { return BLUEPRINT.components.length + " components"; } },
  { id: "architecture", title: "Architecture", file: "03-architecture.html", desc: "How the components connect, as a diagram.", countFn: function () { return BLUEPRINT.components.length + " nodes"; } },
  { id: "dataflow", title: "Data Flow", file: "04-data-flow.html", desc: "Step-by-step trace of booking, marketing, and bookkeeping.", countFn: function () { return BLUEPRINT.sequences.length + " flows"; } },
  { id: "buildorder", title: "Build Order", file: "05-build-order.html", desc: "The four phases, and what each proves.", countFn: function () { return BLUEPRINT.buildOrder.phases.length + " phases"; } },
  { id: "techstack", title: "Tech Stack", file: "06-tech-stack.html", desc: "Recommended technology per component, with fit and reasoning.", countFn: function () { return BLUEPRINT.techStack.length + " picks"; } },
  { id: "assumptions", title: "Assumptions & Scope", file: "07-assumptions.html", desc: "What we assumed, its impact, and what's deliberately not covered.", countFn: function () { return BLUEPRINT.assumptions.length + " deferred"; } }
];
