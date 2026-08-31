"""trip-quotes — MCP server that prices a catalog trip for a real party.

Publishes three surfaces, one per primitive, each chosen by who initiates it:

  tool      quote_trip                     -> model-initiated. The party size,
                                              season and add-ons only exist in
                                              the conversation, so no fixed URI
                                              could address this answer.
  resource  travel://pricing/rules/current -> application-initiated. The rate
                                              card the tool applies. The app
                                              pins it so the model can explain
                                              a quote instead of inventing
                                              surcharges.
  prompt    quote-for-client               -> user-initiated. The named
                                              walkthrough an agent picks when a
                                              client asks what a trip costs. It
                                              is the only surface here that
                                              encodes WHEN to ask instead of
                                              assume, and that quoting must not
                                              slide into booking.

Fills a gap read out of the existing code: search_destinations in
mcp/destination-catalog returns `price_usd`, which is PER PERSON at base rate,
and backend/src/services/africa/safariDetailsService.js returns the same figure.
Nothing anywhere turns that into "what does this cost for two in high season".

Nothing here writes state. The tool is a pure function of its arguments, so it
is idempotent by construction -- calling it twice cannot produce a second
anything. Season is an explicit argument rather than being derived from the
clock for the same reason: a quote must be reproducible after the fact.

STDIO transport:  uv run python server.py
Inspector:        uv run mcp dev server.py:server

NOTE: stdout belongs to the JSON-RPC protocol on STDIO transport. Never
print() in this file -- a stray print corrupts the message stream. Send
diagnostics to stderr.
"""

# DO NOT add `from __future__ import annotations` to this file. It turns every
# annotation into a string, and @server.tool hands this module's functions to
# Pydantic, which resolves those strings against `sys.modules[func.__module__]`.
# `mcp dev` loads the file via importlib as "server_module" WITHOUT registering
# it in sys.modules, so the lookup misses, the output schema silently fails to
# build, and decoration can die with `NameError: name 'Annotated' is not
# defined` -- while `python server.py` keeps working, because there the module
# is `__main__` and is registered. Cost this repo a debugging session once
# already (PROGRESS.md, session CC-20260828-b4k2).

import json
from typing import Annotated, Literal

from mcp.server import MCPServer
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

import prompt_templates

server = MCPServer("trip-quotes")

# `travel://` names the business domain, matching mcp/booking-desk. This is
# agency rate-card data, not a file to read or a page to fetch, so `file://` or
# `https://` would both misdescribe it and imply a transport not involved.
PRICING_RULES_URI = "travel://pricing/rules/current"

# ---------------------------------------------------------------------------
# The rate card. These constants are the SINGLE source of truth: the tool
# computes from them and the resource serializes them. Neither restates the
# other, so the published rules cannot drift from the arithmetic actually run.
# ---------------------------------------------------------------------------

# Base price is per traveler, at shoulder rate. IDs and figures are kept
# identical to CATALOG in mcp/destination-catalog/server.py and SAFARI_CATALOG
# in backend/src/services/africa/safariDetailsService.js so a destination_id
# handed over by search_destinations prices correctly here.
#
# SF-301 carries base_price_usd=None deliberately: that record is unfinished in
# both of those files too, and an unfinished record must refuse to be quoted
# rather than quote a guess.
PRICE_BOOK: dict[str, dict] = {
    "SF-300": {"name": "Serengeti Migration Safari", "base_price_usd": 4200},
    "SF-301": {"name": "Kilimanjaro Trek", "base_price_usd": None},
    "SF-302": {"name": "Okavango Delta Water Safari", "base_price_usd": 6850},
    "SF-303": {"name": "Cape Town & Winelands", "base_price_usd": 3900},
    "EU-410": {"name": "Amalfi Coast Slow Escape", "base_price_usd": 5400},
    "LA-520": {"name": "Patagonia Torres del Paine Trek", "base_price_usd": 7300},
}

SEASON_MULTIPLIERS: dict[str, float] = {"low": 0.85, "shoulder": 1.00, "high": 1.25}

# Each add-on declares its unit, because "per party" vs "per traveler" is the
# difference between a right and a wrong quote and must not be inferable only
# from the arithmetic below.
ADD_ONS: dict[str, dict] = {
    "private_guide": {"price_usd": 900, "unit": "per_party"},
    "photography": {"price_usd": 450, "unit": "per_traveler"},
    "extra_night": {"price_usd": 320, "unit": "per_traveler"},
    "airport_transfer": {"price_usd": 140, "unit": "per_party"},
}

SOLO_SUPPLEMENT_USD = 600
GROUP_DISCOUNT_FROM_TRAVELERS = 6
GROUP_DISCOUNT_RATE = 0.05
BOOKING_FEE_USD = 75

# Applied in this order. The two percentage steps are order-sensitive, so the
# order is published in the resource rather than left implicit in the code.
COMPUTATION_ORDER = [
    "base fare = base_price_usd x travelers",
    "seasonal adjustment on the base fare",
    "solo traveler supplement, if travelers == 1",
    "group discount on the running subtotal, if travelers >= 6",
    "add-ons, at each add-on's own unit",
    "flat booking fee",
]


class QuoteLine(BaseModel):
    """One line of the quote. Signed: adjustments and discounts are negative."""

    label: str
    amount_usd: int


class TripQuote(BaseModel):
    """Outcome of a pricing attempt.

    `status` is the contract -- callers branch on it, not on the prose in
    `message`. `lines` sum exactly to `total_usd` so a quote can be shown to a
    client line by line without recomputing anything.
    """

    status: Literal["quoted", "unknown_destination", "price_unavailable"]
    destination_id: str
    name: str | None = None
    travelers: int | None = None
    season: str | None = None
    lines: list[QuoteLine] = []
    total_usd: int | None = None
    currency: Literal["USD"] = "USD"
    message: str | None = None


@server.tool(
    annotations=ToolAnnotations(
        title="Quote a trip",
        # The exact mirror image of book_trip in mcp/booking-desk: this reads
        # nothing but its own arguments and writes nothing at all, so the host
        # has no reason to gate it behind an approval prompt.
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=False,
    )
)
def quote_trip(
    destination_id: Annotated[
        str,
        Field(
            min_length=5,
            max_length=12,
            pattern=r"^[A-Z]{2}-\d{3,6}$",
            description=(
                "The destination to price, e.g. 'SF-300'. Get this from "
                "search_destinations -- do not guess one from the pattern."
            ),
        ),
    ],
    travelers: Annotated[
        int,
        Field(
            ge=1,
            le=12,
            description="How many people are traveling, 1-12. Required.",
        ),
    ],
    season: Annotated[
        Literal["low", "shoulder", "high"],
        Field(
            description=(
                "When they intend to travel. Ask the client -- never infer it "
                "from today's date, and never assume 'shoulder' to avoid "
                "asking, because that understates a high-season trip by 25%."
            )
        ),
    ],
    add_ons: Annotated[
        list[Literal["private_guide", "photography", "extra_night", "airport_transfer"]],
        Field(
            description=(
                "Extras the client asked for. Omit or pass [] for none. "
                "Repeats are ignored: each add-on is priced at most once."
            )
        ),
    ] = [],  # noqa: B006 -- never mutated; read-only in this function.
) -> TripQuote:
    """Price one catalog trip for a specific party, itemized, in whole US dollars.

    Call this whenever a client asks what a trip costs, or once you know the
    destination, the party size and the season. Do not quote from the
    `price_usd` on a search result: that figure is one traveler at shoulder
    rate, before seasonal adjustment, supplements, add-ons and the booking fee,
    so repeating it as "the price" understates almost every real trip.

    This reads a rate card and returns a number. It reserves nothing, charges
    nothing and records nothing, so it is safe to call as often as you like and
    safe to retry -- the same arguments always produce the same quote. Booking
    is a separate, gated tool.

    Read `status` to know what happened. On 'unknown_destination' the ID is not
    in the agency's price book -- re-run search_destinations rather than trying
    another ID. On 'price_unavailable' the record exists but is unfinished and
    has no base price; say so and refer the client to an advisor. Never
    substitute a price of your own in either case.

    `lines` sums exactly to `total_usd`. Show the lines when a client asks why
    a trip costs what it does; the same figures are published, with the order
    they are applied in, at the resource travel://pricing/rules/current.
    """
    entry = PRICE_BOOK.get(destination_id)
    if entry is None:
        return TripQuote(
            status="unknown_destination",
            destination_id=destination_id,
            message=(
                f"{destination_id} is not in the agency's price book. Search "
                "the destination catalog for a sellable destination ID."
            ),
        )

    base_price = entry["base_price_usd"]
    if base_price is None:
        return TripQuote(
            status="price_unavailable",
            destination_id=destination_id,
            name=entry["name"],
            message=(
                f"{entry['name']} has no published base price yet, so it "
                "cannot be quoted. Refer the client to an advisor."
            ),
        )

    lines: list[QuoteLine] = []

    # 1. Base fare.
    base_total = base_price * travelers
    lines.append(
        QuoteLine(
            label=f"Base fare ({travelers} x ${base_price:,} per traveler)",
            amount_usd=base_total,
        )
    )

    # 2. Seasonal adjustment, expressed as a delta against the base fare so the
    #    client can see the season's effect instead of an already-blended rate.
    multiplier = SEASON_MULTIPLIERS[season]
    seasonal_delta = round(base_total * (multiplier - 1))
    if seasonal_delta:
        lines.append(
            QuoteLine(
                label=f"Seasonal adjustment ({season} season, x{multiplier})",
                amount_usd=seasonal_delta,
            )
        )

    # 3. Solo supplement.
    if travelers == 1:
        lines.append(
            QuoteLine(
                label="Solo traveler supplement", amount_usd=SOLO_SUPPLEMENT_USD
            )
        )

    # 4. Group discount, on the running subtotal -- after the season and the
    #    supplement, before add-ons and the fee. Order is published.
    if travelers >= GROUP_DISCOUNT_FROM_TRAVELERS:
        subtotal = sum(line.amount_usd for line in lines)
        lines.append(
            QuoteLine(
                label=(
                    f"Group discount ({travelers} travelers, "
                    f"{GROUP_DISCOUNT_RATE:.0%})"
                ),
                amount_usd=-round(subtotal * GROUP_DISCOUNT_RATE),
            )
        )

    # 5. Add-ons. Deduped, and sorted so the same request always produces the
    #    same line order -- a quote that reorders itself between identical
    #    calls looks like a different quote to anyone reading it.
    for name in sorted(set(add_ons)):
        spec = ADD_ONS[name]
        count = travelers if spec["unit"] == "per_traveler" else 1
        unit_label = "per traveler" if count > 1 else "per party"
        lines.append(
            QuoteLine(
                label=f"{name.replace('_', ' ').title()} ({unit_label})",
                amount_usd=spec["price_usd"] * count,
            )
        )

    # 6. Flat booking fee.
    lines.append(QuoteLine(label="Booking fee", amount_usd=BOOKING_FEE_USD))

    return TripQuote(
        status="quoted",
        destination_id=destination_id,
        name=entry["name"],
        travelers=travelers,
        season=season,
        lines=lines,
        total_usd=sum(line.amount_usd for line in lines),
    )


@server.resource(
    PRICING_RULES_URI,
    name="Current pricing rules",
    description=(
        "The agency's rate card: season multipliers, add-on prices and units, "
        "supplements, the booking fee, the order they are applied in, and "
        "which destinations have a published base price. Read this to explain "
        "or sanity-check a quote without calling quote_trip."
    ),
    mime_type="application/json",
)
def current_pricing_rules() -> str:
    """Read-only snapshot of the rate card, as JSON.

    Serialized from the same module constants quote_trip computes with, so the
    published rules cannot disagree with the arithmetic. No arguments and one
    fixed URI: the application knows it wants this before the conversation
    starts, which is exactly what makes it a resource and not a tool.
    """
    return json.dumps(
        {
            "currency": "USD",
            "source": "in-memory stand-in for the real rate card",
            "season_multipliers": SEASON_MULTIPLIERS,
            "add_ons": ADD_ONS,
            "solo_supplement_usd": SOLO_SUPPLEMENT_USD,
            "group_discount": {
                "from_travelers": GROUP_DISCOUNT_FROM_TRAVELERS,
                "rate": GROUP_DISCOUNT_RATE,
                "applies_to": "subtotal after season and supplement, before add-ons",
            },
            "booking_fee_usd": BOOKING_FEE_USD,
            "computation_order": COMPUTATION_ORDER,
            "rounding": "each line rounded to whole USD; a quote is not an invoice",
            "destinations": [
                {
                    "destination_id": destination_id,
                    "name": entry["name"],
                    "base_price_usd": entry["base_price_usd"],
                    "quotable": entry["base_price_usd"] is not None,
                }
                for destination_id, entry in PRICE_BOOK.items()
            ],
        },
        indent=2,
    )


@server.prompt(
    name="quote-for-client",
    title="Quote a trip for a client",
    description=(
        "Walk an agent through pricing a trip for a client and presenting the "
        "quote line by line. Asks for anything missing instead of assuming it, "
        "and stops short of booking."
    ),
)
def quote_for_client(
    # Every argument is optional, and deliberately so: this walkthrough's job
    # is partly to GATHER what the agent did not supply. A required `season`
    # would remove the one rule most worth encoding -- ask, never assume.
    #
    # All four are `str` because MCP prompt arguments are name/value strings on
    # the wire. `travelers` is therefore validated by the tool's schema
    # (integer, 1-12) rather than here, and this template must cope with "3",
    # "three", "a couple" or "".
    destination_id: Annotated[
        str,
        Field(
            description=(
                "The destination to price, e.g. 'SF-300'. Defaults to empty, "
                "in which case the walkthrough lists what is quotable and asks "
                "the agent to choose instead of guessing."
            )
        ),
    ] = "",
    travelers: Annotated[
        str,
        Field(
            description=(
                "How many people are traveling, e.g. '2'. Defaults to empty, "
                "in which case the walkthrough asks."
            )
        ),
    ] = "",
    season: Annotated[
        str,
        Field(
            description=(
                "When they intend to travel: 'low', 'shoulder' or 'high'. "
                "Defaults to empty, in which case the walkthrough asks. It is "
                "never inferred -- guessing wrong is a 25% error."
            )
        ),
    ] = "",
    extras_note: Annotated[
        str,
        Field(
            description=(
                "Anything else the client asked for, in the agent's own words, "
                "e.g. 'wants a private guide and an extra night'. Defaults to "
                "empty."
            )
        ),
    ] = "",
) -> str:
    """The named workflow an agent triggers when a client asks about price.

    Returns the expanded template as a single string, which the SDK wraps as
    one user message -- this is one instruction to the model, not a dialogue.
    (A multi-turn workflow would instead return a list of typed messages,
    `UserMessage` / `AssistantMessage` from `mcp.server.mcpserver`.)

    Two modes on one prompt, keyed on `destination_id`, mirroring the
    book/review split in mcp/booking-desk's `confirm-booking`: populated means
    price that trip, empty means help the agent find something to price first.

    This function owns the published argument surface only; the template text
    lives in prompt_templates.py, which also documents where its shape came
    from. Renaming an argument here is a client-visible contract change;
    rewording a template there is not.
    """
    if destination_id.strip():
        return prompt_templates.quote_this_destination(
            destination_id, travelers, season, extras_note, PRICING_RULES_URI
        )
    return prompt_templates.choose_destination_first(
        travelers, season, extras_note, PRICING_RULES_URI
    )


if __name__ == "__main__":
    server.run(transport="stdio")
