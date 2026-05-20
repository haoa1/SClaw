/**
 * memory_recall tool — search the AI agent's memory.
 * The actual execution is handled by the Agent class
 * (which has access to the per-user Memory instance).
 * This file just registers the tool definition so the LLM
 * knows about it.
 */

import { ToolRegistry, Tool } from "./registry";

export function registerMemoryTools(registry: ToolRegistry): void {
  registry.register(
    new Tool(
      "memory_recall",
      "Launch a sub-agent to search your memory for past observations, decisions, results, and errors. The sub-agent will use file-reading tools to explore memory files and return a structured summary.",
      [
        {
          name: "query",
          type: "string",
          description: "Natural language query to search for in memory files",
        },
        {
          name: "limit",
          type: "number",
          description: "Max results to return (default: 5)",
          required: false,
        },
        {
          name: "max_turns",
          type: "number",
          description: "Max search turns for the sub-agent (default: 8)",
          required: false,
        },
        {
          name: "detail_level",
          type: "string",
          description: "Detail level: 'brief' (summary only), 'detailed' (full content), 'balanced' (default)",
          required: false,
        },
      ],
      // Placeholder — Agent.executeTool() will intercept this
      // and delegate to the per-user Memory instance.
      (_args: Record<string, unknown>) => {
        return "memory_recall is handled by the agent directly";
      }
    )
  );
}
