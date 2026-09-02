"""destination-catalog — MCP server over the agency's destination catalog.

Turns a traveler's words into destination IDs, which is the one lookup the
platform cannot do today: backend/src/services/booking/bookTripService.js and
backend/src/services/africa/safariDetailsService.js both require an exact ID
up front, and nothing gets you from "7-day safari in Tanzania" to "SF-300".

STDIO transport:  uv run server.py
Inspector:        uv run mcp dev server.py:server

NOTE: stdout belongs to the JSON-RPC protocol on STDIO transport. Never
print() in this file — a stray print corrupts the message stream. Send
diagnostics to stderr.
"""

from typing import Annotated

from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from pydantic import BaseModel, Field

server = MCPServer("destination-catalog")

# Sample catalog. In-memory stand-in for the real destination catalog, in the
# same spirit as SAFARI_CATALOG in backend/src/services/africa/
# safariDetailsService.js. SF-300 and SF-301 are kept ID-identical to that
# file so search results hand back IDs the existing services already accept.
# SF-301 is deliberately missing price/duration/description — it exercises
# the same "incomplete" state that service already models.
CATALOG: list[dict] = [
    {
        "destination_id": "SF-300",
        "name": "Serengeti Migration Safari",
        "country": "Tanzania",
        "region": "Africa",
        "duration_days": 7,
        "price_usd": 4200,
        "tags": ["safari", "wildlife", "migration", "guided", "lodge"],
        "description": "Follow the wildebeest migration across the Serengeti plains.",
    },
    {
        "destination_id": "SF-301",
        "name": "Kilimanjaro Trek",
        "country": "Tanzania",
        "region": "Africa",
        "tags": ["trekking", "altitude", "guided"],
    },
    {
        "destination_id": "SF-302",
        "name": "Okavango Delta Water Safari",
        "country": "Botswana",
        "region": "Africa",
        "duration_days": 6,
        "price_usd": 6850,
        "tags": ["safari", "wildlife", "mokoro", "luxury", "small-group"],
        "description": "Mokoro canoe safari through the Okavango's seasonal floodplains.",
    },
    {
        "destination_id": "SF-303",
        "name": "Cape Town & Winelands",
        "country": "South Africa",
        "region": "Africa",
        "duration_days": 8,
        "price_usd": 3900,
        "tags": ["city", "wine", "coast", "food", "self-drive"],
        "description": "Table Mountain, the Cape peninsula, and the Stellenbosch wine route.",
    },
    {
        "destination_id": "EU-410",
        "name": "Amalfi Coast Slow Escape",
        "country": "Italy",
        "region": "Europe",
        "duration_days": 9,
        "price_usd": 5400,
        "tags": ["coast", "food", "honeymoon", "walking", "boutique"],
        "description": "Positano, Ravello, and the Path of the Gods at an unhurried pace.",
    },
    {
        "destination_id": "EU-411",
        "name": "Scottish Highlands Rail & Whisky",
        "country": "Scotland",
        "region": "Europe",
        "duration_days": 7,
        "price_usd": 4100,
        "tags": ["rail", "whisky", "hiking", "castles", "shoulder-season"],
        "description": "West Highland Line to Mallaig with Speyside distillery stops.",
    },
    {
        "destination_id": "LA-520",
        "name": "Patagonia Torres del Paine Trek",
        "country": "Chile",
        "region": "Latin America",
        "duration_days": 10,
        "price_usd": 7300,
        "tags": ["trekking", "mountains", "active", "guided", "refugio"],
        "description": "The W circuit with refugio nights and glacier viewpoints.",
    },
    {
        "destination_id": "LA-521",
        "name": "Costa Rica Cloud Forest & Coast",
        "country": "Costa Rica",
        "region": "Latin America",
        "duration_days": 9,
        "price_usd": 5200,
        "tags": ["family", "wildlife", "rainforest", "beach", "multi-generational"],
        "description": "Arenal, Monteverde, and Manuel Antonio in one loop.",
    },
    {
        "destination_id": "AS-630",
        "name": "Japan Cherry Blossom Rail Journey",
        "country": "Japan",
        "region": "Asia",
        "duration_days": 12,
        "price_usd": 8600,
        "tags": ["rail", "culture", "food", "spring", "cities"],
        "description": "Tokyo, Kyoto, Kanazawa, and Hiroshima by shinkansen in sakura season.",
    },
]

REQUIRED_DETAIL_FIELDS = ("description", "duration_days", "price_usd")


class DestinationRow(BaseModel):
    """One catalog match. destination_id is the key the booking and safari
    services already accept."""

    destination_id: str
    name: str
    country: str
    region: str
    duration_days: int | None = None
    price_usd: int | None = None
    tags: list[str]
    matched_on: list[str]
    details_complete: bool


def _is_complete(entry: dict) -> bool:
    return all(entry.get(field) is not None for field in REQUIRED_DETAIL_FIELDS)


def _score(entry: dict, terms: list[str]) -> tuple[int, list[str]]:
    """Count how many query terms hit which fields. Deterministic: no
    randomness, no clock, so the same query always returns the same rows."""
    fields = {
        "name": entry.get("name", ""),
        "country": entry.get("country", ""),
        "region": entry.get("region", ""),
        "tags": " ".join(entry.get("tags", [])),
        "description": entry.get("description", ""),
    }
    weights = {"name": 3, "country": 3, "region": 2, "tags": 2, "description": 1}
    score = 0
    matched: list[str] = []
    for field, text in fields.items():
        haystack = text.lower()
        if any(term in haystack for term in terms):
            score += weights[field]
            matched.append(field)
    return score, matched


@server.tool()
async def search_destinations(
    query: Annotated[
        str,
        Field(
            min_length=2,
            max_length=200,
            description=(
                "What the traveler is looking for, in their own words: "
                "destination, country, region, activity, trip style, or "
                "interest. Example: 'safari in Tanzania for two' or "
                "'walking trip in Italy'."
            ),
        ),
    ],
    limit: Annotated[
        int,
        Field(ge=1, le=10, description="Maximum rows to return. Default 5."),
    ] = 5,
    # Injected by the SDK, which recognizes it by the `Context` annotation and
    # keeps it OUT of the published input schema -- so this is not a change to
    # the tool's client-visible contract. Defaults to None so the function is
    # still directly callable in a test without a live request.
    ctx: Context | None = None,
) -> list[DestinationRow]:
    """Search the agency's destination catalog and return matching trips as rows.

    Call this whenever a traveler describes what kind of trip they want in
    words rather than naming a destination ID -- a country, a region, an
    activity, a trip style, an interest, a season -- or when you need a
    destination_id in order to fetch details or start a booking. This is the
    only way to get from a traveler's description to a destination_id.

    Call it again with a broader query if the first search returns no rows.

    Do not answer from your own knowledge of world travel: only destinations
    returned by this tool are actually sellable by this agency. Never quote a
    price or duration for a row whose details_complete is false -- those
    records are unfinished; refer the traveler to an advisor instead.
    """
    if not query.strip():
        raise ValueError("query must contain at least one non-whitespace character")

    terms = [t for t in query.lower().split() if len(t) > 2]
    if not terms:
        terms = [query.strip().lower()]

    # The client opts in to progress by sending a token on the request; absent
    # one there is nothing to report against, so this stays None and the loop
    # below runs exactly as it always did.
    progress_token = None
    if ctx is not None:
        meta = ctx.request_context.meta
        progress_token = meta.get("progress_token") if meta else None

    # The real total: every catalog entry is scored, regardless of `limit`,
    # which caps the rows RETURNED and not the work done.
    total = len(CATALOG)

    scored = []
    for position, entry in enumerate(CATALOG, start=1):
        score, matched = _score(entry, terms)
        if score > 0:
            scored.append((score, entry, matched))
        # Only with a token: a progress notification must name the one the client sent.
        if progress_token is not None:
            await ctx.report_progress(
                progress=position,
                total=total,
                message=f"Scoring {entry['name']} ({position} of {total})",
            )

    # Highest score first; ties broken by destination_id so results are stable.
    scored.sort(key=lambda row: (-row[0], row[1]["destination_id"]))

    return [
        DestinationRow(
            destination_id=entry["destination_id"],
            name=entry["name"],
            country=entry["country"],
            region=entry["region"],
            duration_days=entry.get("duration_days"),
            price_usd=entry.get("price_usd"),
            tags=entry.get("tags", []),
            matched_on=matched,
            details_complete=_is_complete(entry),
        )
        for _score_value, entry, matched in scored[:limit]
    ]


if __name__ == "__main__":
    server.run(transport="stdio")
