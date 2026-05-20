/**
 * Compact utility — sums up old messages to keep context window under control.
 * Claude Code-style: replaces a batch of older messages with a summary.
 */

import { LLMClient, LLMMessage } from "../agent/llm";

export class CompactEngine {
  private llm: LLMClient;
  private threshold: number;

  constructor(threshold: number = 30) {
    this.llm = new LLMClient();
    this.threshold = threshold;
  }

  /**
   * Check if compact is needed based on total message count.
   */
  shouldCompact(messages: LLMMessage[]): boolean {
    return messages.length > this.threshold;
  }

  /**
   * Compact messages by summarizing the oldest batch.
   * Returns a new message array where old messages are replaced with a summary.
   */
  async compact(messages: LLMMessage[]): Promise<LLMMessage[]> {
    if (messages.length <= this.threshold) return messages;

    // Keep: system + recent messages (last N)
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    const keepCount = Math.floor(this.threshold * 0.6); // keep 60% most recent
    const compactBatch = nonSystem.slice(0, nonSystem.length - keepCount);
    const recentBatch = nonSystem.slice(nonSystem.length - keepCount);

    if (compactBatch.length < 3) {
      // Not enough to compact
      return messages;
    }

    // Summarize the compact batch
    const summary = await this.summarize(compactBatch);

    const result: LLMMessage[] = [];
    if (systemMsg) result.push(systemMsg);
    result.push({
      role: "user",
      content: `[Previous conversation summarized]\n\n${summary}`,
    });
    result.push(...recentBatch);

    return result;
  }

  private async summarize(messages: LLMMessage[]): Promise<string> {
    const text = messages
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join("\n\n");

    const prompt: LLMMessage[] = [
      {
        role: "system",
        content:
          "Summarize the following conversation concisely. " +
          "Capture key decisions, file changes, questions asked, and answers given. " +
          "Keep it under 500 words. Use bullet points.",
      },
      { role: "user", content: text },
    ];

    try {
      const response = await this.llm.chat(prompt, []);
      return response.content || "(summary unavailable)";
    } catch {
      // Fallback: just count messages
      return `Conversation with ${messages.length} messages (${messages.filter((m) => m.role === "user").length} user, ${messages.filter((m) => m.role === "assistant").length} assistant).`;
    }
  }
}
