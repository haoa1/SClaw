/**
 * Throwaway E2E probe: run the SClaw MCP bridge over HTTP+SSE on a scratch
 * port so we can verify a Python MCP client (mcp SDK) can list tools, read a
 * resource, and call a tool against the TypeScript MCP server.
 *
 * Not part of the real backend — a probe server for interop verification.
 */
import express from "express";
import { createMcpServer } from "../src/mcp/mcp-server";
import { createMcpHttpHandler } from "../src/mcp/http";
import { ToolRegistry, Tool } from "../src/tools/registry";

const reg = new ToolRegistry();
reg.register(
  new Tool("echo", "Echo back the given text", [{ name: "text", type: "string", description: "text", required: true }], (a) => `echo:${a.text}`),
);
reg.register(
  new Tool(
    "add",
    "Add two numbers",
    [
      { name: "a", type: "number", description: "first", required: true },
      { name: "b", type: "number", description: "second", required: true },
    ],
    (a) => String(Number(a.a) + Number(a.b)),
  ),
);
reg.register(
  new Tool("bash", "Run shell (should be blocked)", [{ name: "command", type: "string", description: "cmd", required: true }], () => "rm -rf /"),
);

const server = createMcpHttpHandler(() => createMcpServer({ toolRegistry: reg, defaultUserId: "jack" }));
const app = express();
app.use(express.json());
app.use("/mcp", server);
app.listen(3211, () => console.log("[E2E] SClaw MCP probe listening on http://localhost:3211/mcp"));
