---
name: tech-stack-recommender
description: Use when the user has a system architecture and wants a recommended tech stack, explained simply.
---

# Tech Stack Recommender

Take an existing system architecture and recommend one real, current technology per component — rated for fit against this specific idea's actual scale and needs, explained in plain English, and paired with a copy-ready follow-up prompt.

## When this Skill applies

Trigger on requests like:
- "What tech stack should I use for this?"
- "Given this architecture, what should I actually build it with?"
- "Recommend technologies for each of these components."

Requires an existing architecture (from `/system-architect` or otherwise). If `project-blueprint/architecture.md` doesn't exist, tell the user to run `/system-architect` first rather than inventing components from scratch.

## Inputs

**`project-blueprint/architecture.md`** — required. Read it fully before recommending anything. Pull the component list and the project idea's stated scale (user base, data volume, budget, team size, latency needs) from it — recommendations must be grounded in what this file actually says, not a generic default stack.

## Procedure

### 1. Read the architecture

Read `project-blueprint/architecture.md`. Note for each component: what it does, what data it touches, and any scale signal in the "Project idea" section (e.g., "boutique agency," "millions of users," "internal tool," "day-one reliability requirement"). Scale signals drive the fit rating in step 3 — a component built for a boutique agency with a handful of agents has different needs than one built for a consumer app with millions of users.

### 2. Recommend one real technology per component

For every component in the diagram, pick one specific, real, currently-maintained technology (not a category like "a database" — name the actual product, e.g. "PostgreSQL," "Next.js," "Twilio SendGrid"). Do not recommend anything deprecated, end-of-life, or hypothetical.

### 3. Rate the fit against THIS idea

Every recommendation gets exactly one fit icon, judged against the scale and needs stated in *this* architecture.md — not against what's popular or what a generic checklist would say:

- 🟢 **great fit** — matches this idea's actual scale, budget, and needs well; no meaningful downside for this use case.
- 🟡 **good fit** — works fine here, but there's a real tradeoff worth knowing (cost at this scale, a simpler alternative exists, some added complexity).
- 🔴 **consider carefully** — likely overkill, underpowered, or mismatched for this idea's actual scale (e.g., a technology built for massive scale recommended for a small internal tool, or vice versa); say what the mismatch is.

A technology that would be 🟢 for a different idea can be 🔴 here — rate it against what this architecture.md actually describes, never against a generic default.

### 4. Write the "why" in plain English

One sentence per component, no unexplained jargon. If a technical term is unavoidable, define it inline in parentheses the first time it's used (e.g., "a vector database (a database built for AI similarity search)"). The sentence should make sense to someone who has never picked a tech stack before.

### 5. Add a copy-ready follow-up prompt

End every row with a prompt the user could literally copy and paste later to learn more about that specific technology, in the context of their own project. Pattern: `"Explain <technology> to me like I'm new to <category>, using my project as the example."` Adjust the category/framing per row so it reads naturally.

### 6. Assemble and save

Keep it scannable — icons and short labels, never a wall of text. Use a table, not prose paragraphs. Write the full result to `project-blueprint/tech-stack.md` with this structure:

```markdown
# Tech Stack: <project name, matching architecture.md>

## Recommended stack

| Component | Recommended tech | Fit | Why | Learn more |
|---|---|---|---|---|
| <Component name> | <Technology> | 🟢/🟡/🔴 | <one plain-English sentence> | `<copy-ready prompt>` |
| ... | ... | ... | ... | ... |

## Fit rating key
- 🟢 great fit — matches this idea's scale and needs well
- 🟡 good fit — works, but there's a tradeoff worth knowing
- 🔴 consider carefully — likely overkill or mismatched for this idea's actual scale

## Notes
<any cross-cutting call-outs, e.g. "these two components share the same database instance since both need transactional guarantees" — only include if genuinely useful, omit this section otherwise>
```

One row per component in the architecture diagram — don't skip components, don't add ones that aren't in architecture.md.

## Output

When finished, report back to the user:
1. The exact path the file was saved to (`project-blueprint/tech-stack.md`)
2. The fit-rating breakdown: count of 🟢, 🟡, and 🔴 across all rows
