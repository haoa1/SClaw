/**
 * SubAgent Task Management Tools
 *
 * These tools allow the main agent to manage subagent tasks:
 *   - task_get      → get task status/details
 *   - task_list     → list all tasks for a user
 *   - task_stop     → cancel a running task
 *
 * These are separate from agent_tool so the main agent can
 * inspect/monitor subagents without spawning new ones.
 */

import { ToolRegistry, Tool } from "./registry";
import { SubAgentManager } from "../agent/sub-agent-manager";
import { SubAgentTaskStatus } from "../agent/sub-agent-types";

export function registerSubAgentTaskTools(
  registry: ToolRegistry,
  subAgentManager: SubAgentManager,
): void {
  // ===== task_get =====
  registry.register(
    new Tool(
      "task_get",
      `Get the status and details of a subagent task.

Use this to check on a task that was launched in the background (run_in_background=true).
Returns: status, description, result (if completed), error (if failed).`,
      [
        {
          name: "task_id",
          type: "string",
          description: "The task ID (e.g., 'sa-xxxxxxxx')",
        },
      ],
      (args: Record<string, unknown>) => {
        const taskId = String(args.task_id || "");
        if (!taskId) return "Error: task_id is required";

        const task = subAgentManager.getTask(taskId);
        if (!task) return `Task ${taskId} not found`;

        return JSON.stringify(
          {
            id: task.id,
            status: task.status,
            description: task.description,
            subagentType: task.subagentType,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
            result: task.result
              ? task.result.slice(0, 2000)
              : undefined,
            error: task.error,
            turnCount: task.turnCount,
            inputTokens: task.inputTokens,
            outputTokens: task.outputTokens,
          },
          null,
          2,
        );
      },
    ),
  );

  // ===== task_stop =====
  registry.register(
    new Tool(
      "task_stop",
      `Cancel a running subagent task by ID.

Safe to use on completed or failed tasks — does nothing if already done.
Returns true if the task was successfully cancelled.`,
      [
        {
          name: "task_id",
          type: "string",
          description: "The task ID to cancel",
        },
      ],
      (args: Record<string, unknown>) => {
        const taskId = String(args.task_id || "");
        if (!taskId) return "Error: task_id is required";

        const cancelled = subAgentManager.cancelTask(taskId);
        if (cancelled) {
          return `Task ${taskId} has been cancelled.`;
        }

        const task = subAgentManager.getTask(taskId);
        if (!task) return `Task ${taskId} not found.`;
        return `Task ${taskId} is already ${task.status}.`;
      },
    ),
  );
}

/** Register a per-user task_list tool */
export function registerUserTaskListTool(
  registry: ToolRegistry,
  subAgentManager: SubAgentManager,
  userId: string,
): void {
  registry.register(
    new Tool(
      "task_list",
      `List all subagent tasks for current user. Returns up to 20 most recent tasks.`,
      [
        {
          name: "status",
          type: "string",
          description: "Optional filter by status: pending, running, completed, failed, cancelled",
          required: false,
        },
      ],
      (args: Record<string, unknown>) => {
        const status = args.status
          ? (args.status as SubAgentTaskStatus)
          : undefined;

        const tasks = subAgentManager.listTasks(userId, status, 20);
        if (tasks.length === 0) return "No subagent tasks found.";

        return JSON.stringify(
          tasks.map((t) => ({
            id: t.id,
            status: t.status,
            description: t.description,
            subagentType: t.subagentType,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
            result: t.result
              ? t.result.slice(0, 200)
              : undefined,
            error: t.error,
            turnCount: t.turnCount,
          })),
          null,
          2,
        );
      },
    ),
  );
}
