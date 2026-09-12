#!/usr/bin/env python3
"""
SClaw MCP client (Python SDK).

Connects to the SClaw TypeScript MCP server (HTTP + SSE at /mcp) and exercises
its tools/resources. Uses the official `mcp` Python SDK as the CLIENT side.

Usage:
  python mcp_client.py                                   # list tools + read health
  python mcp_client.py --resource sclaw://health         # read a resource
  python mcp_client.py --resource sclaw://watch          # list watch tasks
  python mcp_client.py --tool stock_info --args '{"symbol":"600519.SH"}'
  python mcp_client.py --tool sniper_limit_up --args '{"mode":"scan"}'
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from mcp.client.sse import sse_client
from mcp import ClientSession

DEFAULT_URL = "http://localhost:3001/mcp"


def _dump_content(res: Any) -> str:
    """Render a CallToolResult/ReadResourceResult's content chunks to text."""
    parts: list[str] = []
    # Tool results use `content` (singular); resource results use `contents` (plural).
    chunks = getattr(res, "content", None) or getattr(res, "contents", None) or []
    for item in chunks:
        if hasattr(item, "text"):
            parts.append(item.text)
        elif hasattr(item, "data"):
            parts.append(f"[image {getattr(item, 'mimeType', '')} {len(item.data)} bytes]")
        else:
            parts.append(str(item))
    # Structured content (v2) is often richer than the text fallback.
    sc = getattr(res, "structuredContent", None)
    if sc is not None:
        parts.append("[structuredContent]\n" + json.dumps(sc, ensure_ascii=False, indent=2))
    return "\n".join(parts)


async def main() -> None:
    ap = argparse.ArgumentParser(description="SClaw MCP client (Python SDK)")
    ap.add_argument("--url", default=DEFAULT_URL, help="MCP server SSE endpoint")
    ap.add_argument("--tool", help="name of a MCP tool to call")
    ap.add_argument("--args", default="{}", help="JSON object of tool arguments")
    ap.add_argument("--resource", help="read this MCP resource uri (e.g. sclaw://health)")
    args = ap.parse_args()

    async with sse_client(args.url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            if args.tool:
                try:
                    tool_args = json.loads(args.args)
                except json.JSONDecodeError as e:
                    print(f"invalid --args JSON: {e}", file=sys.stderr)
                    sys.exit(2)
                res = await session.call_tool(args.tool, tool_args)
                print(_dump_content(res))
                return

            if args.resource:
                res = await session.read_resource(args.resource)
                print(_dump_content(res))
                return

            # Default: list tools + read health.
            listed = await session.list_tools()
            print("== Tools ==")
            for t in listed.tools:
                desc = (t.description or "").replace("\n", " ")[:100]
                print(f"  {t.name:32s} {desc}")
            print("== Health ==")
            health = await session.read_resource("sclaw://health")
            print(_dump_content(health))


if __name__ == "__main__":
    asyncio.run(main())
