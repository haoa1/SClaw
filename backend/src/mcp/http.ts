/**
 * Mount the SClaw MCP server over HTTP + SSE for remote MCP clients.
 *
 * Endpoints:
 *   GET  /mcp            -> SSE stream (client receives `endpoint` event with session id)
 *   POST /mcp/message    -> JSON-RPC messages (client POSTs to the endpoint from the SSE event)
 *
 * Each SSE session gets its OWN McpServer instance. The SDK's Protocol allows one
 * transport per Protocol, so sharing a single McpServer across sessions throws
 * "Already connected to a transport". Building a fresh server per session avoids
 * that and lets multiple MCP clients connect concurrently.
 */

import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

interface Session {
  transport: SSEServerTransport;
  server: McpServer;
}

export function createMcpHttpHandler(buildServer: () => McpServer): express.Router {
  const router = express.Router();
  // sessionId -> active session (transport + its own server instance)
  const sessions = new Map<string, Session>();

  router.get("/", (req, res) => {
    const transport = new SSEServerTransport("/mcp/message", res, {
      enableDnsRebindingProtection: false,
    });
    const server = buildServer();
    sessions.set(transport.sessionId, { transport, server });

    const cleanup = () => {
      const session = sessions.get(transport.sessionId);
      if (!session) return;
      sessions.delete(transport.sessionId);
      // close() removes the per-session watchEngine listener, then releases the transport.
      session.server.close().catch((err) => {
        console.error("[MCP] close error:", err);
      });
    };
    res.on("close", cleanup);

    server.connect(transport).catch((err) => {
      console.error("[MCP] connect error:", err);
      cleanup();
    });
  });

  router.post("/message", async (req, res) => {
    const sessionId = (req.query.sessionId as string) || (req.body?.sessionId as string);
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(400).json({ error: "Unknown or expired MCP session" });
      return;
    }
    await session.transport.handlePostMessage(req, res, req.body);
  });

  return router;
}
