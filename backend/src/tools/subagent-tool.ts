/**
 * agent_tool — Subagent spawning tool
 *
 * When the main agent encounters a complex, multi-step task, it calls this
 * tool to spawn a sub-agent. The sub-agent gets its own LLM loop with
 * tool access, runs autonomously, and returns results.
 */

import { ToolRegistry, Tool } from "./registry";
import { SubAgentManager } from "../agent/sub-agent-manager";
import { listBuiltInAgents } from "../agent/built-in-agents";
import { SubAgentType } from "../agent/sub-agent-types";

/** Register the agent_tool in the ToolRegistry */
export function registerSubAgentTool(
  registry: ToolRegistry,
  subAgentManager: SubAgentManager,
  getUserId: () => string,
): void {
  // Build the subagent_type enum description dynamically from built-in agents
  const agentTypeChoices = listBuiltInAgents()
    .map((a) => `    - "${a.agentType}": ${a.description}`)
    .join("\n");

  registry.register(
    new Tool(
      "agent_tool",
      `Spawn a sub-agent to handle complex, multi-step tasks autonomously.

Use this tool when:
- A task requires multiple steps (≥3 tool calls)
- You need to delegate specialized work (analysis, research, code review)
- You want a task to run in the background while you continue
- You need an independent verification / second opinion

Available subagent types (subagent_type):
${agentTypeChoices}

For sync mode (default): set run_in_background=false — the agent waits for result.
For async mode: set run_in_background=true — launches in background, returns task ID.`,
      [
        {
          name: "description",
          type: "string",
          description: "A short (3-5 word) description of the task for the sub-agent",
        },
        {
          name: "prompt",
          type: "string",
          description: "The full task prompt for the sub-agent to perform. Be specific and include all context needed.",
        },
        {
          name: "subagent_type",
          type: "string",
          description: `Sub-agent specialization type. Examples: coder, analyzer, researcher, debugger, planner, reviewer, integrator. Default: general-purpose. Options: ${listBuiltInAgents().map((a) => a.agentType).join(", ")}`,
          required: false,
        },
        {
          name: "run_in_background",
          type: "boolean",
          description: "If true, runs in background and returns task ID for later retrieval. Default: false",
          required: false,
        },
        {
          name: "cwd",
          type: "string",
          description: "Absolute path to run the sub-agent in (optional). Not yet implemented for sub-agents.",
          required: false,
        },
      ],
      async (args: Record<string, unknown>) => {
        const description = String(args.description || "");
        const prompt = String(args.prompt || "");
        const subagentType: SubAgentType = String(args.subagent_type || "general-purpose") as SubAgentType;
        const runInBackground = Boolean(args.run_in_background);

        if (!description.trim()) return "Error: description is required";
        if (!prompt.trim()) return "Error: prompt is required";

        const userId = getUserId();

        try {
          // Create the task
          const taskId = subAgentManager.createTask(
            userId,
            description,
            prompt,
            subagentType,
          );

          if (runInBackground) {
            // Launch async and return immediately
            const result = await subAgentManager.runTaskAsync(taskId);
            return JSON.stringify(result, null, 2);
          } else {
            // Run synchronously (blocking)
            const result = await subAgentManager.runTaskSync(taskId);
            return JSON.stringify(result, null, 2);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error spawning sub-agent: ${msg}`;
        }
      },
    ),
  );
}
