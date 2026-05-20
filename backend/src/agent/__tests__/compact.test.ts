import { describe, it, expect } from "vitest";
import {
  shouldCompact,
  compactContext,
  microCompactMessages,
  ChatMessage,
} from "../compact";

// ============================================================================
// Helpers
// ============================================================================

function makeMessages(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}: ${"x".repeat(50)}`,
    });
  }
  return msgs;
}

// ============================================================================
// shouldCompact
// ============================================================================

describe("shouldCompact", () => {
  it("returns false for short history", () => {
    expect(shouldCompact(makeMessages(5))).toBe(false);
    expect(shouldCompact(makeMessages(19))).toBe(false);
  });

  it("returns true for long history", () => {
    expect(shouldCompact(makeMessages(21))).toBe(true);  // threshold is >20
    expect(shouldCompact(makeMessages(50))).toBe(true);
  });

  it("returns false for empty history", () => {
    expect(shouldCompact([])).toBe(false);
  });
});

// ============================================================================
// compactContext
// ============================================================================

describe("compactContext", () => {
  it("returns same array if under threshold", async () => {
    const msgs = makeMessages(10);
    const result = await compactContext(msgs);
    expect(result).toBe(msgs); // same reference
  });

  it("compacts history over threshold without LLM", async () => {
    const msgs = makeMessages(25);
    const result = await compactContext(msgs);

    // Should contain summary + recent messages
    expect(result.length).toBeGreaterThanOrEqual(10);
    expect(result.length).toBeLessThan(msgs.length);

    // Should have summary messages at the start
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toContain("Compacted Conversation Summary");

    // Should have recent messages preserved
    const lastMsg = result[result.length - 1];
    expect(lastMsg.role).toMatch(/^(user|assistant)$/);
    expect(lastMsg.content).toContain("Message 25");
  });
});

// ============================================================================
// microCompactMessages
// ============================================================================

describe("microCompactMessages", () => {
  it("leaves small messages unchanged", () => {
    const msgs: ChatMessage[] = [
      { role: "tool", content: "short result" },
      { role: "user", content: "hello" },
    ];
    const result = microCompactMessages(msgs);
    expect(result[0].content).toBe("short result");
  });

  it("compresses long tool results by lines", () => {
    const longLines = Array.from(
      { length: 200 },
      (_, i) => `Line ${i}: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    );
    const msgs: ChatMessage[] = [
      { role: "tool", content: longLines.join("\n") },
    ];
    const result = microCompactMessages(msgs);
    expect(result[0].content.length).toBeLessThan(longLines.join("\n").length);
    expect(result[0].content).toContain("lines compressed");
  });

  it("compresses very long tool results by chars", () => {
    const longContent = "x".repeat(10_000);
    const msgs: ChatMessage[] = [{ role: "tool", content: longContent }];
    const result = microCompactMessages(msgs);
    expect(result[0].content.length).toBeLessThan(10_000);
    expect(result[0].content).toContain("truncated by Micro-Compact");
  });

  it("does not touch non-tool messages", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "x".repeat(10_000) },
      { role: "assistant", content: "x".repeat(10_000) },
    ];
    const result = microCompactMessages(msgs);
    expect(result[0].content.length).toBe(10_000);
    expect(result[1].content.length).toBe(10_000);
  });
});
