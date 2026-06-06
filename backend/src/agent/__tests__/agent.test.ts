/**
 * Agent unit tests — system prompt injection and message structure.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Agent } from "../agent";

// Mock ToolRegistry
class MockToolRegistry {
  getAll() { return []; }
  get(name: string) { return undefined; }
  toOpenAITools() { return []; }
}

// Mock Memory
class MockMemory {
  items: Array<{ type: string; content: string; tags: string[]; timestamp: string }> = [];
  add(entry: { type: string; content: string; tags: string[] }) {
    this.items.push({ ...entry, timestamp: new Date().toISOString() });
  }
  search() { return []; }
}

describe("Agent — system prompt injection", () => {
  let toolRegistry: MockToolRegistry;
  let memory: MockMemory;

  beforeEach(() => {
    toolRegistry = new MockToolRegistry();
    memory = new MockMemory();
  });

  it("injects system prompt as first message", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any,
      { systemPrompt: "You are a test assistant." }
    );

    const messages = (agent as any).messages;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("You are a test assistant.");
  });

  it("uses default system prompt when none provided", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    const messages = (agent as any).messages;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("helpful AI assistant");
  });

  it("preserves system prompt across reset", () => {
    const testPrompt = "Custom system prompt for reset test.";
    const agent = new Agent(
      toolRegistry as any,
      memory as any,
      { systemPrompt: testPrompt }
    );

    // Initial: system message exists
    expect(agent.getMessageCount()).toBeGreaterThanOrEqual(1);

    agent.reset();

    // After reset, messages contain only the system message
    expect(agent.getMessageCount()).toBe(1);
    const messages = (agent as any).messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(testPrompt);
  });

  it("loadHistory preserves system prompt position", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any,
      { systemPrompt: "You are a stock screener assistant." }
    );

    // First message is system
    expect(agent.getMessageCount()).toBe(1);

    // Load some history
    agent.loadHistory([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    // System message should still be first, followed by history
    expect(agent.getMessageCount()).toBe(3);

    const messages = (agent as any).messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("stock screener");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Hello");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("Hi there");
  });

  it("loadHistory handles segments format", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any,
      { systemPrompt: "Test" }
    );

    agent.loadHistory([
      {
        role: "assistant",
        content: "",
        segments: [
          { type: "text", data: "Here is my response" },
          { type: "tool_call", data: '{"name":"read_file","args":{"path":"test.txt"}}' },
        ],
      },
    ]);

    const messages = (agent as any).messages;
    expect(messages.length).toBe(2); // system + 1 assistant
    expect(messages[1].content).toBe("Here is my response");
  });

  it("reset clears token stats", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    agent.reset();

    const stats = agent.getStats();
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
  });

  it("reset preserves system prompt from constructor", () => {
    const testPrompt = "Persistent test prompt";
    const agent = new Agent(
      toolRegistry as any,
      memory as any,
      { systemPrompt: testPrompt }
    );

    // Reset multiple times
    agent.reset();
    agent.reset();
    agent.reset();

    expect(agent.getMessageCount()).toBe(1);
    const messages = (agent as any).messages;
    expect(messages[0].content).toContain(testPrompt);
  });
});

describe("Agent — skill management", () => {
  let toolRegistry: MockToolRegistry;
  let memory: MockMemory;

  beforeEach(() => {
    toolRegistry = new MockToolRegistry();
    memory = new MockMemory();
  });

  it("loadSkill adds skill to loaded skills", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    const result = agent.loadSkill("test-skill", "# Test Skill\nDo something useful.");
    expect(result).toContain("test-skill");
    expect(result).toContain("loaded");
    expect(agent.getLoadedSkills()).toContain("test-skill");
  });

  it("loadSkill rejects empty name", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    const result = agent.loadSkill("", "content");
    expect(result).toBe("Skill name and content are required.");
  });

  it("unloadSkill removes a loaded skill", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    agent.loadSkill("skill-a", "content a");
    agent.loadSkill("skill-b", "content b");
    expect(agent.getLoadedSkills()).toEqual(["skill-a", "skill-b"]);

    const result = agent.unloadSkill("skill-a");
    expect(result).toContain("unloaded");
    expect(agent.getLoadedSkills()).toEqual(["skill-b"]);
  });

  it("unloadSkill returns error for non-loaded skill", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    const result = agent.unloadSkill("nonexistent");
    expect(result).toContain("not loaded");
  });
});

describe("Agent — message structure", () => {
  let toolRegistry: MockToolRegistry;
  let memory: MockMemory;

  beforeEach(() => {
    toolRegistry = new MockToolRegistry();
    memory = new MockMemory();
  });

  it("rebuildSystemMessage includes loaded skills in system prompt", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any,
      { systemPrompt: "Base prompt." }
    );

    agent.loadSkill("math", "# Math Helper\nYou can do math.");
    agent.loadSkill("translate", "# Translator\nYou can translate text.");

    const messages = (agent as any).messages;
    const systemContent = messages[0].content;
    expect(systemContent).toContain("Base prompt.");
    expect(systemContent).toContain("Math Helper");
    expect(systemContent).toContain("Translator");
    expect(systemContent).toContain('<skill name="math">');
    expect(systemContent).toContain('<skill name="translate">');
  });

  it("unloadSkill removes skill from system prompt", () => {
    const agent = new Agent(
      toolRegistry as any,
      memory as any
    );

    agent.loadSkill("temp", "Temporary skill.");
    expect(agent.getLoadedSkills()).toHaveLength(1);

    agent.unloadSkill("temp");
    expect(agent.getLoadedSkills()).toHaveLength(0);

    const messages = (agent as any).messages;
    expect(messages[0].content).not.toContain("Temporary skill.");
    expect(messages[0].content).not.toContain('<skill name="temp">');
  });
});
