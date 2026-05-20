/**
 * Scheduled screening tasks — cron-based, per-user.
 *
 * Uses node-cron to run screening jobs at user-defined times.
 * Results are sent via email.
 */

import cron from 'node-cron';
import { StrategyEngine } from './strategies/strategy-engine';
import { DataFetcher } from './data/data-fetcher';
import { sendScreenReport } from './email';
import { UserStore } from './user-store';
import type { StockScreenerPlugin } from './types';

// ===== Types =====

export interface BacktestTaskConfig {
  startDate: string;
  endDate: string;
  rebalanceFrequency: 'monthly' | 'weekly' | 'quarterly' | 'none';
  initialCapital: number;
  maxPositions: number;
  commission: number;
  benchmark: string;
  stopLoss?: number;
  takeProfit?: number;
  slippageModel?: 'none' | 'fixed' | 'volume';
}

export interface ScheduledTask {
  id: string;              // unique task ID
  userId: string;
  taskType: 'screen' | 'backtest';  // type of task
  cronExpr: string;        // cron expression
  email: string;           // recipient email
  aiMode?: 'email' | 'agent' | 'both';  // AI analysis mode (screen only)
  strategies: Array<{
    pluginId: string;
    strategyId: string;
    params: Record<string, any>;
  }>;
  backtestConfig?: BacktestTaskConfig;  // backtest configuration (backtest only)
  label?: string;          // human-readable name
  enabled: boolean;
  lastRun?: number;
  lastResult?: {
    matchedCount: number;
    totalCount: number;
    topResults: Array<{ code: string; name: string; score: number }>;
    strategies: string;
    timestamp: number;
  };
  createdAt: number;
}

// ===== Scheduler =====

export class ScreenScheduler {
  private jobs = new Map<string, ReturnType<typeof cron.schedule>>();
  private persistencePath: string;
  public pushNotification?: (userId: string, notification: {
    taskId: string;
    label: string;
    strategies: string;
    matchedCount: number;
    totalCount: number;
    topResults: Array<{ code: string; name: string; score: number }>;
    timestamp: number;
    status: 'completed' | 'failed';
    errorMessage?: string;
  }) => void;

  /** Callback to run AI analysis on screening results (aiMode=agent/both) */
  public analyzeWithAgent?: (
    userId: string,
    taskLabel: string,
    strategyNames: string[],
    results: Array<{ code: string; name: string; score: number }>,
  ) => Promise<string>;

  /** Callback to run a backtest task using BacktestEngine */
  public runBacktest?: (
    config: BacktestTaskConfig & { strategies: ScheduledTask['strategies'] },
  ) => Promise<{
    summary: { totalReturn: number; annualizedReturn: number; maxDrawdown: number; sharpeRatio: number; winRate: number; totalTrades: number; finalCapital: number; benchmarkReturn?: number };
    trades: Array<{ date: string; type: string; code: string; name: string; price: number; shares: number; amount: number }>;
    topResults: Array<{ code: string; name: string; score: number }>;
    equityCurve: Array<{ date: string; value: number }>;
  }>;

  constructor(
    private strategyEngine: StrategyEngine,
    private dataFetcher: DataFetcher,
    private userStore: UserStore,
    dataDir: string,
    private getPlugins?: () => StockScreenerPlugin[],
  ) {
    const path = require('path');
    const fs = require('fs');
    this.persistencePath = path.join(dataDir, 'scheduled_tasks.json');
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
  }

  /** Load persisted tasks and start cron */
  async initialize(): Promise<void> {
    const tasks = this.loadTasks();
    console.log(`[Scheduler] Loading ${tasks.length} persisted tasks...`);
    for (const task of tasks) {
      if (task.enabled) {
        this.startJob(task);
      }
    }
  }

  /** List all tasks for a user */
  listTasks(userId: string): ScheduledTask[] {
    return this.loadTasks().filter(t => t.userId === userId);
  }

  /** List all tasks across all users */
  listAllTasks(): ScheduledTask[] {
    return this.loadTasks();
  }

  /** Add a new scheduled task */
  addTask(task: Omit<ScheduledTask, 'id' | 'createdAt'>): ScheduledTask {
    const tasks = this.loadTasks();
    const newTask: ScheduledTask = {
      ...task,
      id: require('crypto').randomBytes(8).toString('hex'),
      createdAt: Date.now(),
    };
    tasks.push(newTask);
    this.saveTasks(tasks);

    if (newTask.enabled) {
      this.startJob(newTask);
    }

    console.log(`[Scheduler] Task added: ${newTask.id} (${task.label || task.cronExpr}) for user ${task.userId}`);
    return newTask;
  }

  /** Remove a scheduled task */
  removeTask(taskId: string): boolean {
    const tasks = this.loadTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return false;

    this.stopJob(taskId);
    tasks.splice(idx, 1);
    this.saveTasks(tasks);
    console.log(`[Scheduler] Task removed: ${taskId}`);
    return true;
  }

  /** Enable or disable a task */
  setEnabled(taskId: string, enabled: boolean): boolean {
    const tasks = this.loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return false;

    task.enabled = enabled;
    this.saveTasks(tasks);

    if (enabled) {
      this.startJob(task);
    } else {
      this.stopJob(taskId);
    }
    return true;
  }

  /** Run a specific task immediately */
  async runNow(taskId: string): Promise<boolean> {
    const tasks = this.loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return false;

    return this.executeTask(task);
  }

  /** Execute a task: fetch data, run strategies, send email */
  async executeTask(task: ScheduledTask): Promise<boolean> {
    console.log(`[Scheduler] Executing task ${task.id} for user ${task.userId} (${task.label || task.cronExpr})`);

    // ===== Backtest task =====
    if (task.taskType === 'backtest' && task.backtestConfig) {
      return this.executeBacktestTask(task);
    }

    // ===== Screening task (original path) =====
    try {
      const allStocks = await this.dataFetcher.fetchAllStocks();
      const { results } = await this.strategyEngine.execute(allStocks, {
        strategies: task.strategies,
        combineMode: 'score',
      });

      // Get strategy names for the report
      const allPlugins = this.getPlugins?.() || [];
      const strategyNames: string[] = [];
      for (const s of task.strategies) {
        const plugin = allPlugins.find(p => p.id === s.pluginId);
        const strat = plugin?.strategies.find(st => st.id === s.strategyId);
        strategyNames.push(strat?.name || s.strategyId);
      }

      // Top results for notification + persisted result
      const topResults = results.slice(0, 5).map(r => ({
        code: r.code,
        name: r.name || r.code,
        score: typeof r.score === 'number' ? r.score : 0,
      }));

      // Update last run time and result
      const tasks = this.loadTasks();
      const saved = tasks.find(t => t.id === task.id);
      if (saved) {
        saved.lastRun = Date.now();
        saved.lastResult = {
          matchedCount: results.length,
          totalCount: allStocks.length,
          topResults,
          strategies: strategyNames.join(', '),
          timestamp: Date.now(),
        };
        this.saveTasks(tasks);
      }

      const aiMode = task.aiMode || 'email';

      // ===== Email mode: send report =====
      let sent = false;
      if (aiMode === 'email' || aiMode === 'both') {
        const stats = {
          totalStocks: allStocks.length,
          matchedStocks: results.length,
          executionTime: 0,
        };
        sent = await sendScreenReport(task.email, stats, results, strategyNames);
      }

      // ===== Agent mode: run AI analysis on results =====
      let agentAnalysis = '';
      if ((aiMode === 'agent' || aiMode === 'both') && this.analyzeWithAgent) {
        try {
          agentAnalysis = await this.analyzeWithAgent(
            task.userId,
            task.label || '',
            strategyNames,
            results.slice(0, 10).map(r => ({
              code: r.code,
              name: r.name || r.code,
              score: typeof r.score === 'number' ? r.score : 0,
            })),
          );
          console.log(`[Scheduler] AI analysis completed for task ${task.id} (${agentAnalysis.length} chars)`);
        } catch (e) {
          console.error(`[Scheduler] AI analysis failed for task ${task.id}:`, e);
          agentAnalysis = '';
        }
      }

      // ===== Push notification (only for email/both modes) =====
      if (aiMode !== 'agent') {
        this.pushNotification?.(task.userId, {
          taskId: task.id,
          label: task.label || '',
          strategies: strategyNames.join(', '),
          matchedCount: results.length,
          totalCount: allStocks.length,
          topResults,
          timestamp: Date.now(),
          status: 'completed',
        });
      }

      // ===== Log to user store =====
      const logParts: string[] = [];
      logParts.push(`策略: ${strategyNames.join(', ')}`);
      logParts.push(`命中: ${results.length} 只`);
      if (aiMode === 'email' || aiMode === 'both') {
        logParts.push(`邮件: ${sent ? '已发送' : '未配置SMTP'}`);
      }
      if (aiMode === 'agent' || aiMode === 'both') {
        logParts.push(`AI分析: ${agentAnalysis ? '已完成' : '失败'}`);
      }
      this.userStore.addLog(task.userId, {
        type: 'screen',
        action: `定时选股[${aiMode}]`,
        detail: logParts.join(' | '),
      });

      return true;
    } catch (err) {
      console.error(`[Scheduler] Task ${task.id} failed:`, err);
      this.userStore.addLog(task.userId, {
        type: 'system',
        action: '定时任务失败',
        detail: `任务 ${task.label || task.id}: ${String(err)}`,
      });
      return false;
    }
  }

  /** Execute a backtest task */
  private async executeBacktestTask(task: ScheduledTask): Promise<boolean> {
    if (!this.runBacktest || !task.backtestConfig) {
      console.error(`[Scheduler] Backtest task ${task.id} failed: runBacktest callback not configured`);
      return false;
    }

    try {
      // Get strategy names
      const allPlugins = this.getPlugins?.() || [];
      const strategyNames: string[] = [];
      for (const s of task.strategies) {
        const plugin = allPlugins.find(p => p.id === s.pluginId);
        const strat = plugin?.strategies.find(st => st.id === s.strategyId);
        strategyNames.push(strat?.name || s.strategyId);
      }

      console.log(`[Scheduler] Running backtest task ${task.id}...`);
      const result = await this.runBacktest({
        ...task.backtestConfig,
        strategies: task.strategies,
      });

      const topResults = (result.topResults || []).slice(0, 5);

      // Update last run time and result
      const tasks = this.loadTasks();
      const saved = tasks.find(t => t.id === task.id);
      if (saved) {
        saved.lastRun = Date.now();
        saved.lastResult = {
          matchedCount: result.summary.totalTrades,
          totalCount: 0,
          topResults,
          strategies: strategyNames.join(', '),
          timestamp: Date.now(),
        };
        this.saveTasks(tasks);
      }

      // Send email report
      const { sendBacktestReport } = require('./email');
      let sent = false;
      if (task.email) {
        sent = await sendBacktestReport(task.email, result.summary, result.trades, strategyNames, task.backtestConfig);
      }

      // Push notification
      this.pushNotification?.(task.userId, {
        taskId: task.id,
        label: task.label || '',
        strategies: strategyNames.join(', '),
        matchedCount: result.summary.totalTrades,
        totalCount: 0,
        topResults,
        timestamp: Date.now(),
        status: 'completed',
      });

      // Log
      this.userStore.addLog(task.userId, {
        type: 'screen',
        action: '定时回测',
        detail: `策略: ${strategyNames.join(', ')} | 收益率: ${result.summary.totalReturn.toFixed(2)}% | 交易: ${result.summary.totalTrades}笔 | 邮件: ${sent ? '已发送' : '未配置SMTP'}`,
      });

      return true;
    } catch (err) {
      console.error(`[Scheduler] Backtest task ${task.id} failed:`, err);
      this.userStore.addLog(task.userId, {
        type: 'system',
        action: '定时回测失败',
        detail: `任务 ${task.label || task.id}: ${String(err)}`,
      });
      return false;
    }
  }

  // ===== Private =====

  private startJob(task: ScheduledTask): void {
    this.stopJob(task.id);

    if (!cron.validate(task.cronExpr)) {
      console.warn(`[Scheduler] Invalid cron expression for task ${task.id}: ${task.cronExpr}`);
      return;
    }

    const job = cron.schedule(task.cronExpr, () => {
      this.executeTask(task);
    });

    this.jobs.set(task.id, job);
    console.log(`[Scheduler] Started cron job ${task.id}: "${task.cronExpr}" -> ${task.email}`);
  }

  private stopJob(taskId: string): void {
    const existing = this.jobs.get(taskId);
    if (existing) {
      existing.stop();
      this.jobs.delete(taskId);
    }
  }

  private loadTasks(): ScheduledTask[] {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.persistencePath)) {
        return JSON.parse(fs.readFileSync(this.persistencePath, 'utf-8'));
      }
    } catch (err) {
      console.warn('[Scheduler] Failed to load tasks:', err);
    }
    return [];
  }

  private saveTasks(tasks: ScheduledTask[]): void {
    try {
      const fs = require('fs');
      fs.writeFileSync(this.persistencePath, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Scheduler] Failed to save tasks:', err);
    }
  }
}
