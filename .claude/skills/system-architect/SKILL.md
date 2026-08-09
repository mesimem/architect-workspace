---
name: system-architect
description: Use when the user has a project idea and wants a system architecture, a technical design, or a diagram of how it would work.
---

# System Architect

Turn a one-paragraph project idea into a concrete system architecture: the real components the idea needs, a Mermaid diagram of how they connect and how data flows, and a plain-English explanation of each component.

## When this Skill applies

Trigger on requests like:
- "Here's my idea — can you design the architecture for it?"
- "What would the system design look like for X?"
- "Give me a diagram of how this app would work."

Do **not** trigger for requests to review or fix an *existing* codebase's architecture (that's exploration/refactoring, not blueprinting) or for infra/deploy questions unrelated to a new project idea.

## Inputs

**Project idea** — required. A one-paragraph (or shorter) description of what the user wants to build. If the user hasn't given one yet, ask for it before proceeding. Do not invent the idea; work only from what they actually said.

## Procedure

### 1. Extract the real requirements from the idea

Read the idea closely and identify, from its actual content — not from a generic template:
- Who uses it and how (web app? mobile? API consumed by other services? internal tool?)
- What data it needs to store or process, and whether that data is structured, unstructured, high-volume, sensitive, or real-time
- Whether it needs to talk to external services (payments, auth providers, maps, email, third-party APIs)
- Whether it involves AI/agent behavior (LLM calls, embeddings, RAG, autonomous decisioning) — only include an AI/agent layer if the idea actually implies one
- Any explicit constraints the user stated (scale, latency, compliance, budget, preferred stack)

If the idea is too vague to identify real components (e.g., it never says who uses it or what data is involved), ask one targeted clarifying question rather than guessing a generic web-app shape.

### 2. Identify components

Build the component list from what step 1 surfaced. Typical categories to consider — include only the ones the idea actually calls for, and name them specifically (not "Backend" but "Order Processing API"):
- **Frontend** — what the user-facing surface actually is (web dashboard, mobile app, chat widget, CLI, none)
- **Backend / API** — the service(s) that own business logic
- **Database** — pick a type that fits the data shape described (relational, document, vector, time-series, cache) rather than defaulting to "a database"
- **External services** — named third-party integrations the idea implies (payment processor, email/SMS provider, OAuth provider, maps, etc.)
- **AI / agent layer** — only if the idea involves generation, reasoning, retrieval, or autonomous action; specify what it does (e.g., "LLM-based summarizer," "RAG retrieval over support docs")
- **Infrastructure/other** — queues, background workers, file storage, CDN — only if the idea's data flow requires them

Do not pad the list with components the idea doesn't need. A simple idea should produce a simple architecture.

### 3. Produce the Mermaid diagram

Write a genuine `flowchart` (not a placeholder) showing:
- Each identified component as a node
- Directional edges showing actual data/request flow between them (e.g., "user submits form" → "API validates" → "writes to DB")
- Labels on edges where the flow isn't self-evident (e.g., `-->|API call|`, `-->|writes|`, `-->|async job|`)

The diagram must reflect the specific idea's flow — trace at least one full request/response or data-processing path through it end to end.

### 4. Explain each component

For every node in the diagram, write one plain-English sentence describing what it does and why the idea needs it — written so a non-technical stakeholder can follow it. No jargon without a plain-language gloss (e.g., "a vector database (a database built for AI similarity search)").

### 5. Assemble and save

Write the full result to `project-blueprint/architecture.md` (create the `project-blueprint/` directory if it doesn't exist) with this structure:

```markdown
# Architecture: <short project name>

## Project idea
<the one-paragraph idea as given, or as clarified>

## Components
- **<Component name>** — <one plain-English sentence>
- ...

## Architecture diagram

​```mermaid
flowchart TD
    ...
​```

## Data flow walkthrough
<short prose trace of the primary path through the diagram, step by step>
```

## Output

When finished, report back to the user:
1. The exact path the file was saved to (`project-blueprint/architecture.md`)
2. The final one-line description of the architecture
3. The component list identified
