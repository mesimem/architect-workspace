# data-quality-gate Trigger Tests

Manual test prompts for verifying the `data-quality-gate` Skill triggers on data-validation / publish-readiness requests and stays silent on ordinary SQL, dashboard-design, and metric-calculation requests.

## Should trigger

1. "Before this data feeds the executive revenue dashboard, validate skill-lab/orders.csv against skill-lab/quality-contract.md. Tell me whether I should PUBLISH or BLOCK the dataset."
2. "Can you run a quality check on this ETL output before we load it? File is exports/nightly_orders.csv."
3. "Is skill-lab/orders.csv safe to publish? Check it for duplicates, nulls, and freshness first."

## Should NOT trigger

1. "Write a SQL query that sums revenue by region from the orders table."
2. "Design a layout for the executive revenue dashboard — I want a KPI row up top and a trend chart below."
3. "How do we calculate month-over-month revenue growth for this dataset?"

## Expected output requirements

**When triggered**, the response must:
- Read the dataset without modifying, moving, or deleting it
- Use the quality contract if one is found or supplied; if none, fall back to `references/quality-checks.md` defaults and state explicitly that no contract was supplied
- Present results as a single table: `Check | Evidence | Status | Recommended Action`
- Every `Status` must be traceable to evidence actually observed in the data — no fabricated counts or row references
- End with exactly two closing lines: an **Overall result** (PASS / WARN / FAIL) and a **Recommendation** (PUBLISH / BLOCK), following the escalation logic in `SKILL.md` (any FAIL → overall FAIL; FAIL or a correctness-critical WARN → BLOCK)
- Stay procedural — no editorializing beyond the table and the two closing lines

**When not triggered**, the response must:
- Address the SQL, dashboard-design, or metric-calculation request directly, on its own terms
- Not produce a PASS/WARN/FAIL table or a PUBLISH/BLOCK recommendation
- Not read `SKILL.md` or `references/quality-checks.md` as part of answering
