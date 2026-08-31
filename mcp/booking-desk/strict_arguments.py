"""Reject tool calls carrying arguments the tool did not declare.

WHY THIS EXISTS: the SDK builds each tool's input schema from the function
signature and does not emit `additionalProperties: false`. Its argument model
(`ArgModelBase`) is configured `arbitrary_types_allowed=True` with no
`extra="forbid"`, so an undeclared argument is silently dropped and the call
proceeds as if it were never sent. mcp/destination-catalog has exactly this
hole -- `{"query": "safari", "bogus": 1}` returns `isError: false`.

That is tolerable for a search tool. It is not tolerable for a tool that
charges a client. A typo'd `idempotency_key` -> `idempotencyKey` would be
dropped, the real `idempotency_key` would then be missing and rejected -- but
a typo'd argument that merely SUPPLEMENTS a valid call would sail through
unnoticed. Fail loud instead.

This runs as context-tier middleware, before params validation, where the raw
inbound arguments are still visible. The tool function itself never sees the
extras -- by the time it is called they are already gone -- so the boundary is
the only place this check can live.

The allowed names are read from each tool function's own signature, not from
`server.list_tools()`. Awaiting `list_tools()` from inside middleware
deadlocks: middleware runs at the top of the dispatcher, before the handler
context exists, and the dispatcher will not read another inbound message until
the chain returns. Verified the hard way -- the first `tools/call` hung until
timeout.

CAVEAT: `MCPServer.middleware` is documented as provisional and its signature
may change in a 2.x minor release. If a future SDK emits
`additionalProperties: false` natively, delete this module and rely on that.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

from mcp.shared.exceptions import MCPError
from mcp.types import INVALID_PARAMS


def declared_arguments(func: Callable[..., Any]) -> set[str]:
    """The argument names a tool function accepts, from its signature."""
    return {
        name
        for name, param in inspect.signature(func).parameters.items()
        if param.kind
        not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
    }


def make_strict_arguments_middleware(allowed: dict[str, set[str]]):
    """Build middleware that refuses undeclared arguments on tools/call.

    `allowed` maps tool name -> the argument names that tool accepts.
    """

    async def strict_arguments(ctx: Any, call_next: Any) -> Any:
        if ctx.method != "tools/call":
            return await call_next(ctx)

        params = ctx.params or {}
        tool_name = params.get("name")
        arguments = params.get("arguments") or {}

        if not isinstance(arguments, dict) or not tool_name:
            # Malformed shape -- let the SDK's own validation report it.
            return await call_next(ctx)

        declared = allowed.get(tool_name)
        if declared is None:
            # Unknown tool -- the SDK reports that better than we can.
            return await call_next(ctx)

        unknown = sorted(set(arguments) - declared)
        if unknown:
            raise MCPError(
                INVALID_PARAMS,
                f"Unknown argument(s) for tool '{tool_name}': "
                f"{', '.join(unknown)}. Accepted: {', '.join(sorted(declared))}.",
            )

        return await call_next(ctx)

    return strict_arguments
