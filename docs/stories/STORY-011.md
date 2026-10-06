# STORY-011 — Process customer payments and track balances

As a customer, I want to make payments and track my balance, so that I can manage my travel expenses.

**Release:** r4 · Payments and Analytics (weeks 5–6)
**Owner:** Finance Manager
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-013** (Functional, must) — The system must allow customers to make payments and track their remaining balances.

## How to build it

Implement payment processing and balance tracking with integration to accounting software.

## Failure paths you must handle

- Payment failure
- Balance not updated
- Transaction not logged

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a payment is made, when processed, then the system updates the balance.
- [x] Given a payment fails, when retried, then the system processes it again or shows an error.
- [x] Trust: The system logs all payment transactions.

When every box above is ticked, stop and show the demo.

## How it was built (CC-20261005-q7v2)

- **What "balance" means here.** `bookTripService` charges the full trip price at
  booking, so a booking never has anything left to pay. A balance lives on a
  **payment account** instead: one per customer per trip, opened by the `finance`
  role with the total owed, paid down by the customer in instalments. The booking
  path is unchanged.
- **The balance is derived, never stored:** total minus succeeded payments,
  recomputed on every read (`services/payments/balanceLedger.js`).
- **Endpoints:** `POST /api/finance/payment-accounts`, `GET
  /api/finance/payment-accounts/:accountId`, `GET /api/portal/payments`, `POST
  /api/portal/payments/:accountId`.
- **Criterion 1:** `customerPaymentService.test.js` and `http/payments.test.js`
  (pay $1,500 of $5,000, read back $3,500).
- **Criterion 2:** a decline returns 402 with a message and `retryable: true`; a
  retry under the same `paymentId` is processed again - declined again (error) or
  approved (balance updated). The approved-on-retry half uses an injected
  processor, since the mock always declines `CUST-DECLINED`.
- **Trust:** every attempt that reaches the processor writes a
  `transaction.processed` audit entry before anything else; successes also post to
  the accounting software via STORY-004's `transactionRecorder`. Opening an account
  is audited as `payments.account.opened`.
- **Failure paths:** payment failure (402 / 502 on processor timeout, balance
  untouched); balance not updated (503, card charged - a retry finds the charge in
  the audit log and finishes it **without charging again**); transaction not
  logged (no audit, no accounting post - STORY-004's rule, reused).
