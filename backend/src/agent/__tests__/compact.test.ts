import { describe, it, expect } from "vitest";
import {
  shouldCompact,
  compactContext,
  microCompactMessages,
  estimateTokens,
  ChatMessage,
} from "../compact";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Token-based threshold: COMPACT_TOKEN_THRESHOLD = 100_000 tokens.
 * With ASCII chars at 4 chars/token, need ~400k chars to trigger compact.
 * Each "big" message has ~20k chars, so ~20 messages = 400k chars = ~100k tokens.
 */
const BIG_MSG_SIZE = 20_000;

function makeMessages(n: number, contentSize: number = 50): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}: ${"x".repeat(contentSize)}`,
    });
  }
  return msgs;
}

function makeBigMessages(n: number): ChatMessage[] {
  return makeMessages(n, BIG_MSG_SIZE);
}

// ============================================================================
// shouldCompact — now token-based (100k token threshold)
// ============================================================================

describe("shouldCompact", () => {
  it("returns false for short history", () => {
    // Small messages: < 100k tokens
    expect(shouldCompact(makeMessages(5))).toBe(false);
    expect(shouldCompact(makeMessages(100))).toBe(false);
  });

  it("returns true for large history (token threshold)", () => {
    // Big messages: 25 × 20k chars = 500k chars ≈ 125k tokens > 100k
    expect(shouldCompact(makeBigMessages(25))).toBe(true);
  });

  it("returns false for empty history", () => {
    expect(shouldCompact([])).toBe(false);
  });

  it("estimateTokens is correct", () => {
    // ASCII: 4 chars per token → 100 chars = 25 tokens
    expect(estimateTokens("x".repeat(100))).toBe(25);
    // CJK: 1.5 chars per token; ASCII: 4 chars per token
    // 4 CJK chars (你好世界) = ceil(4/1.5) = ceil(2.67) = 3
    // 3 ASCII chars (abc) = ceil(3/4) = ceil(0.75) = 1
    // Total: 3 + 1 = 4
    expect(estimateTokens("你好世界abc")).toBe(4);
  });
});

// ============================================================================
// compactContext — now token-based
// ============================================================================

describe("compactContext", () => {
  it("returns same array if under token threshold", async () => {
    const msgs = makeMessages(10);
    const result = await compactContext(msgs);
    expect(result).toBe(msgs); // same reference
  });

  it("compacts large history over token threshold without LLM", async () => {
    const msgs = makeBigMessages(25);
    const result = await compactContext(msgs);

    // Should be shorter than original
    expect(result.length).toBeLessThan(msgs.length);

    // Should have summary messages at the start
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toContain("Compacted Conversation Summary");

    // Should have recent messages preserved (at least a few)
    expect(result.length).toBeGreaterThanOrEqual(2);
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
