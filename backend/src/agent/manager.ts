/**
 * Per-user Agent Manager.
 * Each user gets their own Agent + Memory instance,
 * isolated from other users.
 *
 * data/
 *   users/
 *     {userId}/
 *       memory/
 *         memory.json   — AI memory (observations, decisions, etc.)
 *   chat-{userId}.json  — chat messages
 */

import * as fs from "fs";
import * as path from "path";
import { ToolRegistry } from "../tools/registry";
import { Memory } from "../memory/memory";
import { Agent } from "./agent";

export interface ScheduleNotification {
  taskId: string;
  label: string;
  strategies: string;
  matchedCount: number;
  totalCount: number;
  topResults: Array<{ code: string; name: string; score: number }>;
  timestamp: number;
  status: 'completed' | 'failed';
  errorMessage?: string;
}

export class PerUserAgentManager {
  private agents = new Map<string, Agent>();
  private registry: ToolRegistry;
  private dataDir: string;
  public systemPrompt: string = "";
  public pendingNotifications = new Map<string, ScheduleNotification[]>();

  constructor(registry: ToolRegistry, dataDir: string) {
    this.registry = registry;
    this.dataDir = dataDir;
  }

  /** Get or create an agent for a specific user. */
  getAgent(userId: string): Agent {
    let agent = this.agents.get(userId);
    if (agent) return agent;

    const userMemoryDir = path.join(this.dataDir, "users", userId, "memory");
    fs.mkdirSync(userMemoryDir, { recursive: true });
    const memory = new Memory(userMemoryDir);

    agent = new Agent(this.registry, memory, {
      verbose: process.argv.includes("--verbose"),
      systemPrompt: this.systemPrompt,
    });

    this.agents.set(userId, agent);
    return agent;
  }

  /** Push a schedule execution notification for a user. */
  pushNotification(userId: string, notification: ScheduleNotification): void {
    const list = this.pendingNotifications.get(userId) || [];
    list.push(notification);
    // Keep max 10 pending
    while (list.length > 10) list.shift();
    this.pendingNotifications.set(userId, list);
    console.log(`[NOTIFICATION] Pushed schedule notification for user ${userId}: task ${notification.taskId}`);
  }

  /** Drain and return all pending notifications for a user. */
  drainNotifications(userId: string): ScheduleNotification[] {
    const list = this.pendingNotifications.get(userId) || [];
    this.pendingNotifications.delete(userId);
    return list;
  }

  /** Get pending notification count for a user. */
  getPendingCount(userId: string): number {
    return (this.pendingNotifications.get(userId) || []).length;
  }

  /** Reset a user's agent (clear conversation history). */
  resetAgent(userId: string): void {
    const agent = this.agents.get(userId);
    if (agent) {
      agent.reset();
    }
  }

  /** Remove a user's agent entirely. */
  removeAgent(userId: string): void {
    this.agents.delete(userId);
  }
}
