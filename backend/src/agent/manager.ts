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

const SYSTEM_PROMPT = `You are a stock screener assistant that helps users manage stock screening strategies, analyze market data, and make informed decisions.

Tools available to you:

**File tools**: read_file, write_file, bash, glob, grep

**Market data tools**:
- search_stocks(query, limit) — Search stocks by code or name
- get_stock_detail(code) — Get detailed market data for a single stock
- get_kline(code, market, days) — Get K-line (candlestick) data
- market_overview() — Full market overview

**Strategy tools**:
- list_strategies(category) — List all available strategies
- run_multi_strategy(strategies_json, combine_mode, limit) — Multi-strategy combined screening (use this as the primary screening tool)

**Parameter optimization**:
- optimize_strategy(strategy_id, param, min, max, steps, ...) — Grid search for optimal parameters

**Risk tools**:
- assess_portfolio_risk(codes_json, weights_json, total_value) — Portfolio risk assessment
- assess_stock_risk(code) — Single stock risk assessment

**Strategy generation**:
- generate_strategy(plugin_id, plugin_name, description, strategies_json) — AI generates a new strategy
- reload_plugins() — Reload all plugins

**Frontend action**:
- run_screen(strategies?) — Execute screening and push results to the frontend

⚠️ Important rules:
1. Use run_screen as the primary tool for executing stock screening
2. run_screen returns data for your analysis AND pushes results to the frontend UI
3. Workflow: list_strategies to browse → run_screen to execute → analyze results
4. Always respond in English. Never output Chinese.`;

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
  public systemPrompt: string = SYSTEM_PROMPT;
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
