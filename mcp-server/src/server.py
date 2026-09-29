"""An MCP server with one tool: look up an African safari destination.

WHAT THIS FILE IS
-----------------
This creates one MCP server, gives it one tool, and starts it.

The tool talks to this project's own backend API -- the one in the `backend/`
folder of this repository -- and asks it for the details of one destination.

HOW IT IS REACHED
-----------------
Over HTTP, at a web address (shown at the bottom of this file).

This was chosen because the server is going to live on one central computer
that several people connect to. The alternative, called "stdio", has no
address at all -- the client has to start the server itself, on the same
machine -- so it cannot be reached from anyone else's computer.

It is still limited to THIS computer for now. See the note at the bottom
before changing that, because opening it up is not just a settings change.

HOW TO RUN IT
-------------
See README.md in the folder above this one. Do not run this file by
double-clicking it; it needs to be started from a terminal.
"""

import json
import os
import sys
from typing import Annotated, Literal

import httpx2
from mcp.server import MCPServer
from pydantic import BaseModel, Field

# The name is what a client displays for this server. It is also how you will
# recognise it in the Inspector's title bar.
server = MCPServer("my-mcp-server")


# ---------------------------------------------------------------------------
# Settings for reaching the backend.
#
# Both come from the environment rather than being written here, because one
# of them is a password. A password written into a file gets copied, shared
# and committed to version control by accident; one read from the environment
# does not.
# ---------------------------------------------------------------------------

API_BASE_URL = os.getenv("COLABERRY_API_BASE_URL", "http://127.0.0.1:3001")
API_TOKEN = os.getenv("COLABERRY_API_TOKEN")

# How long to wait for the backend before giving up, in seconds.
#
# This exists so that a backend which has hung -- accepted the connection but
# never answered -- cannot freeze this server forever. Without it, one stuck
# request would sit there indefinitely, and every later request would queue up
# behind it until nothing worked at all.
#
# Two separate limits: how long to wait to make contact, and how long to wait
# for the answer once contact is made. They fail for different reasons and are
# worth being able to tune apart.
REQUEST_TIMEOUT = httpx2.Timeout(connect=3.0, read=5.0, write=5.0, pool=5.0)


class SafariDetails(BaseModel):
    """What the tool gives back.

    `status` is the part a caller should look at first and make decisions on.
    Everything else may or may not be filled in depending on what it says.
    """

    status: Literal[
        "ok",             # found it, details below, all present
        "incomplete",     # real destination, but the record is unfinished
        "unsupported",    # we do not sell this destination
        "unavailable",    # could not reach the backend, or it errored
        "bad_response",   # backend answered, but the answer was unusable
        "not_configured", # this server is missing its access token
    ]
    destination_id: str
    name: str | None = None
    country: str | None = None
    duration_days: int | None = None
    price_usd: int | None = None
    description: str | None = None
    advisor_notified: bool = False
    message: str | None = None


@server.tool()
async def get_safari_details(
    destination_id: Annotated[
        str,
        Field(
            min_length=1,
            max_length=64,
            # Only letters, numbers and hyphens. This is the SAME rule the
            # backend applies, copied deliberately, so a bad ID is refused
            # here instead of travelling across the network to be refused
            # there. Anything that does not match is rejected by the MCP
            # library BEFORE the function below runs at all.
            pattern=r"^[A-Za-z0-9-]{1,64}$",
            description=(
                "The destination's ID, for example 'SF-300'. Letters, numbers "
                "and hyphens only. This is not the destination's name -- "
                "'Serengeti' will be refused."
            ),
        ),
    ],
) -> SafariDetails:
    """Look up one African safari destination and return its full details.

    Use this when someone asks what a specific destination involves, how long
    it lasts, or what it costs.

    Read `status` before anything else:

      ok           - the details are filled in and safe to quote.
      incomplete   - the destination is real but its record is unfinished.
                     Do NOT quote a price or duration. An advisor has been
                     notified automatically.
      unsupported  - we do not sell this destination. Do not invent details
                     for it. An advisor has been notified.
      unavailable  - the backend could not be reached. This says nothing
                     about whether the destination exists. Do not guess;
                     say the system is unreachable and suggest trying again.
      bad_response - the backend answered, but its answer was incomplete or
                     malformed, so it was refused. Do NOT retry and do NOT
                     use any part of it. Report that the travel system is
                     returning bad data and needs a person to look at it.
      not_configured - this server is missing its access token. A person
                     needs to fix that; retrying will not help.

    When status is `ok`, every one of name, country, duration_days and
    price_usd is guaranteed present -- that is checked before answering.
    """
    # Checked first, because without a token every request would come back
    # rejected and the real problem would look like a backend outage.
    if not API_TOKEN:
        return SafariDetails(
            status="not_configured",
            destination_id=destination_id,
            message=(
                "This server has no COLABERRY_API_TOKEN set, so it cannot "
                "call the backend. Retrying will not help -- the environment "
                "variable needs setting and the server restarted."
            ),
        )

    url = f"{API_BASE_URL}/api/africa/destinations/{destination_id}"

    try:
        async with httpx2.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {API_TOKEN}"},
            )

    # --- The backend did not answer properly. None of these crash the tool. ---
    except httpx2.TimeoutException:
        # It accepted our call but did not answer in time.
        return _unavailable(
            destination_id,
            "The travel backend did not respond in time. It may be busy or "
            "stuck. This is not a statement about the destination.",
        )
    except httpx2.ConnectError:
        # Nothing is listening. Usually the backend is simply not started.
        return _unavailable(
            destination_id,
            f"Could not reach the travel backend at {API_BASE_URL}. It is "
            "most likely not running.",
        )
    except httpx2.RequestError as error:
        # Any other network-level problem: DNS, connection reset, and so on.
        # Deliberately reports the KIND of failure, never the token.
        return _unavailable(
            destination_id,
            f"Could not reach the travel backend ({type(error).__name__}).",
        )

    # --- The backend answered. Work out what it said. ---
    if response.status_code in (401, 403):
        return SafariDetails(
            status="not_configured",
            destination_id=destination_id,
            message=(
                "The travel backend rejected this server's access token. The "
                "token is wrong or expired; retrying will not help."
            ),
        )

    if response.status_code >= 500:
        return _unavailable(
            destination_id,
            f"The travel backend reported an internal error "
            f"(HTTP {response.status_code}).",
        )

    try:
        # Decoded as UTF-8 explicitly, rather than letting the HTTP library
        # guess. The backend sends "Content-Type: application/json" WITHOUT
        # saying which character set it used, and the library's fallback guess
        # is wrong -- it turns an em-dash into "â€"" and would put that
        # mojibake straight in front of a customer.
        body = json.loads(response.content.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        # It answered, but not with readable JSON. Treat as unavailable rather
        # than letting a parsing crash escape.
        return _unavailable(
            destination_id,
            "The travel backend sent a reply this server could not read.",
        )

    if not isinstance(body, dict):
        # Valid JSON, but not an object -- a list or a bare string. Guarded
        # BEFORE the first .get() below, which would otherwise crash the tool
        # rather than answer it.
        return _bad_response(
            destination_id,
            "The travel backend sent a reply that was not in the expected form.",
        )

    backend_status = body.get("status")

    if backend_status == "ok":
        details = body.get("details")
        if not isinstance(details, dict):
            return _bad_response(
                destination_id,
                "The travel backend said 'ok' but sent no details with it.",
            )

        # DO NOT TRUST "ok" ON ITS OWN.
        #
        # "ok" is this tool's promise that the details are complete and safe
        # to put in front of a customer. Before that promise is repeated, the
        # details are actually checked. Without this, a backend answering
        # "ok" with an empty block produced a confident answer with every
        # field blank -- and because it was not an error, nobody would notice.
        #
        # These four are the ones a person would quote. `description` is
        # allowed to be missing; it is cosmetic, and failing on it would cry
        # wolf.
        required = {
            "name": details.get("name"),
            "country": details.get("country"),
            "durationDays": details.get("durationDays"),
            "priceUSD": details.get("priceUSD"),
        }
        missing = [field for field, value in required.items() if value is None]
        if missing:
            return _bad_response(
                destination_id,
                "The travel backend said 'ok' but left out "
                + ", ".join(missing)
                + ". Refusing to report this as complete.",
            )

        # Numbers must actually be numbers. A price arriving as the text
        # "4200" would otherwise be quietly converted and look fine.
        # `bool` is excluded on purpose: in Python True counts as an integer.
        for field in ("durationDays", "priceUSD"):
            value = required[field]
            if isinstance(value, bool) or not isinstance(value, int):
                return _bad_response(
                    destination_id,
                    f"The travel backend sent {field} as "
                    f"{type(value).__name__}, not a whole number.",
                )

        # Translate the backend's field names into ours. Their names
        # ("durationDays", "priceUSD") stop at this line and go no further.
        return SafariDetails(
            status="ok",
            destination_id=details.get("destinationId") or destination_id,
            name=required["name"],
            country=required["country"],
            duration_days=required["durationDays"],
            price_usd=required["priceUSD"],
            description=details.get("description"),
        )

    if backend_status in ("incomplete", "unsupported"):
        # The backend sends a large block about which advisor was notified and
        # when. None of that is the caller's business, so only the one fact
        # that changes their behaviour is passed on.
        advisor = body.get("advisor") or {}
        return SafariDetails(
            status=backend_status,
            destination_id=destination_id,
            advisor_notified=bool(advisor.get("routed")),
            message=body.get("message"),
        )

    # Anything else is a shape we did not expect. Say so plainly rather than
    # pretending the lookup worked.
    return _unavailable(
        destination_id,
        f"The travel backend replied with an unexpected status "
        f"({backend_status!r}).",
    )


def _unavailable(destination_id: str, message: str) -> SafariDetails:
    """Build the 'could not reach the backend' answer, in one place."""
    return SafariDetails(
        status="unavailable",
        destination_id=destination_id,
        message=message,
    )


def _bad_response(destination_id: str, message: str) -> SafariDetails:
    """Build the 'backend answered, but the answer was unusable' response.

    Kept separate from `unavailable` on purpose. "Unavailable" invites a
    retry; this does not. A backend that sends a broken answer will send the
    same broken answer next time, so a person has to look at it.
    """
    return SafariDetails(
        status="bad_response",
        destination_id=destination_id,
        message=message,
    )


# Where the server listens.
#
# "127.0.0.1" is a special address meaning "this computer only". Nothing on
# the network and nothing on the internet can reach it while it says that.
#
# DO NOT change this to "0.0.0.0" to let other people in. That address means
# "anyone who can reach this machine", and this server currently has no way
# of checking who is calling -- so everyone who found it would be able to use
# it. Letting other people in is a separate piece of work: somewhere to host
# it, and a lock on the door. Until then, leave this as it is.
HOST = "127.0.0.1"
PORT = 8000

if __name__ == "__main__":
    print(f"my-mcp-server starting on http://{HOST}:{PORT}/mcp", file=sys.stderr)
    print(f"  backend: {API_BASE_URL}", file=sys.stderr)
    if not API_TOKEN:
        # A warning, not a refusal to start. The server is still worth having
        # up -- a client can connect and see the tool -- but the tool will
        # explain that it cannot work until this is set.
        print(
            "  WARNING: COLABERRY_API_TOKEN is not set. get_safari_details "
            "will return 'not_configured' until it is.",
            file=sys.stderr,
        )
    print("Press Ctrl+C to stop.", file=sys.stderr)

    server.run(transport="streamable-http", host=HOST, port=PORT)
