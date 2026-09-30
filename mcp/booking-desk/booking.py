"""Booking logic for the Boutique Travel Concierge.

PORTED FROM: backend/src/services/booking/bookTripService.js (plus
paymentService.js and crmTransactionLog.js). That module is the origin of
these rules; if the booking rule changes there, it must change here too.
The duplication is a deliberate, logged tradeoff -- the JS has no HTTP route,
so a Python MCP server cannot reach it.

IDEMPOTENCY: this port takes an `idempotency_key`. It was added here first,
on 2026-08-28, because the JS origin had none -- its `nextTripId++` fired on
every call, so booking the same trip twice issued two trip IDs and charged
twice, violating the blueprint's day-one guarantee ("no double-booking, no
payment errors") and CLAUDE.md's idempotency rule. The JS has since been
brought into line in the same session and now requires the key too, so the
two implementations agree on: check the key first, replay an exact repeat,
reject key reuse with different arguments, and never memoize a declined
payment. ONE DELIBERATE DIFFERENCE: this side rejects a malformed key via the
published JSON schema before the body runs, so it has no
`invalid_idempotency_key` status; the JS has no schema layer and guards at
runtime instead. The key pattern itself is copied from
backend/src/services/africa/interactionLog.js.

Failure-first notes (CLAUDE.md requires these in writing):
  1. What happens if this fails? Every path returns a typed status
     (`invalid_customer`, `unavailable`, `payment_failed`,
     `idempotency_conflict`) rather than raising. Nothing is recorded as
     confirmed unless payment succeeded.
  2. Retry strategy? None here, by design. Every dependency is in-process,
     so there is nothing to back off from. When the real Supplier API and
     Stripe land, the retry and circuit-breaker layer belongs at those
     call sites, and a retry is safe precisely because of the key below.
  3. Recovery if exhausted? The caller retries with the SAME
     idempotency_key. A confirmed booking replays; a failed one re-runs.
  4. Handled vs not handled. HANDLED: blank/malformed customer, unavailable
     inventory, declined payment, exact replay, key reuse with different
     arguments. NOT HANDLED: concurrent calls racing on the same key (this
     is single-process, in-memory; a real deployment needs a unique
     constraint in Postgres), partial supplier failure, refunds/cancellation.
"""

from __future__ import annotations

import copy
import time
from collections.abc import Callable

# In-memory stand-ins, seeded identically to the JS origin so behaviour
# matches. A real inventory system and Stripe replace these later.
AVAILABILITY: dict[str, set[str]] = {
    "flights": {"FL-100"},
    "hotels": {"HT-200"},
    "safaris": {"SF-300"},
}

DECLINED_CUSTOMERS: frozenset[str] = frozenset({"CUST-DECLINED"})

# Idempotency store: key -> the confirmed booking it produced.
_BOOKINGS_BY_KEY: dict[str, dict] = {}
# Request fingerprint per key, so reusing a key with different arguments is
# caught instead of silently returning someone else's booking.
_FINGERPRINT_BY_KEY: dict[str, tuple] = {}
_TRANSACTION_LOG: list[dict] = []

_next_trip_number = 1


# An observer for the two supplier boundaries below, called as
# `emit(event_name, fields)`. Deliberately a plain callable and not an MCP
# Context: this module is the domain layer and must stay transport-agnostic,
# so the MCP server owns the decision of what a log line IS (level, wire
# format, correlation id) and this module only says WHAT HAPPENED and WHEN.
#
# Contract for anything passed here: `fields` carries identifiers, counts and
# durations only. Never a credential, never a raw customer record. The
# idempotency_key in particular is a capability -- whoever holds it can replay
# or wedge a booking -- so it is never handed to an emitter.
EmitFn = Callable[[str, dict], None]


def _no_emit(event: str, fields: dict) -> None:
    """Default observer: does nothing, costs nothing, never raises."""


def _process_payment(customer_id: str) -> tuple[bool, str | None]:
    """Mock processor, deterministic on customer_id. Mirrors paymentService.js."""
    if customer_id in DECLINED_CUSTOMERS:
        return False, "Payment could not be processed."
    return True, None


def _log_transaction(booking: dict) -> None:
    """Mirrors crmTransactionLog.js. Only confirmed bookings reach here."""
    _TRANSACTION_LOG.append(booking)


def book_trip(
    customer_id: str,
    flight_id: str,
    hotel_id: str,
    safari_id: str,
    idempotency_key: str,
    emit: EmitFn | None = None,
) -> dict:
    """Reserve inventory and charge the client, exactly once per idempotency_key.

    `emit` observes the two supplier boundaries (availability, payment). It is
    optional and defaults to a no-op, so this function's behaviour and return
    value are identical whether or not anyone is listening.
    """
    global _next_trip_number

    observe = emit or _no_emit

    fingerprint = (customer_id, flight_id, hotel_id, safari_id)

    # Idempotency is checked FIRST, before any validation or side effect --
    # the same ordering the blueprint's booking sequence diagram specifies.
    existing = _BOOKINGS_BY_KEY.get(idempotency_key)
    if existing is not None:
        if _FINGERPRINT_BY_KEY.get(idempotency_key) != fingerprint:
            return {
                "status": "idempotency_conflict",
                "message": (
                    "This idempotency_key was already used for a different "
                    "booking. Use a new key, or resend the original arguments."
                ),
                "replayed": False,
            }
        # Exact replay: hand back a copy of the original booking. No
        # second charge. Deep, so `legs` is not shared with the store.
        return dict(copy.deepcopy(existing), replayed=True)

    if not customer_id.strip():
        return {
            "status": "invalid_customer",
            "message": "Customer details are invalid.",
            "replayed": False,
        }

    # Supplier boundary 1: inventory. In-process today, a Supplier API call
    # when the stand-in above is replaced -- which is exactly why the timing
    # and the log boundary go here now rather than being retrofitted later.
    observe(
        "dependency.supplier_availability.started",
        {"flight_id": flight_id, "hotel_id": hotel_id, "safari_id": safari_id},
    )
    started_at = time.perf_counter()
    unavailable = (
        flight_id not in AVAILABILITY["flights"]
        or hotel_id not in AVAILABILITY["hotels"]
        or safari_id not in AVAILABILITY["safaris"]
    )
    observe(
        "dependency.supplier_availability.completed",
        {
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 3),
            "available": not unavailable,
        },
    )
    if unavailable:
        return {
            "status": "unavailable",
            "message": "One or more selections are not available.",
            "replayed": False,
        }

    # Supplier boundary 2: payment. `approved` is the only outcome recorded --
    # the decline reason is prose for the agent, and the card, the processor
    # token and the amount are none of a log stream's business.
    observe("dependency.payment.started", {"customer_id": customer_id})
    started_at = time.perf_counter()
    paid, decline_message = _process_payment(customer_id)
    observe(
        "dependency.payment.completed",
        {
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 3),
            "approved": paid,
        },
    )
    if not paid:
        # Deliberately NOT memoized against the key. A declined card is a
        # retryable condition -- the agent fixes payment and retries with the
        # same key. Storing it would wedge that key permanently.
        return {
            "status": "payment_failed",
            "message": decline_message,
            "replayed": False,
        }

    booking = {
        "status": "confirmed",
        "trip_id": f"TRIP-{_next_trip_number}",
        "customer_id": customer_id,
        "legs": {"flight_id": flight_id, "hotel_id": hotel_id, "safari_id": safari_id},
        "message": None,
    }
    _next_trip_number += 1

    _BOOKINGS_BY_KEY[idempotency_key] = booking
    _FINGERPRINT_BY_KEY[idempotency_key] = fingerprint
    _log_transaction(booking)

    return dict(copy.deepcopy(booking), replayed=False)


def current_availability() -> dict[str, list[str]]:
    """Sorted snapshot of bookable IDs. Sorted so the resource is stable."""
    return {category: sorted(ids) for category, ids in AVAILABILITY.items()}


def find_booking(trip_id: str) -> dict | None:
    """Read-only lookup of a confirmed booking by trip ID.

    STRICTLY READ-ONLY. Returns a DEEP copy. A shallow `dict(record)` is not
    enough: it shares the nested `legs` dict, so a caller could reach through
    the result and rewrite a stored booking's flight. Caught by testing the
    claim rather than assuming it.

    Scans the transaction log rather than maintaining a second index keyed by
    trip ID -- one store cannot drift out of sync with itself. Linear, which
    is fine at boutique-agency volume; a real deployment queries Postgres by
    primary key.
    """
    for booking in _TRANSACTION_LOG:
        if booking["trip_id"] == trip_id:
            return copy.deepcopy(booking)
    return None
