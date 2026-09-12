/**
 * SClaw MCP Server bridge.
 *
 * Exposes the SClaw ToolRegistry as a Model Context Protocol (MCP) server so
 * standard MCP clients (Claude Desktop, Cursor, mcporter, etc.) can call SClaw
 * tools, read resources, and receive 盯盘 (watch) alert notifications.
 *
 * Design:
 *   - Auto-converts every ToolRegistry tool into an MCP tool (zod input schema).
 *   - Runs each tool inside runWithUserId() so per-user tools (scheduler, watch,
 *     trade) behave as if invoked by the configured default user.
 *   - Wires WatchEngine 'alert' events into MCP logging notifications so clients
 *     receive real-time 盯盘 alerts without polling.
 *   - Exposes read-only resources: sclaw://watch (watch tasks), sclaw://health.
 *
 * Security: by default excludes shell/file/network/email/trade tools. Override via
 *   SCLAW_MCP_EXPOSE   (comma list -> ONLY these tools)
 *   SCLAW_MCP_BLOCK    (comma list -> block these, appended to default blocklist)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Tool, ToolParamDef } from "../tools/registry";
import type { WatchEngine } from "../watch-engine";
import { runWithUserId, getCurrentUserId } from "../request-context";

export interface McpBridgeOptions {
  toolRegistry: { getAll(): Tool[] };
  watchEngine?: WatchEngine;
  defaultUserId: string;
  exposeTools?: string[];
  blockTools?: string[];
}

// These tools are dangerous or infra-level and are NOT exposed via MCP by default.
// An external MCP client should not get arbitrary shell/file/subagent/email access,
// nor the ability to place trades without going through the standard confirmation gate.
const DEFAULT_BLOCK_TOOLS = new Set<string>([
  "bash",
  "grep",
  "glob",
  "read_file",
  "write_file",
  "sandbox",
  "agent_tool",
  "skill",
  "list_skills",
  "load_skill",
  "unload_skill",
  "send_email",
  "send_screen_report",
  "send_backtest_report",
  "trade",
]);

/** Map a ToolParamDef type string to a lenient zod schema. */
function paramToZod(p: ToolParamDef): z.ZodType {
  let base: z.ZodType;
  switch (p.type) {
    case "number":
      base = z.coerce.number();
      break;
    case "integer":
      base = z.coerce.number().int();
      break;
    case "boolean":
      base = z.coerce.boolean();
      break;
    case "array":
      base = z.array(z.any());
      break;
    case "object":
      base = z.record(z.string(), z.any());
      break;
    case "string":
    default:
      base = z.string();
      break;
  }
  base = base.describe(p.description);
  if (p.default !== undefined) base = base.default(p.default as never);
  if (p.required === false) base = base.optional();
  return base;
}

/** Build a zod raw shape object for McpServer.tool() from a Tool. */
function buildInputShape(tool: Tool): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const p of tool.parameters || []) shape[p.name] = paramToZod(p);
  return shape;
}

export function createMcpServer(opts: McpBridgeOptions): McpServer {
  const server = new McpServer(
    { name: "sclaw", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        logging: {},
      },
      instructions:
        "SClaw 股票分析与盯盘平台。可调用选股/行情/策略/风险/盯盘/深度分析等工具。港股持仓只读查询；任何交易操作须回到主界面经用户确认。",
    },
  );

  const exposeSet = opts.exposeTools?.length ? new Set(opts.exposeTools) : null;
  const blockSet = new Set(DEFAULT_BLOCK_TOOLS);
  for (const b of opts.blockTools || []) blockSet.add(b);

  // ===== Register tools =====
  for (const tool of opts.toolRegistry.getAll()) {
    if (exposeSet && !exposeSet.has(tool.name)) continue;
    if (blockSet.has(tool.name)) continue;
    if (!tool.description) continue;

    const shape = buildInputShape(tool);
    server.tool(tool.name, tool.description, shape, async (args) => {
      const userId = getCurrentUserId() ?? opts.defaultUserId;
      // tool.fn returns string | Promise<string>; async wrapper normalises to Promise<string>.
      const text = await runWithUserId(userId, async () =>
        tool.fn((args as Record<string, unknown>) || {}),
      );
      return { content: [{ type: "text", text: String(text) }] };
    });
  }

  // ===== Register read-only resources =====
  server.resource(
    "sclaw:watch-tasks",
    "sclaw://watch",
    { mimeType: "application/json", description: "所有盯盘任务列表" },
    async (uri) => {
      const tasks = opts.watchEngine?.listAllTasks() ?? [];
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(tasks, null, 2) },
        ],
      };
    },
  );

  server.resource(
    "sclaw:health",
    "sclaw://health",
    { mimeType: "application/json", description: "平台健康状态" },
    async (uri) => {
      const body = {
        ok: true,
        service: "sclaw-mcp",
        version: "1.0.0",
        toolCount: opts.toolRegistry.getAll().length,
        watchTasks: opts.watchEngine?.listAllTasks().length ?? 0,
        timestamp: Date.now(),
      };
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) },
        ],
      };
    },
  );

  // ===== Wire WatchEngine alerts -> MCP logging notifications =====
  // Each McpServer instance holds ONE transport connection, so the handler is
  // scoped to this instance and is removed when the server is closed. This lets
  // the HTTP mount build a fresh McpServer per session without leaking listeners.
  if (opts.watchEngine) {
    const handler = (alert: any) => {
      // sendLoggingMessage only delivers if the client hasn't marked it "ignored".
      server.server
        .sendLoggingMessage({
          level: "info",
          data: {
            type: "watch_alert",
            message: alert?.message ?? "",
            stock: alert?.stock ?? "",
            stockName: alert?.stockName ?? "",
            price: alert?.price,
            changePercent: alert?.changePercent,
            conditionType: alert?.conditionType,
            ticket: alert?.taskLabel ?? "",
            timestamp: alert?.timestamp ?? Date.now(),
          },
        })
        .catch(() => {});
    };
    opts.watchEngine.on("alert", handler);

    const originalClose = server.close.bind(server);
    (server as unknown as { close: () => Promise<void> }).close = async () => {
      opts.watchEngine!.off("alert", handler);
      await originalClose();
    };
  }

  return server;
}
