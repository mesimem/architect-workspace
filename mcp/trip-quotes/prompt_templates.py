"""Template text for the `quote-for-client` prompt.

Split out of server.py when that file crossed CLAUDE.md's 500-line hard
ceiling. The division is along a real seam, not an arbitrary line count:

  server.py            owns the MCP CONTRACT -- the argument names, their
                       descriptions and their defaults, because that is what
                       @server.prompt publishes to clients.
  prompt_templates.py  owns the TEXT those arguments are rendered into.

So a wording change touches this file only, and a change to the published
argument surface touches server.py only.

Structure of the templates -- XML-tagged sections, an explicit
awkward-situations block, a closing output contract -- follows the house style
of prompts/triage/v1.1.0.md, which scored 1.00 on a 10-case eval. That prompt's
subject (support triage) does not fit pricing, so its wording is not reused;
its shape is.
"""


def _supplied_block(travelers: str, season: str, extras_note: str) -> str:
    """Echo back only what the agent actually gave us.

    Absent fields are OMITTED rather than rendered as "not stated". A line
    reading `Season: not stated` invites the model to fill the blank; a missing
    line leaves step 2's explicit "ASK the agent and wait" as the only
    instruction covering it.
    """
    known: list[str] = []
    if travelers.strip():
        known.append(f"Party size, as given by the agent: {travelers.strip()}")
    if season.strip():
        known.append(f"Season, as given by the agent: {season.strip()}")
    if extras_note.strip():
        known.append(f"The agent's note on extras: {extras_note.strip()}")
    if not known:
        return ""
    return (
        "<what_the_agent_supplied>\n"
        + "\n".join(known)
        + "\n</what_the_agent_supplied>\n\n"
    )


def choose_destination_first(
    travelers: str, season: str, extras_note: str, rules_uri: str
) -> str:
    """Mode B: no destination yet. Narrow the field, price nothing."""
    return (
        "<role>\n"
        "You are assisting a travel agent at a boutique agency. A client "
        "is asking what a trip would cost, but no destination has been "
        "settled on yet.\n"
        "</role>\n\n"
        "<task>\n"
        "Help the agent pick something quotable, then stop. Do not produce "
        "a quote in this turn.\n"
        "</task>\n\n"
        f"{_supplied_block(travelers, season, extras_note)}"
        "<steps>\n"
        f"1. Read the resource {rules_uri}.\n"
        "2. List the destinations whose `quotable` is true, with their "
        "name and base price per traveler, as a short labelled list. Say "
        "plainly that the base price is one traveler at shoulder rate and "
        "is not the trip total.\n"
        "3. Name any destination whose `quotable` is false and say it "
        "cannot be priced yet.\n"
        "4. Ask the agent which destination to price, and ask for the "
        "party size and season if they were not supplied above. Then stop "
        "and wait.\n"
        "</steps>\n\n"
        "<awkward_situations>\n"
        "- NOT IN THE LIST. If the client wants somewhere the rate card "
        "does not cover, say so and stop. Do not price it from your own "
        "knowledge of world travel -- only what this agency publishes is "
        "sellable, and a number you invent is one the agent may quote.\n"
        "- DO NOT CALL quote_trip YET. Without a destination there is "
        "nothing to price, and a guessed ID produces a confident quote for "
        "the wrong trip.\n"
        "</awkward_situations>\n\n"
        "<output>\n"
        "A labelled list of quotable destinations, then your question. No "
        "quote, no totals, no preamble.\n"
        "</output>\n"
    )


def quote_this_destination(
    destination_id: str,
    travelers: str,
    season: str,
    extras_note: str,
    rules_uri: str,
) -> str:
    """Mode A: destination in hand. Price it, present it, stop before booking."""
    destination = destination_id.strip()
    return (
        "<role>\n"
        "You are assisting a travel agent at a boutique agency. The agent is "
        "with a client who wants to know what a trip costs.\n"
        "</role>\n\n"
        "<task>\n"
        f"Produce one itemized quote for {destination} that the "
        "agent can read aloud. Quoting is not booking: nothing in this "
        "workflow reserves inventory or charges anyone.\n"
        "</task>\n\n"
        f"{_supplied_block(travelers, season, extras_note)}"
        "<steps>\n"
        f"1. Read the resource {rules_uri} so you can explain any "
        "line you are about to show. Confirm "
        f"{destination} appears there with `quotable` true.\n"
        "2. Establish the party size and the season. If either was not "
        "supplied above, ASK the agent and wait -- do not proceed on an "
        "assumption.\n"
        "3. Map the agent's note on extras, if any, onto the add-on names in "
        "the rate card. Ask about anything you cannot map rather than "
        "dropping it silently.\n"
        f"4. Call quote_trip ONCE for {destination} with the "
        "confirmed party size, season and add-ons.\n"
        "5. Present the returned `lines` verbatim as an itemized list, then "
        "the total, then state what the quote excludes.\n"
        "</steps>\n\n"
        "<awkward_situations>\n"
        "- SEASON NOT STATED. Ask. Never infer it from today's date and never "
        "fall back to 'shoulder' to avoid asking -- that understates a "
        "high-season trip by 25%, and the agent will quote your number.\n"
        "- STATUS NOT 'quoted'. Report what came back and stop. On "
        "'unknown_destination' the ID is not in the price book -- re-read the "
        "rate card rather than trying another ID. On 'price_unavailable' the "
        "record is unfinished: say the trip cannot be priced yet and refer the "
        "client to an advisor. In neither case substitute a price of your own.\n"
        "- DO NOT RE-DERIVE THE MATH. Show the `lines` the tool returned. Do "
        "not recompute, round, blend or 'simplify' them; a total that "
        "disagrees with the itemization is worse than no quote.\n"
        "- PARTY TOO LARGE. The tool accepts 1-12 travelers. Above that, say "
        "the party needs a group booking through an advisor. Do not quote 12 "
        "and imply it scales.\n"
        "- DO NOT BOOK. Even if a booking tool is available to you and the "
        "agent seems ready, this workflow ends at the quote. Booking is a "
        "separate, gated decision that charges a real card.\n"
        "</awkward_situations>\n\n"
        "<output>\n"
        "An itemized list of the returned lines with their amounts, then "
        "'Total: $X USD', then one line naming what is excluded (anything not "
        "shown as a line, e.g. flights not in the package, insurance, visas). "
        "No preamble, no closing remarks.\n"
        "</output>\n"
    )
