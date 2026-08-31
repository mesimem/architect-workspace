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
) -> dict:
    """Reserve inventory and charge the client, exactly once per idempotency_key."""
    global _next_trip_number

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

    unavailable = (
        flight_id not in AVAILABILITY["flights"]
        or hotel_id not in AVAILABILITY["hotels"]
        or safari_id not in AVAILABILITY["safaris"]
    )
    if unavailable:
        return {
            "status": "unavailable",
            "message": "One or more selections are not available.",
            "replayed": False,
        }

    paid, decline_message = _process_payment(customer_id)
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
