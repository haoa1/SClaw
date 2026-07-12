/**
 * SubAgent Manager
 *
 * Manages the full lifecycle of subagent tasks:
 *   - createTask: register a new task
 *   - runTask: execute synchronously (blocking) or launch async
 *   - getTask / listTasks: query tasks
 *   - cancelTask: abort a running task
 *   - getResult: retrieve completed task result
 *
 * Architecture:
 *   SubAgentManager (singleton, shared across requests)
 *   ├── tasks: Map<taskId, SubAgentTask>
 *   ├── createTask()        → returns taskId
 *   ├── runTaskSync()       → blocking LLM loop, returns result
 *   └── runTaskAsync()      → launches background promise, returns immediately
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  SubAgentTask,
  SubAgentTaskStatus,
  SubAgentType,
  AgentDefinition,
  AgentToolSyncResult,
  AgentToolAsyncResult,
} from "./sub-agent-types";
import { getBuiltInAgent, listBuiltInAgents } from "./built-in-agents";
import { SubAgentYamlLoader } from "./subagent-yaml-loader";
import { SubAgentLogger, SubAgentRunMeta } from "./subagent-logger";
import { LLMClient, LLMMessage } from "./llm";
import { ToolRegistry } from "../tools/registry";

/** Per-user task limit to prevent runaway agents */
const MAX_TASKS_PER_USER = 50;

/** Output directory for async task results */
const SUBAGENT_OUTPUT_DIR = path.join(os.homedir(), ".sclaw", "subagent-tasks");

export class SubAgentManager {
  private tasks = new Map<string, SubAgentTask>();
  private registry: ToolRegistry;
  private yamlLoader: SubAgentYamlLoader | null = null;
  private logger: SubAgentLogger;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.logger = new SubAgentLogger();
    fs.mkdirSync(SUBAGENT_OUTPUT_DIR, { recursive: true });
  }

  /** Attach a YAML agent loader (optional). YAML agents override built-in ones. */
  setYamlLoader(loader: SubAgentYamlLoader): void {
    this.yamlLoader = loader;
    loader.on("agents-updated", () => {
      console.log("[SubAgentManager] YAML agents updated, reloaded");
    });
  }

  /** Resolve an agent definition: YAML → built-in → general-purpose fallback */
  resolveAgent(type: string): AgentDefinition {
    // 1. Check YAML-loaded agents first
    if (this.yamlLoader && this.yamlLoader.has(type)) {
      return this.yamlLoader.get(type)!;
    }
    // 2. Fall back to built-in agents
    return getBuiltInAgent(type);
  }

  /** List all available agent types (YAML + built-in) */
  listAgentTypes(): { agentType: string; description: string; source: string }[] {
    const types: Map<string, { agentType: string; description: string; source: string }> = new Map();

    // Built-in agents
    for (const agent of listBuiltInAgents()) {
      types.set(agent.agentType, {
        agentType: agent.agentType,
        description: agent.description,
        source: "built-in",
      });
    }

    // YAML agents (override built-in)
    if (this.yamlLoader) {
      for (const agent of this.yamlLoader.getAll()) {
        types.set(agent.agentType, {
          agentType: agent.agentType,
          description: agent.description,
          source: "custom",
        });
      }
    }

    return Array.from(types.values());
  }

  /** Create a new task, returns task ID */
  createTask(
    userId: string,
    description: string,
    prompt: string,
    subagentType: SubAgentType = "general-purpose",
  ): string {
    // Enforce per-user limit
    const userTasks = Array.from(this.tasks.values()).filter(
      (t) => t.userId === userId && t.status !== "cancelled",
    );
    if (userTasks.length >= MAX_TASKS_PER_USER) {
      throw new Error(
        `User ${userId} has ${userTasks.length} tasks (max ${MAX_TASKS_PER_USER}). Cancel some before creating new ones.`,
      );
    }

    const id = `sa-${crypto.randomUUID().slice(0, 8)}`;
    const task: SubAgentTask = {
      id,
      userId,
      description,
      prompt,
      subagentType,
      status: "pending",
      createdAt: Date.now(),
      messages: [],
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      abortController: new AbortController(),
    };
    this.tasks.set(id, task);
    this.saveToDisk(task);
    return id;
  }

  /**
   * Run a task synchronously (blocking).
   * The calling agent waits for the sub-agent to complete.
   */
  async runTaskSync(
    taskId: string,
    agentDef?: AgentDefinition,
  ): Promise<AgentToolSyncResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "pending")
      throw new Error(`Task ${taskId} already ${task.status}`);

    const definition = agentDef || this.resolveAgent(task.subagentType);
    const startTime = Date.now();
    const agent = definition;

    try {
      task.status = "running";
      task.startedAt = Date.now();
      this.saveToDisk(task);

      // Build the sub-agent's tool set (filter by allowed/disallowed)
      const subAgentTools = this.buildSubAgentTools(agent);

      // Run the sub-agent LLM loop
      const result = await this.executeSubAgentLoop(
        task,
        agent,
        subAgentTools,
      );

      task.status = "completed";
      task.completedAt = Date.now();
      task.result = result.response;
      task.turnCount = result.turnCount;
      task.inputTokens = result.inputTokens;
      task.outputTokens = result.outputTokens;
      this.saveToDisk(task);

      // Log completion
      this.logCompletion(task, agent, startTime);

      return {
        status: "completed",
        agentId: task.id,
        description: task.description,
        content: result.response,
        turnCount: result.turnCount,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      if (task.abortController.signal.aborted) {
        task.status = "cancelled";
        task.error = "Task was cancelled";
      } else {
        task.status = "failed";
        task.error = err.message || String(err);
      }
      task.completedAt = Date.now();
      this.saveToDisk(task);
      this.logCompletion(task, agent, startTime);
      throw err;
    }
  }

  /**
   * Launch a task asynchronously (background).
   * Returns immediately with task info. Results are saved to disk.
   */
  async runTaskAsync(
    taskId: string,
    agentDef?: AgentDefinition,
  ): Promise<AgentToolAsyncResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const definition = agentDef || this.resolveAgent(task.subagentType);
    const agent = definition;

    // Fire and forget — runs in background
    this.runTaskSync(taskId, agent).catch((err) => {
      console.error(`[SUBAGENT] Async task ${taskId} failed: ${err.message}`);
    });

    return {
      status: "async_launched",
      agentId: task.id,
      description: task.description,
      prompt: task.prompt,
      outputFile: this.getOutputPath(task.id),
    };
  }

  /** Get a task by ID */
  getTask(taskId: string): SubAgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /** List all tasks for a user, optionally filtered by status */
  listTasks(
    userId: string,
    status?: SubAgentTaskStatus,
    limit: number = 20,
  ): SubAgentTask[] {
    const tasks = Array.from(this.tasks.values())
      .filter((t) => t.userId === userId)
      .filter((t) => !status || t.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);

    // Return safe copies without abortController
    return tasks.map((t) => ({
      ...t,
      abortController: undefined as any, // don't expose to client
    })) as any;
  }

  /** Cancel a running task */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "cancelled") return false;

    task.abortController.abort();
    task.status = "cancelled";
    task.completedAt = Date.now();
    this.saveToDisk(task);
    return true;
  }

  /** Get task output file path */
  getOutputPath(taskId: string): string {
    return path.join(SUBAGENT_OUTPUT_DIR, `${taskId}.json`);
  }

  /** Query subagent run logs (list available run files) */
  listRuns(q: {
    agentType?: string;
    description?: string;
    userId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): { file: string; meta: SubAgentRunMeta }[] {
    return this.logger.listRuns(q);
  }

  /** Count subagent run files */
  countRuns(q: {
    agentType?: string;
    description?: string;
    userId?: string;
    status?: string;
  }): number {
    return this.logger.countRuns(q);
  }

  /** Load the full messages for a specific run file */
  loadRunMessages(filePath: string): { meta: SubAgentRunMeta; messages: LLMMessage[] } | null {
    return this.logger.loadMessages(filePath);
  }

  // ===== Internal: Logging =====

  /** Save the complete messages history for a completed/failed task */
  private logCompletion(
    task: SubAgentTask,
    agent: AgentDefinition,
    startTime: number,
  ): void {
    const durationMs = Date.now() - startTime;

    this.logger.saveRun(
      {
        taskId: task.id,
        agentType: task.subagentType,
        description: task.description,
        userId: task.userId,
        status: (task.status === "completed"
          ? "completed"
          : task.status === "cancelled"
            ? "cancelled"
            : "failed") as "completed" | "failed" | "cancelled",
        ts: Date.now(),
        iso: new Date().toISOString(),
        durationMs,
        turnCount: task.turnCount,
        inputTokens: task.inputTokens,
        outputTokens: task.outputTokens,
        error: task.error,
      },
      task.messages, // full conversation history
    );
  }

  // ===== Internal: Sub-agent LLM Loop =====

  private async executeSubAgentLoop(
    task: SubAgentTask,
    agent: AgentDefinition,
    tools: Record<string, unknown>[],
  ): Promise<{
    response: string;
    turnCount: number;
    inputTokens: number;
    outputTokens: number;
  }> {
    const llm = new LLMClient();
    const maxTurns = agent.maxTurns || 30;
    const model = agent.model || process.env["LLM_MODEL"] || "";

    // Build messages
    const messages: LLMMessage[] = [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: task.prompt },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    let turnCount = 0;

    for (turnCount = 0; turnCount < maxTurns; turnCount++) {
      // Check abort
      if (task.abortController.signal.aborted) {
        // Get last assistant message as partial result
        const partial = this.extractLastAssistantText(messages);
        return {
          response: partial || "(task was cancelled)",
          turnCount,
          inputTokens,
          outputTokens,
        };
      }

      // Call LLM
      const response = await llm.chat(messages, tools, model);

      // If tools array is empty (read-only agents), still pass empty array for proper error message
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      // If no tool calls, we're done
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const content = response.content || "";
        messages.push({ role: "assistant", content });
        task.messages = messages;
        return {
          response: content,
          turnCount: turnCount + 1,
          inputTokens,
          outputTokens,
        };
      }

      // Add assistant message with tool calls
      const assistantMsg: LLMMessage = {
        role: "assistant",
        content: null,
        tool_calls: response.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of response.tool_calls) {
        const tool = this.registry.get(tc.name);
        if (!tool) {
          messages.push({
            role: "tool",
            content: `Error: Unknown tool '${tc.name}'`,
            tool_call_id: tc.id,
          });
          continue;
        }

        try {
          const result = tool.fn(tc.arguments);
          const value = result instanceof Promise ? await result : result;
          messages.push({
            role: "tool",
            content: String(value).slice(0, 8000),
            tool_call_id: tc.id,
          });
        } catch (e: unknown) {
          messages.push({
            role: "tool",
            content: `Error executing ${tc.name}: ${
              e instanceof Error ? e.message : String(e)
            }`,
            tool_call_id: tc.id,
          });
        }
      }

      // Periodically save progress
      if (turnCount % 5 === 0) {
        task.messages = messages;
        this.saveToDisk(task);
      }
    }

    // Max turns reached
    const lastText = this.extractLastAssistantText(messages);
    return {
      response:
        lastText || `Reached maximum turns (${maxTurns}) without final response.`,
      turnCount,
      inputTokens,
      outputTokens,
    };
  }

  /** Extract the last assistant text message from a conversation */
  private extractLastAssistantText(messages: LLMMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.content) {
        return m.content;
      }
    }
    return "";
  }

  /** Build the tool set for a sub-agent, filtered by its allowed/disallowed tools */
  private buildSubAgentTools(agent: AgentDefinition): Record<string, unknown>[] {
    const allTools = this.registry.toOpenAITools();

    // If no restrictions, return all tools
    const hasAllowed = agent.allowedTools && agent.allowedTools.length > 0;
    const hasDisallowed = agent.disallowedTools && agent.disallowedTools.length > 0;
    if (!hasAllowed && !hasDisallowed) {
      return allTools;
    }

    // Build sets
    const allowed = hasAllowed ? new Set(agent.allowedTools!) : null;
    const disallowed = hasDisallowed ? new Set(agent.disallowedTools!) : null;

    return allTools.filter((t: any) => {
      const name = (t as any)?.function?.name || "";
      // If allowedTools is set, the tool must be in the set
      if (allowed && !allowed.has(name)) return false;
      // If disallowedTools is set, the tool must not be in the set
      if (disallowed && disallowed.has(name)) return false;
      return true;
    });
  }

  // ===== Persistence =====

  private saveToDisk(task: SubAgentTask): void {
    try {
      const safe = {
        ...task,
        // Don't persist abortController
        abortController: undefined,
      };
      fs.writeFileSync(
        this.getOutputPath(task.id),
        JSON.stringify(safe, null, 2),
        "utf-8",
      );
    } catch {
      // best effort
    }
  }

  /** Load tasks from disk on startup */
  loadFromDisk(): void {
    try {
      const files = fs.readdirSync(SUBAGENT_OUTPUT_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(SUBAGENT_OUTPUT_DIR, file), "utf-8"),
          );
          const task = data as SubAgentTask;
          // Re-create abort controller for running tasks
          task.abortController = new AbortController();
          if (task.status === "running") {
            // Mark tasks that were running on restart as failed
            task.status = "failed";
            task.error = "Server restarted while task was running";
          }
          this.tasks.set(task.id, task);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // directory doesn't exist yet
    }
  }
}
