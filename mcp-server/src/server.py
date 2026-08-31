"""An empty MCP server, ready for work to be added later.

WHAT THIS FILE IS
-----------------
This creates one MCP server and starts it. That is all it does. It has no
tools, no resources and no prompts yet -- that is deliberate. Right now the
only thing it can do is answer "hello, I exist, and my name is my-mcp-server"
when a client asks. That is enough to prove the plumbing works before any
real feature is added on top.

HOW TO RUN IT
-------------
See README.md in the folder above this one. Do not run this file by
double-clicking it; it needs to be started from a terminal.

ONE RULE IF YOU EDIT THIS FILE
------------------------------
Never use print() in this file. An MCP server talks to its client by writing
messages to something called "standard output". A print() writes into that
same channel, which garbles the conversation and the client disconnects with
a confusing error. If you want to leave yourself a note while the server
runs, write to "standard error" instead:

    import sys
    print("my note", file=sys.stderr)   # this is safe
"""

import sys

from mcp.server import MCPServer

# The name is what a client displays for this server. It is also how you will
# recognise it in the Inspector's title bar.
server = MCPServer("my-mcp-server")


# Tools, resources and prompts would be added here later, above this line.


if __name__ == "__main__":
    # A one-line "I started" message, so a human sees SOMETHING. Without this
    # the server would start in complete silence, which looks broken.
    #
    # This goes to standard error on purpose. Standard output is reserved for
    # the conversation with the client (see the rule at the top of this file);
    # standard error is the channel a human can safely be shown.
    print("my-mcp-server is running. Press Ctrl+C to stop.", file=sys.stderr)

    # "stdio" means: talk to the client over this terminal, rather than over a
    # network port. It is the normal choice for a server running on your own
    # machine.
    server.run(transport="stdio")
