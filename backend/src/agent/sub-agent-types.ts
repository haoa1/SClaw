/**
 * SubAgent Type Definitions
 *
 * Core types for the subagent system:
 *   - SubAgentTask: represents a single subagent run
 *   - AgentDefinition: describes an agent type (prompt, tools, etc.)
 *   - BuiltInAgentType: the known built-in agent types
 */

import { LLMMessage } from "./llm";

/** Known built-in agent types */
export type BuiltInAgentType =
  | "general-purpose"
  | "chanlun";

/** All valid subagent type strings */
export type SubAgentType = BuiltInAgentType | string; // string allows custom YAML-defined agents

/** Task execution status */
export type SubAgentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** A subagent task instance */
export interface SubAgentTask {
  id: string;
  userId: string;
  description: string;
  prompt: string;
  subagentType: SubAgentType;
  status: SubAgentTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Final text result (for completed tasks) */
  result?: string;
  /** Error message (for failed tasks) */
  error?: string;
  /** Full conversation messages (for introspection / resume) */
  messages: LLMMessage[];
  /** Total LLM turns used */
  turnCount: number;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Abort controller signal for cancelling */
  abortController: AbortController;
}

/**
 * Agent definition — describes a type of subagent.
 * Built-in agents are defined in-code; custom agents can be
 * defined via YAML/JSON files.
 */
export interface AgentDefinition {
  /** Agent type identifier (e.g. "coder", "analyzer") */
  agentType: SubAgentType;
  /** Human-readable description of when to use this agent */
  description: string;
  /** Tools this agent is allowed to use. ['*'] or undefined = all tools. */
  allowedTools?: string[];
  /** Tools this agent is explicitly denied. Overrides allowedTools. */
  disallowedTools?: string[];
  /** Base system prompt for this agent type */
  systemPrompt: string;
  /** Model override (optional) */
  model?: string;
  /** Maximum turns before forced stop */
  maxTurns?: number;
  /** Source label for display */
  source?: "built-in" | "custom";
}

/** Agent tool input */
export interface AgentToolInput {
  description: string;
  prompt: string;
  subagentType?: SubAgentType;
  runInBackground?: boolean;
  cwd?: string;
}

/** Agent tool sync result */
export interface AgentToolSyncResult {
  status: "completed";
  agentId: string;
  description: string;
  content: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** Agent tool async result */
export interface AgentToolAsyncResult {
  status: "async_launched";
  agentId: string;
  description: string;
  prompt: string;
  outputFile: string;
}
