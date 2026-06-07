/**
 * compact tool — manually trigger context compression.
 * The actual execution is handled by the Agent class
 * (which has access to the messages array and LLM client).
 * This file just registers the tool definition so the LLM
 * knows about it.
 */

import { ToolRegistry, Tool } from "./registry";

export function registerCompactTool(registry: ToolRegistry): void {
  registry.register(
    new Tool(
      "compact",
      "Compress the conversation history to save tokens and reduce context size. " +
      "Use this when the conversation is getting too long or when you notice context is full. " +
      "It summarizes old messages using AI and keeps the most recent messages intact. " +
      "After compacting, old messages are replaced with a summary — no information is lost, " +
      "just condensed.",
      [
        {
          name: "reason",
          type: "string",
          description: "Optional reason for compacting (e.g. 'context seems full', 'starting new topic')",
          required: false,
        },
      ],
      // Placeholder — Agent.executeTool() intercepts this
      (_args: Record<string, unknown>) => {
        return "compact is handled by the agent directly";
      }
    )
  );
}
