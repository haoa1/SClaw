/**
 * agent_tool — 统一子代理管理工具
 *
 * 通过 sub_cmd 区分模式：
 *   sub_cmd="spawn" (默认) — 生成子代理执行任务
 *   sub_cmd="get"          — 查询任务状态
 *   sub_cmd="stop"         — 取消运行中的任务
 *   sub_cmd="list"         — 列出用户的所有任务
 */

import { ToolRegistry, Tool } from "./registry";
import { SubAgentManager } from "../agent/sub-agent-manager";
import { listBuiltInAgents } from "../agent/built-in-agents";
import { SubAgentType, SubAgentTaskStatus } from "../agent/sub-agent-types";

/** Register the unified agent_tool in the ToolRegistry */
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
      `Unified sub-agent management tool. Use sub_cmd to choose operation.

spawn (default) — Spawn a sub-agent to handle complex, multi-step tasks autonomously.
  Use when a task requires ≥3 tool calls, needs specialized work, or should run in background.
  Available subagent types:
${agentTypeChoices}

get — Get the status and details of a subagent task by ID.
  Returns: status, description, result (if completed), error (if failed).

stop — Cancel a running subagent task by ID. Safe to use on completed/failed tasks.

list — List all subagent tasks for current user (up to 20 most recent).
  Optional filter by status: pending, running, completed, failed, cancelled.`,
      [
        {
          name: "sub_cmd",
          type: "string",
          description: `Sub-command: "spawn" (default, launch sub-agent), "get" (query task), "stop" (cancel task), "list" (list tasks)`,
          required: false,
        },
        // === spawn 参数 ===
        {
          name: "description",
          type: "string",
          description: "A short (3-5 word) description of the task (required for sub_cmd=spawn)",
          required: false,
        },
        {
          name: "prompt",
          type: "string",
          description: "The full task prompt for the sub-agent (required for sub_cmd=spawn)",
          required: false,
        },
        {
          name: "subagent_type",
          type: "string",
          description: `Sub-agent specialization. Default: general-purpose. Options: ${listBuiltInAgents().map((a) => a.agentType).join(", ")}`,
          required: false,
        },
        {
          name: "run_in_background",
          type: "boolean",
          description: "If true, runs in background and returns task ID. Default: false",
          required: false,
        },
        // === get/stop 参数 ===
        {
          name: "task_id",
          type: "string",
          description: "Task ID (required for sub_cmd=get and sub_cmd=stop)",
          required: false,
        },
        // === list 参数 ===
        {
          name: "status",
          type: "string",
          description: 'Filter by status: pending, running, completed, failed, cancelled (optional, for sub_cmd=list)',
          required: false,
        },
      ],
      async (args: Record<string, unknown>) => {
        const subCmd = String(args.sub_cmd || "spawn").toLowerCase();
        const userId = getUserId();

        try {
          switch (subCmd) {
            // ===== SPAWN =====
            case "spawn": {
              const description = String(args.description || "");
              const prompt = String(args.prompt || "");
              const subagentType: SubAgentType = String(args.subagent_type || "general-purpose") as SubAgentType;
              const runInBackground = Boolean(args.run_in_background);

              if (!description.trim()) return "Error: description is required for sub_cmd=spawn";
              if (!prompt.trim()) return "Error: prompt is required for sub_cmd=spawn";

              const taskId = subAgentManager.createTask(userId, description, prompt, subagentType);

              if (runInBackground) {
                const result = await subAgentManager.runTaskAsync(taskId);
                return JSON.stringify(result, null, 2);
              } else {
                const result = await subAgentManager.runTaskSync(taskId);
                return JSON.stringify(result, null, 2);
              }
            }

            // ===== GET =====
            case "get": {
              const taskId = String(args.task_id || "");
              if (!taskId) return "Error: task_id is required for sub_cmd=get";

              const task = subAgentManager.getTask(taskId);
              if (!task) return `Task ${taskId} not found`;

              return JSON.stringify({
                id: task.id,
                status: task.status,
                description: task.description,
                subagentType: task.subagentType,
                createdAt: task.createdAt,
                completedAt: task.completedAt,
                result: task.result ? task.result.slice(0, 2000) : undefined,
                error: task.error,
                turnCount: task.turnCount,
                inputTokens: task.inputTokens,
                outputTokens: task.outputTokens,
              }, null, 2);
            }

            // ===== STOP =====
            case "stop": {
              const taskId = String(args.task_id || "");
              if (!taskId) return "Error: task_id is required for sub_cmd=stop";

              const cancelled = subAgentManager.cancelTask(taskId);
              if (cancelled) return `Task ${taskId} has been cancelled.`;

              const task = subAgentManager.getTask(taskId);
              if (!task) return `Task ${taskId} not found.`;
              return `Task ${taskId} is already ${task.status}.`;
            }

            // ===== LIST =====
            case "list": {
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
                  result: t.result ? t.result.slice(0, 200) : undefined,
                  error: t.error,
                  turnCount: t.turnCount,
                })),
                null,
                2,
              );
            }

            default:
              return `Unknown sub_cmd "${subCmd}". Valid options: spawn, get, stop, list`;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error executing agent_tool: ${msg}`;
        }
      },
    ),
  );
}

/**
 * Old per-user task_list registration — preserved for backward compatibility.
 * Now handled by agent_tool(sub_cmd="list") instead.
 */
export { registerUserTaskListTool } from "./subagent-task-tools";
