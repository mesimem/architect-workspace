# Claude.md — Retail Analytics Dashboard (Sample)

Project standards and conventions for the Retail Analytics Dashboard. This document defines how code should be written, named, and documented so that any contributor — human or AI — can work in this codebase consistently.

---

## 1. Project Overview

The Retail Analytics Dashboard is a web application that visualizes retail sales, inventory, and customer behavior data for store managers and regional executives. It consists of:

- **Frontend:** React + TypeScript dashboard (charts, tables, filters)
- **Backend:** Node.js/Express API serving aggregated retail metrics
- **Data layer:** SQL database storing transactions, inventory, and store metadata

---

## 2. Coding Conventions

### 2.1 General principles

- Prefer clarity over cleverness. Code is read far more often than it is written.
- Keep functions focused on a single responsibility. If a function needs a comment to explain what it does (not why), it should probably be split.
- Avoid premature abstraction. Duplicate small pieces of logic twice before extracting a shared helper.
- No dead code, commented-out blocks, or unused imports in merged code.

### 2.2 Language & style

- **TypeScript is required** for all new frontend and backend code. `any` is not allowed without an inline comment explaining why it's unavoidable.
- Run the linter and formatter (ESLint + Prettier) before committing. CI rejects unformatted code.
- Use `async/await` over raw Promise chains for readability.
- Avoid deeply nested conditionals (max 2–3 levels); use early returns/guard clauses instead.

### 2.3 File & module structure

- One React component per file; co-locate its styles and tests in the same folder.
- Group backend code by domain (`sales/`, `inventory/`, `stores/`) rather than by technical layer (`controllers/`, `services/` mixed across domains).
- Soft target: files under ~300 lines. Split when a file grows beyond that and mixes concerns.

### 2.4 Error handling

- Never silently swallow errors (`catch {}` with no handling is forbidden).
- Catch specific error types where possible; avoid catching generic `Error` in business logic.
- All external calls (API, database) must have explicit timeouts and a defined failure behavior (retry, fallback, or fail loud).

### 2.5 Testing

- Every new feature ships with at least a happy-path unit test.
- Critical calculations (e.g., revenue totals, inventory thresholds) require boundary-case tests (zero values, negative adjustments, missing data).
- UI changes should be verified manually in the browser in addition to type-checking.

---

## 3. Naming Standards

### 3.1 General rules

- Names should describe **what** something is or does, not how it's implemented.
- Avoid abbreviations unless they are domain-standard (e.g., `SKU`, `YTD` are fine; `qtyAdj` is not — use `quantityAdjustment`).
- Be consistent: don't mix `getX` and `fetchX` for the same kind of operation across the codebase.

### 3.2 Case conventions

| Element | Convention | Example |
|---|---|---|
| Variables & functions | `camelCase` | `calculateMonthlyRevenue` |
| React components | `PascalCase` | `SalesTrendChart` |
| Types & interfaces | `PascalCase` | `StoreMetrics` |
| Constants (fixed values) | `UPPER_SNAKE_CASE` | `MAX_RETRY_ATTEMPTS` |
| Files (components) | `PascalCase.tsx` | `InventoryTable.tsx` |
| Files (utilities/services) | `camelCase.ts` | `salesAggregator.ts` |
| Database tables/columns | `snake_case` | `store_transactions`, `unit_price` |
| API routes | `kebab-case` | `/api/sales-summary` |

### 3.3 Domain-specific naming

- Prefix booleans with `is`, `has`, or `should` (e.g., `isOutOfStock`, `hasPendingOrder`).
- Suffix async data-fetching hooks with `Query` or `Data` (e.g., `useSalesData`).
- Use full domain terms consistently: `store`, `SKU`, `transaction`, `region` — do not alias these with shorthand across modules (e.g., don't mix `loc` and `store` for the same concept).

---

## 4. Documentation Guidelines

### 4.1 Code-level documentation

- Write comments only when the **why** isn't obvious from the code itself (a workaround, a non-obvious business rule, a subtle edge case).
- Do not write comments that restate what the code already says.
- Public functions and exported types in shared modules should have a one-line doc comment describing their contract (inputs, outputs, and any side effects).

### 4.2 README requirements

Each top-level module (`frontend/`, `backend/`) must maintain a `README.md` covering:

- Purpose of the module
- How to run it locally (setup, environment variables, start command)
- How to run its tests
- Any non-obvious architectural decisions

### 4.3 API documentation

- Every API endpoint documents: method, path, request parameters/body shape, response shape, and possible error codes.
- Breaking changes to a response shape must be called out explicitly in the PR description and in the endpoint's documentation.

### 4.4 Change documentation

- Non-trivial changes should include a short PR description covering: what changed, why, and how it was verified (tests run, manual check, screenshot).
- Significant architectural or data-model changes should be recorded in a `CHANGELOG.md` or equivalent decision log so future contributors understand the reasoning, not just the current state.

### 4.5 Keeping docs current

- Documentation is updated in the same PR as the code change it describes — never as a follow-up "someday" task.
- Outdated documentation is treated as a defect, not a low-priority cleanup item.

---

## 5. Summary

- Write code that is clear, small, and testable.
- Name things consistently so intent is obvious without cross-referencing other files.
- Document the *why*, not the *what* — the code already explains the what.
- Treat tests and docs as part of the deliverable, not optional extras.
