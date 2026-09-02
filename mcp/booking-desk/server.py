"""booking-desk — MCP server over the Boutique Travel Concierge booking flow.

Publishes exactly three surfaces, one per primitive, each chosen for who is
allowed to initiate it:

  tool      book_trip                      -> model-initiated, gated by the
                                              host's approval prompt, because
                                              it reserves inventory and moves
                                              money.
  resource  travel://availability/current  -> application-initiated. Read-only
                                              inventory the app pins into
                                              context so the model knows what
                                              is bookable before attempting.
  prompt    confirm-booking                -> user-initiated. The named
                                              workflow an agent picks from the
                                              dashboard to book with a client.

Fills the gap that backend/src/services/booking/bookTripService.js is
`module.exports` only -- no route exists anywhere in the repo, so nothing
outside Node can book a trip.

LOGGING: this server declares the `logging` capability and emits structured
`notifications/message` lines -- objects with a stable `event` name and one
`correlation_id` per tool invocation, never formatted sentences. Payloads
carry identifiers, counts and durations only; the idempotency_key appears as
an 8-hex fingerprint and never in full. Event vocabulary and the two
deprecation caveats are documented at the "Structured logging" block below.

STDIO transport:  uv run server.py
Inspector:        uv run mcp dev server.py:server
                  (set a log level in the Inspector to see the log lines: at
                  protocol 2026-07-28+ the server MUST NOT send until the
                  client opts in per request)

NOTE: stdout belongs to the JSON-RPC protocol on STDIO transport. Never
print() in this file -- a stray print corrupts the message stream. Send
diagnostics to stderr.
"""

# DO NOT add `from __future__ import annotations` to this file. It turns every
# annotation into a string, and both @server.tool and @server.prompt hand this
# module's functions to Pydantic, which resolves those strings against
# `sys.modules[func.__module__]`. `mcp dev` loads the file via importlib as
# "server_module" WITHOUT registering it in sys.modules, so the lookup misses,
# the namespace comes back empty, and decoration dies with
# `NameError: name 'Annotated' is not defined` -- while `python server.py`
# keeps working, because there the module is `__main__` and is registered.
# Every annotation used here (`str | None`, `list[...]`) is native on the
# Python this project requires, so the import buys nothing.

import hashlib
import json
import time
import uuid
from typing import Annotated, Any, Literal

from mcp.server import MCPServer, ServerRequestContext
from mcp.server.mcpserver import Context
from mcp.types import EmptyResult, LoggingLevel, SetLevelRequestParams, ToolAnnotations
from pydantic import BaseModel, Field

import booking
from strict_arguments import declared_arguments, make_strict_arguments_middleware

# MCPServer is this SDK's name for what older docs call FastMCP; mcp>=2.0
# renamed the class. Same decorator-based server.
server = MCPServer("booking-desk")

# The `travel://` scheme names the business domain. This is agency data, not a
# file to read or a page to fetch, so `file://` or `https://` would both
# misdescribe it and imply a transport that is not involved.
AVAILABILITY_URI = "travel://availability/current"
BOOKING_URI_TEMPLATE = "travel://bookings/{trip_id}"

# ---------------------------------------------------------------------------
# Structured logging
#
# The capability is declared by registering a `logging/setLevel` handler,
# because that registration is the ONLY thing the SDK looks at when it builds
# ServerCapabilities: `get_capabilities()` sets `logging=LoggingCapability()`
# if and only if "logging/setLevel" is in its request-handler map. Without the
# handler the `logging` key is simply absent from the initialize response, the
# client is entitled to discard every notifications/message we send, and
# nothing anywhere raises -- verified against this server before the change,
# whose initialize reply advertised only prompts/resources/tools.
#
# CAVEAT, matching the one in strict_arguments.py: `_lowlevel_server` is not
# public API. MCPServer exposes no supported hook for a `logging/setLevel`
# handler in mcp 2.1.0, and the alternative -- shipping a logging capability we
# do not actually serve -- is worse. Revisit if a public hook lands.
#
# SECOND CAVEAT, and the sharper one: the MCP logging capability is DEPRECATED
# as of protocol 2026-07-28 (SEP-2577), and this SDK marks `Context.log` and
# every level helper with MCPDeprecationWarning. At 2026-07-28+ delivery also
# became a per-request opt-in -- the SDK sends nothing unless the client put
# `io.modelcontextprotocol/logLevel` in the request's `_meta`. On handshake-era
# versions every level is deliverable and the threshold below is ours to apply.
# So this code is correct on both eras but silent on the newest one unless the
# client opts in -- see the Inspector note in the module docstring above.
#
# EVENT VOCABULARY (the complete set; keep this list and the code in step):
#   tool.book_trip.started                       info
#   tool.book_trip.completed                     info
#   tool.book_trip.failed                        error   (+ error_class)
#   dependency.supplier_availability.started     info
#   dependency.supplier_availability.completed   info    (+ duration_ms)
#   dependency.payment.started                   info
#   dependency.payment.completed                 info    (+ duration_ms)
#   booking.denied                               warning (+ reason)
#   booking.replayed                             info
# ---------------------------------------------------------------------------

LOGGER_NAME = "booking-desk"

# Ordered by increasing severity, exactly as the MCP LoggingLevel literal is.
_LOG_LEVELS: tuple[LoggingLevel, ...] = (
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
)

# The client's requested floor, moved by `logging/setLevel`. Connection-scoped
# rather than per-request because that is what the handshake-era capability is:
# one level for the session. "info" keeps `.started` boundary lines (debug) off
# the wire until someone asks for them.
_min_log_level: LoggingLevel = "info"


async def _set_log_level(
    request_ctx: ServerRequestContext[Any],
    params: SetLevelRequestParams,
) -> EmptyResult:
    """Serve `logging/setLevel`, which is also what declares the capability.

    This is a real handler, not a stub to light up the capability flag: on
    handshake-era protocol versions the SDK delivers every level and states
    that filtering is the application's job, so dropping below-threshold
    events in `_emit` is the other half of honouring this request.
    """
    global _min_log_level
    _min_log_level = params.level
    return EmptyResult()


server._lowlevel_server.add_request_handler(
    "logging/setLevel", SetLevelRequestParams, _set_log_level
)


def _fingerprint(secret: str) -> str:
    """A short, stable, non-reversible stand-in for a sensitive value.

    Used for `idempotency_key`, which is a CAPABILITY, not a name: whoever
    holds it can replay a booking or wedge that key. It still has to be
    correlatable across log lines -- "did these two attempts share a key?" is
    the first question anyone asks about a double-charge -- so it is logged as
    8 hex of its SHA-256 and never in full.
    """
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:8]


def _elapsed_ms(started_at: float) -> float:
    """Milliseconds since a `time.perf_counter()` reading, to 3 decimals.

    perf_counter, not the wall clock: it is monotonic, so a duration cannot
    come out negative because NTP stepped the clock mid-booking.
    """
    return round((time.perf_counter() - started_at) * 1000, 3)


async def _emit(
    ctx: Context | None,
    level: LoggingLevel,
    event: str,
    correlation_id: str,
    **fields: Any,
) -> None:
    """Send one structured log line to the client.

    `data` is always an OBJECT with a stable `event` name and the correlation
    id, never a preformatted sentence -- a sentence is readable once and
    unsearchable ten thousand times.

    No-ops when there is no Context, i.e. when the function is called directly
    in a test rather than through a live request. Never raises: a logging
    failure must not fail a booking that actually succeeded.
    """
    if ctx is None:
        return
    if _LOG_LEVELS.index(level) < _LOG_LEVELS.index(_min_log_level):
        return
    try:
        await ctx.log(
            level=level,
            data={"event": event, "correlation_id": correlation_id, **fields},
            logger_name=LOGGER_NAME,
        )
    except Exception:  # noqa: BLE001 -- see docstring: logging must not break booking.
        # Swallowed deliberately and narrowly: this is the one place in this
        # repo where dropping an error is correct, because the alternative is
        # failing a confirmed, already-charged booking to report a log problem.
        # Nothing else in this module catches broadly.
        pass


class TripLegs(BaseModel):
    """The three suppliers a trip reserves against."""

    flight_id: str
    hotel_id: str
    safari_id: str


class BookingResult(BaseModel):
    """Outcome of a booking attempt.

    `status` is the whole contract -- callers branch on it rather than on
    the prose in `message`. `trip_id` is populated only when confirmed.
    """

    status: Literal[
        "confirmed",
        "invalid_customer",
        "unavailable",
        "payment_failed",
        "idempotency_conflict",
    ]
    trip_id: str | None = None
    customer_id: str | None = None
    legs: TripLegs | None = None
    message: str | None = None
    replayed: bool = Field(
        description=(
            "True when this idempotency_key had already produced this booking "
            "and the original was returned instead of charging again."
        )
    )


@server.tool(
    annotations=ToolAnnotations(
        title="Book a trip",
        read_only_hint=False,
        # Not destructive: a replay is safe and nothing is overwritten. But
        # not idempotent_hint=True either -- that would tell a client a fresh
        # call is always free, and a call with a NEW key does charge.
        destructive_hint=False,
        idempotent_hint=False,
        open_world_hint=False,
    )
)
async def book_trip(
    customer_id: Annotated[
        str,
        Field(
            min_length=1,
            max_length=64,
            pattern=r"^CUST-[A-Z0-9-]{1,58}$",
            description="The client's ID, e.g. 'CUST-1042'.",
        ),
    ],
    # Lengths are stated as well as the pattern. The regex already implies
    # 6-9 characters ("FL-" plus 3-6 digits), but minLength/maxLength are what
    # a client actually sees in the published schema, so they are declared
    # rather than left implicit.
    flight_id: Annotated[
        str,
        Field(
            min_length=6,
            max_length=9,
            pattern=r"^FL-\d{3,6}$",
            description="Flight to reserve, e.g. 'FL-100'.",
        ),
    ],
    hotel_id: Annotated[
        str,
        Field(
            min_length=6,
            max_length=9,
            pattern=r"^HT-\d{3,6}$",
            description="Hotel to reserve, e.g. 'HT-200'.",
        ),
    ],
    safari_id: Annotated[
        str,
        Field(
            min_length=6,
            max_length=9,
            pattern=r"^SF-\d{3,6}$",
            description="Safari to reserve, e.g. 'SF-300'.",
        ),
    ],
    idempotency_key: Annotated[
        str,
        Field(
            min_length=8,
            max_length=128,
            description=(
                "A key unique to THIS booking attempt, reused across retries "
                "of it. Mint one new key per trip the client agrees to. "
                "Retrying with the same key returns the original booking "
                "instead of charging again; a new key books and charges again."
            ),
        ),
    ],
    # Injected by the SDK, recognized by the `Context` annotation, and kept out
    # of the published input schema -- so this is not a change to the tool's
    # client-visible contract. `declared_arguments` in strict_arguments.py
    # excludes it explicitly; see the docstring there for why that matters.
    ctx: Context | None = None,
) -> BookingResult:
    """Reserve a flight, hotel and safari for a client and charge them, exactly once.

    Call this only after the client has agreed to the specific trip. It moves
    real money -- it is not a way to check whether something is bookable. To
    see what is bookable, read the resource travel://availability/current.

    All three legs are required; this agency books them as one package.

    Retrying is safe as long as you reuse the same idempotency_key: the
    original booking comes back with replayed=true and the client is not
    charged twice. Never mint a fresh key just to retry a call that timed out
    -- that is how a client gets double-charged.

    Read `status` to know what happened. On 'unavailable' the selections are
    not bookable -- re-read the availability resource rather than guessing
    another ID. On 'payment_failed' the card was declined; the agent resolves
    payment and retries with the SAME key. On 'idempotency_conflict' the key
    was already used for a different trip; mint a new one.
    """
    # ONE id per invocation, minted here and stamped on every line below,
    # including the two supplier boundaries inside booking.py. This is what
    # makes the log stream traceable instead of merely verbose: at 2 AM you
    # grep one id and get the whole attempt, in order, with its durations.
    # It is deliberately NOT the idempotency_key -- retries of one booking
    # share a key but are separate invocations and get separate ids -- and
    # deliberately not returned to the caller, so the tool's response shape
    # is unchanged.
    correlation_id = uuid.uuid4().hex
    started_at = time.perf_counter()

    await _emit(
        ctx,
        "info",
        "tool.book_trip.started",
        correlation_id,
        tool="book_trip",
        customer_id=customer_id,
        flight_id=flight_id,
        hotel_id=hotel_id,
        safari_id=safari_id,
        idempotency_key_fp=_fingerprint(idempotency_key),
    )

    try:
        if not customer_id.strip():
            # The pattern above already forbids this, but the guard stays: a
            # schema is the client's promise, not the server's guarantee.
            await _emit(
                ctx,
                "warning",
                "booking.denied",
                correlation_id,
                reason="invalid_customer",
                customer_id=customer_id,
                duration_ms=_elapsed_ms(started_at),
            )
            return BookingResult(
                status="invalid_customer",
                message="Customer details are invalid.",
                replayed=False,
            )

        # booking.book_trip is sync, so its boundary events are collected and
        # flushed here rather than awaited inline. Ordering and the durations
        # are unaffected -- each duration is measured at its own boundary --
        # and `finally` means a raise still reports the boundaries it reached.
        dependency_events: list[tuple[str, dict[str, Any]]] = []
        try:
            result = booking.book_trip(
                customer_id=customer_id,
                flight_id=flight_id,
                hotel_id=hotel_id,
                safari_id=safari_id,
                idempotency_key=idempotency_key,
                emit=lambda event, fields: dependency_events.append((event, fields)),
            )
        finally:
            for event, fields in dependency_events:
                await _emit(ctx, "info", event, correlation_id, **fields)

        status = result["status"]

        if status != "confirmed":
            await _emit(
                ctx,
                "warning",
                "booking.denied",
                correlation_id,
                reason=status,
                customer_id=customer_id,
                idempotency_key_fp=_fingerprint(idempotency_key),
                duration_ms=_elapsed_ms(started_at),
            )
        elif result["replayed"]:
            # The double-charge that did not happen. Worth its own event name:
            # a spike here means callers are retrying, which is the signal
            # that something upstream is timing out.
            await _emit(
                ctx,
                "info",
                "booking.replayed",
                correlation_id,
                trip_id=result.get("trip_id"),
                idempotency_key_fp=_fingerprint(idempotency_key),
            )

        await _emit(
            ctx,
            "info",
            "tool.book_trip.completed",
            correlation_id,
            tool="book_trip",
            status=status,
            replayed=result["replayed"],
            trip_id=result.get("trip_id"),
            duration_ms=_elapsed_ms(started_at),
        )

        legs = result.get("legs")
        return BookingResult(
            status=result["status"],
            trip_id=result.get("trip_id"),
            customer_id=result.get("customer_id"),
            legs=TripLegs(**legs) if legs else None,
            message=result.get("message"),
            replayed=result["replayed"],
        )
    except Exception as exc:
        # Logged with a STABLE class name and re-raised, never swallowed. The
        # class name is the searchable part; the message may contain anything
        # and is left to the SDK's error response.
        await _emit(
            ctx,
            "error",
            "tool.book_trip.failed",
            correlation_id,
            tool="book_trip",
            error_class=type(exc).__name__,
            duration_ms=_elapsed_ms(started_at),
        )
        raise


@server.resource(
    AVAILABILITY_URI,
    name="Current availability",
    description=(
        "Which flight, hotel and safari IDs can be booked right now. Read this "
        "before booking so a trip is not proposed against inventory that is "
        "not sellable."
    ),
    mime_type="application/json",
)
def current_availability() -> str:
    """Read-only snapshot of bookable supplier IDs, as JSON."""
    return json.dumps(
        {
            "source": "in-memory stand-in for the real Supplier APIs",
            "availability": booking.current_availability(),
        },
        indent=2,
    )


@server.resource(
    BOOKING_URI_TEMPLATE,
    name="Booking by trip ID",
    description=(
        "One confirmed booking, addressed by its trip ID (e.g. "
        "travel://bookings/TRIP-1). Read this to check what a trip actually "
        "covers after it was booked, instead of re-booking to find out."
    ),
    mime_type="application/json",
)
def booking_by_trip_id(trip_id: str) -> str:
    """Read-only lookup of a single booking, as JSON. One handler, every trip.

    A miss returns `found: false` with a message rather than raising. A trip
    ID that does not exist is a normal question with a normal answer, not an
    exceptional condition, and a structured miss is something the model can
    read and act on.
    """
    record = booking.find_booking(trip_id)
    if record is None:
        return json.dumps(
            {
                "found": False,
                "trip_id": trip_id,
                "booking": None,
                "message": (
                    f"No confirmed booking with trip ID {trip_id}. Bookings "
                    "exist only for this server process; a restart clears them."
                ),
            },
            indent=2,
        )

    return json.dumps({"found": True, "trip_id": trip_id, "booking": record}, indent=2)


@server.prompt(
    name="confirm-booking",
    title="Confirm and book a trip with a client",
    description=(
        "Walk an agent through confirming a trip with a client and booking it "
        "exactly once."
    ),
)
def confirm_booking(
    customer_id: Annotated[
        str,
        Field(description="The client's ID, e.g. 'CUST-1042'. Required."),
    ],
    itinerary_note: Annotated[
        str,
        Field(
            description=(
                "What the client actually asked for, in the agent's own words. "
                "Defaults to empty, in which case the walkthrough reads "
                "availability and proposes a trip instead of matching one."
            )
        ),
    ] = "",
    trip_id: Annotated[
        str,
        Field(
            description=(
                "An existing trip ID (e.g. 'TRIP-1') to review instead of "
                "booking a new trip. Defaults to empty, meaning book new."
            )
        ),
    ] = "",
) -> str:
    """The named workflow an agent triggers to close a booking with a client.

    Returns the expanded template as a single string, which the SDK wraps as
    one user message. A multi-turn workflow can instead return a list of typed
    messages -- `[UserMessage(...), AssistantMessage(...), ...]` from
    `mcp.server.mcpserver` -- to seed a conversation with turns already in it,
    for example to pre-load a worked example before the real request. A single
    string is right here because this walkthrough is one instruction to the
    model, not a dialogue.

    Structure (tagged sections, an explicit awkward-situations block, and a
    closing output contract) follows the house style of
    prompts/triage/v1.1.0.md. That is the only prompt in the library and its
    subject -- support triage -- does not fit booking, so its wording is not
    reused; its shape is.
    """
    # Review mode: the same template, pointed at a booking that already exists.
    if trip_id.strip():
        return (
            "<role>\n"
            "You are assisting a travel agent at a boutique agency.\n"
            "</role>\n\n"
            "<task>\n"
            f"Review the existing booking {trip_id.strip()} for client "
            f"{customer_id}. Do not book anything.\n"
            "</task>\n\n"
            "<steps>\n"
            f"1. Read the resource travel://bookings/{trip_id.strip()}.\n"
            "2. If `found` is true, restate the trip as a short labelled list: "
            "client ID, trip ID, and each of the three legs.\n"
            "3. State plainly that this is a review and nothing was charged.\n"
            "</steps>\n\n"
            "<awkward_situations>\n"
            "- NOT FOUND. If `found` is false, say so in one sentence and stop. "
            "Do not call book_trip to 'recreate' it -- that would charge the "
            "client for a trip they may already have. Tell the agent the ID "
            "was not found and let them decide.\n"
            "</awkward_situations>\n"
        )

    discussed = (
        f"\n<what_the_client_asked_for>\n{itinerary_note.strip()}\n"
        "</what_the_client_asked_for>\n"
        if itinerary_note.strip()
        else ""
    )

    return (
        "<role>\n"
        "You are assisting a travel agent at a boutique agency. The agent is "
        "with the client now and is about to commit real money.\n"
        "</role>\n\n"
        "<task>\n"
        f"Help the agent book a trip for client {customer_id}, exactly once.\n"
        "</task>\n"
        f"{discussed}\n"
        "<steps>\n"
        f"1. Read the resource {AVAILABILITY_URI} and list which flight, "
        "hotel and safari are actually bookable right now.\n"
        "2. Restate the exact trip you are about to book -- client ID and all "
        "three leg IDs -- as a short labelled list.\n"
        "3. Ask the agent to confirm, then WAIT. Do not call book_trip yet.\n"
        "4. Once the agent confirms, call book_trip ONCE, with a new "
        "idempotency_key for this trip.\n"
        "5. Report the returned status, and the trip_id if there is one.\n"
        "</steps>\n\n"
        "<awkward_situations>\n"
        "- NOTHING MATCHES. If availability has no bookable option in a "
        "category, say so and stop. Do not substitute an ID that is not in "
        "the resource, and do not guess one from the pattern.\n"
        "- STATUS NOT 'confirmed'. Report what came back and stop. On "
        "'unavailable', re-read the availability resource rather than trying "
        "another ID. On 'payment_failed', the agent resolves payment and "
        "retries with the SAME idempotency_key. On 'idempotency_conflict', "
        "that key is already spent on a different trip -- mint a new one.\n"
        "- NEVER RETRY ON YOUR OWN. If a call times out or errors, do not call "
        "book_trip again unless the agent asks. If they do, reuse the same "
        "idempotency_key -- a fresh key is how a client gets charged twice.\n"
        "- DETAILS MISSING. If the note does not say which trip the client "
        "agreed to, ask. Do not pick one on their behalf.\n"
        "</awkward_situations>\n\n"
        "<output>\n"
        "At step 2, produce a labelled confirmation list and nothing else. At "
        "step 5, produce: Status, Trip ID (or 'none'), and Next action. No "
        "preamble, no closing remarks.\n"
        "</output>\n"
    )


# Registered after the tools are defined so the allowed-argument map can be
# read from their signatures. The SDK does not emit
# `additionalProperties: false`, so without this an undeclared argument is
# silently dropped -- unacceptable on a tool that charges a client.
server.middleware.append(
    make_strict_arguments_middleware({"book_trip": declared_arguments(book_trip)})
)


if __name__ == "__main__":
    server.run(transport="stdio")
