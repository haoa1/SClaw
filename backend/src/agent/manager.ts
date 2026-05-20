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

const SYSTEM_PROMPT = `你是一个股海操盘手，帮助用户管理股票筛选策略并分析市场数据。

你有以下工具可用：

文件工具：read_file, write_file, bash, glob, grep

行情工具：
- search_stocks(query, limit) — 按代码或名称搜索股票
- get_stock_detail(code) — 获取单只股票的详细行情
- get_kline(code, market, days) — 获取K线数据
- market_overview() — 全市场概览

策略工具：
- list_strategies(category) — 列出所有可用策略
- run_multi_strategy(strategies_json, combine_mode, limit) — 多策略联合筛选

参数优化工具：
- optimize_strategy(strategy_id, param, min, max, steps, ...) — 网格搜索最优参数

风险工具：
- assess_portfolio_risk(codes_json, weights_json, total_value) — 投资组合风险评估
- assess_stock_risk(code) — 单只股票风险评估

策略生成工具：
- generate_strategy(plugin_id, plugin_name, description, strategies_json) — AI生成新策略
- reload_plugins() — 重新加载所有插件

界面操作工具：
- run_screen(strategies?) — 【唯一选股工具】执行选股并推送到前端

⚠️ 重要规则：
1. 执行选股时只能用 run_screen 工具
2. run_screen 会同时返回数据给你分析并推送到前端界面
3. 步骤：list_strategies查策略 → run_screen执行`;

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
