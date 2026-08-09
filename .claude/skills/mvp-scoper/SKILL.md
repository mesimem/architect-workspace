---
name: mvp-scoper
description: Use when the user wants to know what to build first, see what their idea could look like, and get a short pitch for it.
allowed-tools: Read, Write, Bash(*print-to-pdf*)
---

# MVP Scoper

Turn an existing architecture and tech stack into three concrete deliverables: a Week 1 build plan, a real-looking static mockup of the main screen, and a one-page PDF pitch. This is the "make it tangible" step after `/system-architect` and `/tech-stack-recommender` — it produces things a person can look at, not more analysis.

## When this Skill applies

Trigger on requests like:
- "What should I build first?"
- "Show me what this could look like."
- "Give me a quick pitch for this idea."
- "Scope the MVP for this."

Requires an existing architecture and tech stack. If `project-blueprint/architecture.md` or `project-blueprint/tech-stack.md` doesn't exist, tell the user to run `/system-architect` and `/tech-stack-recommender` first rather than inventing components or technologies from scratch.

## Inputs

- **`project-blueprint/architecture.md`** — required. Read fully. This is where the project name, the "Project idea" paragraph, the component list, and the day-one requirement (if the idea states one) come from.
- **`project-blueprint/tech-stack.md`** — required. Read fully. Every technology named in the mvp-plan checklist must come from this file — never invent a technology that isn't already recommended there.

## Procedure

### 1. Read both inputs fully

Pull: the project name, the one-paragraph idea, the component list with what each one does, and — critically — whatever the idea calls out as the thing that must work first (architecture.md's "Project idea" section often states this explicitly, e.g. "the one thing it must do well on day one"). That's the anchor for the Week 1 slice; don't pick a generic starting point when the idea already told you which risk matters most.

### 2. Write `project-blueprint/mvp-plan.md`

Follow `template.md` in this skill's directory exactly — same section order, same headings. Fill it in for this specific idea:

- The Week 1 slice is the smallest **working** path, end to end, through real components — not a UI shell, not a mocked backend. Every checklist item must name a specific component from architecture.md and the specific technology tech-stack.md recommends for it.
- Prefer the single riskiest or most core path the idea depends on (the day-one requirement, if one is stated) over breadth. A slice that proves one real transaction works end to end beats five half-built features.
- "What this slice deliberately skips" must list real components from architecture.md that are *not* in the Week 1 slice, with a one-line reason each (e.g. "Marketing Content Service — nothing to market until a booking exists").
- Keep every checklist line a single actionable task, short enough to read in one glance.

Write the file to `project-blueprint/mvp-plan.md`.

### 3. Build `project-blueprint/mockup.html`

A single self-contained HTML file — inline `<style>` in the `<head>`, no external stylesheets, fonts, or CDN scripts (it needs to open correctly with no network connection). It renders **one real screen**: the idea's landing page if the product is customer/public-facing, or its core internal app view (e.g. the main dashboard screen) if the idea is an internal tool — pick whichever architecture.md's components imply the primary user actually sees first.

Requirements, all mandatory:
- Real, idea-specific sample content: actual names, numbers, dates, and copy that fit *this* idea (e.g. real-sounding client names and trip destinations for a travel concierge, not "Client A" or "Lorem ipsum"). No lorem ipsum, no placeholder gray boxes, no "Item 1 / Item 2."
- A real visual design: a coherent color palette, spacing, typography hierarchy, and icons (inline SVG or Unicode/emoji glyphs — no external icon font). It should look like a page someone designed, not a wireframe.
- Layout appropriate to the screen type: a landing page needs a hero, value proposition, and a call to action; an internal dashboard needs real navigation and a real primary content area with sample data in it.
- Responsive enough to not visibly break at common widths, but this is a mockup, not a production build — don't over-engineer it.

Write the file to `project-blueprint/mockup.html`.

### 4. Build `project-blueprint/one-pager.pdf`

This is a marketing one-pager, not a technical spec: what it does, who needs it, one sentence on why it matters, using icons and short punchy lines. No architecture talk, no tech stack, no jargon from architecture.md/tech-stack.md — write it the way a pitch deck's first slide reads.

Steps:
1. Draft the copy: a headline, one sub-line stating who it's for, 3-4 short punchy value bullets (each with an icon/glyph), and one closing line on why it matters. Keep the whole thing skimmable in under 30 seconds.
2. Write this as a print-optimized single HTML file to a **temporary** path (use the session scratchpad, not `project-blueprint/`) with `@page { size: letter; margin: ... }` CSS so it renders as exactly one page — inline styles only, same self-contained rule as the mockup.
3. Locate an available headless-capable browser on this machine (Chrome, Chromium, or Edge — check the standard install path for the OS, or `chrome`/`chromium`/`msedge` on `PATH`). On this Windows environment, Chrome is installed at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
4. Run exactly **one** Bash command to convert the temp HTML to `project-blueprint/one-pager.pdf` via headless print-to-PDF, e.g.:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="project-blueprint/one-pager.pdf" "<temp-html-path>"
   ```
   Adjust the binary path/flags for whatever browser was actually found. This is the one and only Bash invocation this skill should need — it exists solely to drive print-to-PDF, nothing else.
5. Delete the temporary HTML file. The shipped deliverable is the PDF; never leave the intermediate `.html` behind and never substitute a renamed `.md`/`.html` for the PDF.

If no headless-capable browser is found, fall back to a Python (`reportlab`) or Node (`puppeteer`) script that generates a real PDF — but a real PDF file is the non-negotiable output either way, produced by an actual PDF-generation tool, not a text file with a `.pdf` extension.

### 5. Report

Confirm all three files were written and are non-empty before reporting done.

## Output

When finished, report back to the user:
1. Every file created, with its exact path
2. One line on what each file contains
3. Which tool actually generated the PDF (e.g. "headless Chrome print-to-PDF" — name the binary used)
