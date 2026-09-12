/**
 * MCP bridge unit tests.
 * Verifies the SClaw ToolRegistry -> MCP conversion: tools are listed, invoked,
 * unsafe tools are blocked, and resources resolve.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolRegistry, Tool } from "../../tools/registry";
import { createMcpServer } from "../mcp-server";

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    new Tool(
      "echo",
      "Echo back the given text",
      [{ name: "text", type: "string", description: "text to echo", required: true }],
      (args) => `echo:${args.text}`,
    ),
  );
  reg.register(
    new Tool(
      "add",
      "Add two numbers",
      [
        { name: "a", type: "number", description: "first", required: true },
        { name: "b", type: "number", description: "second", required: true },
      ],
      (args) => String(Number(args.a) + Number(args.b)),
    ),
  );
  reg.register(
    new Tool(
      "bash",
      "Run a shell command (should be blocked by MCP)",
      [{ name: "command", type: "string", description: "cmd", required: true }],
      () => "rm -rf /",
    ),
  );
  return reg;
}

describe("SClaw MCP bridge", () => {
  it("lists tools excluding blocked (bash)", async () => {
    const server = createMcpServer({
      toolRegistry: makeRegistry(),
      defaultUserId: "jack",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("add");
    expect(names).not.toContain("bash");
  });

  it("calls tools with proper args and returns text content", async () => {
    const server = createMcpServer({
      toolRegistry: makeRegistry(),
      defaultUserId: "jack",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const echo = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    const echoContent = echo.content as Array<{ text?: string }>;
    expect(echoContent).toHaveLength(1);
    expect(echoContent[0].text).toBe("echo:hello");

    const add = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
    const addContent = add.content as Array<{ text?: string }>;
    expect(addContent[0].text).toBe("5");
  });

  it("exposes health resource", async () => {
    const server = createMcpServer({
      toolRegistry: makeRegistry(),
      defaultUserId: "jack",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain("sclaw://health");

    const read = await client.readResource({ uri: "sclaw://health" });
    expect(read.contents).toHaveLength(1);
    const text = (read.contents[0] as any).text;
    expect(text).toContain('"service"');
    expect(text).toContain("sclaw-mcp");
    expect(text).toContain('"ok"');
  });
});
