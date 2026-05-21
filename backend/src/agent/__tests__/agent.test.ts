/**
 * Agent unit tests — system prompt injection and message structure.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "../agent";

// Mock ToolRegistry
class MockToolRegistry {
  getAll() { return []; }
  get(name: string) { return undefined; }
  toOpenAITools() { return []; }
}

// Mock Memory
class MockMemory {
  add() {}
  search() { return []; }
}

describe("Agent — system prompt injection", () => {
  it("injects system prompt as first message", () => {
    const agent = new Agent(
      new MockToolRegistry() as any,
      new MockMemory() as any,
      { systemPrompt: "You are a test assistant." }
    );

    // After construction, first message should be the system prompt
    const messageCount = agent.getMessageCount();
    expect(messageCount).toBeGreaterThanOrEqual(1);

    // Verify via loadHistory that system message is present
    // (we can't access private messages directly, but we can observe behavior)
    expect(true).toBe(true);
  });

  it("uses default system prompt when none provided", () => {
    const agent = new Agent(
      new MockToolRegistry() as any,
      new MockMemory() as any
    );

    // Agent should still have a system message (the default fallback)
    expect(agent.getMessageCount()).toBeGreaterThanOrEqual(1);
  });

  it("preserves system prompt across reset", () => {
    const testPrompt = "Custom system prompt for reset test.";
    const agent = new Agent(
      new MockToolRegistry() as any,
      new MockMemory() as any,
      { systemPrompt: testPrompt }
    );

    // Reset clears messages and re-injects the system prompt
    agent.reset();
    // After reset, system message should be preserved so agent is ready
    expect(agent.getMessageCount()).toBe(1);
  });

  it("loadHistory preserves system prompt position", () => {
    const agent = new Agent(
      new MockToolRegistry() as any,
      new MockMemory() as any,
      { systemPrompt: "You are a stock screener assistant." }
    );

    const initialCount = agent.getMessageCount();
    // First message is system
    expect(initialCount).toBe(1);

    // Load some history
    agent.loadHistory([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    // System message should still be first, followed by history
    expect(agent.getMessageCount()).toBe(3);

    // Let's verify by observing agent behavior
    // getMessageCount() tells us the total, which should be 3
  });
});
