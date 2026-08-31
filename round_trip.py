"""
round_trip.py — ONE complete Claude tool-use round trip, printed step by step.

Project: U.S.-based Full-Service Travel Agency Platform — answers traveler
questions about the status of a booked trip.

One question. One tool. One round trip. The six labelled sections below are
the entire mechanic of tool use; nothing else is hidden.

Run:  python round_trip.py
Needs: ANTHROPIC_API_KEY in the environment or in .env (never committed).
"""

import json
import os
from pathlib import Path

import anthropic

MODEL = "claude-opus-5"  # or claude-sonnet-5 / claude-haiku-4-5

# Fixed "today" so the balance-due reasoning is reproducible across runs.
TODAY = "2026-08-25"


# ---------------------------------------------------------------------------
# Credentials: load .env into the environment if the var isn't already set.
# No new dependency — a .env file is just KEY=VALUE lines.
# ---------------------------------------------------------------------------
def load_dotenv(path: Path = Path(__file__).parent / ".env") -> None:
    if os.environ.get("ANTHROPIC_API_KEY") or not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip().removeprefix("export ")
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def banner(n: int, title: str) -> None:
    print(f"\n{'=' * 72}\n[{n}] {title}\n{'=' * 72}")


# ---------------------------------------------------------------------------
# THE DATA SOURCE. A plain dictionary standing in for the bookings table.
# One confirmed safari itinerary with a balance outstanding, and one trip
# still waiting on a supplier — the two states agents field calls about.
# ---------------------------------------------------------------------------
BOOKINGS = {
    "TZ-4471": {
        "status": "confirmed",
        "lead_traveler": "Whitfield",
        "party_size": 2,
        "destination": "Tanzania (Arusha / Serengeti / Ngorongoro)",
        "depart": "2026-10-12",
        "return": "2026-10-23",
        "components": [
            {
                "type": "air",
                "detail": "JFK-AMS-JRO, KLM 644 / 569",
                "supplier": "KLM",
                "supplier_ref": "K7QP2M",
                "status": "ticketed",
            },
            {
                "type": "lodge",
                "detail": "Serengeti Migration Camp, 4 nights, full board",
                "supplier": "Elewana Collection",
                "supplier_ref": "ELE-88214",
                "status": "confirmed",
            },
            {
                "type": "safari",
                "detail": "7-day private game drive, English-speaking guide, 4x4",
                "supplier": "Asilia Safaris",
                "supplier_ref": "ASL-30977",
                "status": "confirmed",
            },
            {
                "type": "transfer",
                "detail": "JRO airport to Arusha hotel, private",
                "supplier": "Asilia Safaris",
                "supplier_ref": "ASL-30977-T",
                "status": "confirmed",
            },
        ],
        "payment": {
            "currency": "USD",
            "trip_total": 18450.00,
            "paid_to_date": 5535.00,
            "balance_due": 12915.00,
            "balance_due_date": "2026-08-29",
        },
        "documents": {
            "e_tickets": "issued",
            "lodge_vouchers": "issued",
            "final_itinerary": "released_on_full_payment",
        },
        "traveler_actions": [
            "Passport must be valid through 2027-04-23 (6 months past return).",
            "Tanzania eVisa not yet submitted for either traveler.",
            "Yellow fever certificate required for the Serengeti leg.",
        ],
    },
    "CR-2280": {
        "status": "pending_supplier",
        "lead_traveler": "Okonjo",
        "party_size": 4,
        "destination": "Costa Rica (Arenal / Manuel Antonio)",
        "depart": "2026-12-19",
        "return": "2026-12-28",
        "components": [
            {
                "type": "air",
                "detail": "IAD-SJO, United 1229",
                "supplier": "United",
                "supplier_ref": "UA55TKQ",
                "status": "ticketed",
            },
            {
                "type": "hotel",
                "detail": "Nayara Springs, 4 nights",
                "supplier": "Nayara Resorts",
                "supplier_ref": None,
                "status": "awaiting_confirmation",
            },
        ],
        "payment": {
            "currency": "USD",
            "trip_total": 11200.00,
            "paid_to_date": 11200.00,
            "balance_due": 0.00,
            "balance_due_date": None,
        },
        "documents": {
            "e_tickets": "issued",
            "lodge_vouchers": "pending",
            "final_itinerary": "pending",
        },
        "traveler_actions": [],
    },
}


# ---------------------------------------------------------------------------
# MY FUNCTION. Ordinary Python. The model never runs this — I do.
# Read-only: no side effects, safe to call twice (CLAUDE.md idempotency rule).
# ---------------------------------------------------------------------------
def lookup_booking(booking_reference: str, last_name: str | None = None) -> dict:
    booking = BOOKINGS.get(booking_reference.strip().upper())
    if booking is None:
        return {
            "found": False,
            "reason": f"No booking {booking_reference} on file.",
        }
    if last_name and last_name.strip().lower() != booking["lead_traveler"].lower():
        return {
            "found": False,
            "reason": "Last name does not match the lead traveler on this booking.",
        }
    return {
        "found": True,
        "booking_reference": booking_reference.strip().upper(),
        "as_of": TODAY,
        **booking,
    }


# ---------------------------------------------------------------------------
# THE TOOL SCHEMA. `description` is the field the model reads to decide
# WHEN to call this, so it states the trigger conditions explicitly.
# ---------------------------------------------------------------------------
LOOKUP_BOOKING_TOOL = {
    "name": "lookup_booking",
    "description": (
        "Look up one travel booking by its booking reference: trip status, "
        "each booked component and its supplier confirmation, the payment "
        "schedule and balance due, document status, and any outstanding "
        "traveler action items such as visas or passport validity. Call this "
        "whenever the traveler asks whether their trip is confirmed, what is "
        "still owed or when payment is due, when documents will be issued, "
        "what is included in the itinerary, or mentions a booking reference. "
        "Never state a trip status, dollar amount, or due date without "
        "calling this tool first."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "booking_reference": {
                "type": "string",
                "description": "The booking reference, e.g. 'TZ-4471'.",
            },
            "last_name": {
                "type": "string",
                "description": (
                    "Last name of the lead traveler, used to verify the caller. "
                    "Only pass this if the traveler supplied it."
                ),
            },
        },
        "required": ["booking_reference"],
    },
}

SYSTEM = (
    "You are the traveler support assistant for a U.S.-based full-service "
    f"travel agency. Today is {TODAY}. Be warm, brief, and concrete. Never "
    "state a trip status, price, balance, or deadline you have not looked up "
    "with a tool. Flag anything the traveler must act on themselves."
)

QUESTION = (
    "Hi, this is Dana Whitfield — booking TZ-4471. Is everything actually "
    "confirmed for our Tanzania trip in October, and do we still owe you "
    "anything?"
)


def main() -> None:
    load_dotenv()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY not found in the environment or .env")

    client = anthropic.Anthropic()

    # The conversation. The API is stateless: this list is the only memory,
    # and it is resent in full on every request.
    messages = [{"role": "user", "content": QUESTION}]

    request = {
        "model": MODEL,
        "max_tokens": 16000,
        "system": SYSTEM,
        "tools": [LOOKUP_BOOKING_TOOL],  # the schema rides along on the request
        "messages": messages,
    }

    banner(1, "THE REQUEST I SENT  (POST /v1/messages)")
    print(json.dumps(request, indent=2))

    response = client.messages.create(**request)

    banner(2, "stop_reason THAT CAME BACK")
    print(f"    stop_reason = {response.stop_reason!r}")
    print("    'tool_use' means: the model stopped early to ask me for something.")

    if response.stop_reason != "tool_use":
        banner(6, "FINAL ANSWER (no tool was requested)")
        print(next(b.text for b in response.content if b.type == "text"))
        return

    tool_use = next(b for b in response.content if b.type == "tool_use")

    banner(3, "THE tool_use BLOCK  (arguments the model filled in)")
    print(json.dumps(tool_use.model_dump(), indent=2))
    print(f"\n    id    -> {tool_use.id}   (I must echo this back)")
    print(f"    name  -> {tool_use.name}   (which of my functions to run)")
    print(f"    input -> {tool_use.input}  (already parsed, not a string)")

    banner(4, "WHERE MY FUNCTION EXECUTES  (my process, my data)")
    print(f"    calling lookup_booking(**{tool_use.input})")
    result = lookup_booking(**tool_use.input)  # <-- MY CODE RUNS HERE
    print(f"    returned {len(json.dumps(result))} chars of booking JSON")
    print(f"    found={result['found']}  status={result.get('status')}  "
          f"balance_due={result.get('payment', {}).get('balance_due')}")

    # Append the model's whole turn, then my result as a new user turn.
    messages.append({"role": "assistant", "content": response.content})
    tool_result_block = {
        "type": "tool_result",
        "tool_use_id": tool_use.id,  # ties this answer to that request
        "content": json.dumps(result),
    }
    messages.append({"role": "user", "content": [tool_result_block]})

    banner(5, "THE tool_result I SEND BACK")
    print(json.dumps({"role": "user", "content": [tool_result_block]}, indent=2))
    print(f"\n    tool_use_id {tool_result_block['tool_use_id']} == tool_use.id above")

    final = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        tools=[LOOKUP_BOOKING_TOOL],  # same tool list, every turn
        messages=messages,
    )

    banner(6, "THE FINAL ANSWER")
    print(f"    stop_reason = {final.stop_reason!r}  (done — no more tools wanted)\n")
    for block in final.content:
        if block.type == "text":
            print(block.text)


if __name__ == "__main__":
    main()
