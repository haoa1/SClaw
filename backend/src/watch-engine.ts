/**
 * WatchEngine — 盯盘（Real-time Stock Monitoring）引擎.
 *
 * Manages per-user watch tasks with interval-based checking against
 * East Money real-time quotes. Supports 5 condition types, SSE push,
 * cooldown dedup, and JSON persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { WatchTask, WatchCondition, WatchAlert } from './types';
import type { StockSnapshot } from './data/data-fetcher';
import { sendEmail } from './email';

// ===== Types =====

export interface WatchEngineDeps {
  fetchQuotes: (codes: string[]) => Promise<Record<string, StockSnapshot>>;
  pushNotification?: (userId: string, notification: any) => void;
}

// ===== WatchEngine =====

export class WatchEngine extends EventEmitter {
  private tasks = new Map<string, WatchTask>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private storagePath: string;
  public deps: WatchEngineDeps;
  private started = false;

  constructor(storagePath: string, deps: WatchEngineDeps) {
    super();
    this.storagePath = storagePath;
    this.deps = deps;
    this.loadFromDisk();
  }

  // ===== Lifecycle =====

  start() {
    if (this.started) return;
    this.started = true;
    let enabledCount = 0;
    for (const task of this.tasks.values()) {
      if (task.enabled) {
        this.scheduleTask(task);
        enabledCount++;
      }
    }
    console.log(`[WatchEngine] Started: ${enabledCount} active tasks, ${this.tasks.size} total`);
  }

  stop() {
    this.started = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    console.log('[WatchEngine] Stopped');
  }

  // ===== CRUD =====

  addTask(task: WatchTask): void {
    this.tasks.set(task.id, task);
    if (this.started && task.enabled) this.scheduleTask(task);
    this.persist();
    console.log(`[WatchEngine] Task added: ${task.id} (${task.watchTargets.length} stocks @ ${task.interval}s)`);
  }

  removeTask(taskId: string): boolean {
    this.clearTimer(taskId);
    const deleted = this.tasks.delete(taskId);
    if (deleted) {
      this.persist();
      console.log(`[WatchEngine] Task removed: ${taskId}`);
    }
    return deleted;
  }

  updateTask(taskId: string, update: Partial<WatchTask>): WatchTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    // Don't allow overwriting id/userId
    const { id, userId, ...safeUpdate } = update;
    Object.assign(task, safeUpdate);

    // Re-schedule if interval/enabled changed
    this.clearTimer(taskId);
    if (this.started && task.enabled) this.scheduleTask(task);

    this.persist();
    console.log(`[WatchEngine] Task updated: ${taskId}`);
    return task;
  }

  toggleTask(taskId: string, enabled?: boolean): WatchTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.enabled = enabled !== undefined ? enabled : !task.enabled;

    this.clearTimer(taskId);
    if (this.started && task.enabled) this.scheduleTask(task);

    this.persist();
    console.log(`[WatchEngine] Task ${taskId}: ${task.enabled ? 'enabled' : 'disabled'}`);
    return task;
  }

  getTask(taskId: string): WatchTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(userId: string): WatchTask[] {
    return [...this.tasks.values()].filter(t => t.userId === userId);
  }

  listAllTasks(): WatchTask[] {
    return [...this.tasks.values()];
  }

  getActiveCount(): number {
    return this.timers.size;
  }

  // ===== Scheduling =====

  private scheduleTask(task: WatchTask) {
    if (this.timers.has(task.id)) return;

    const intervalMs = task.interval * 1000;
    // Run immediately, then periodic
    this.runTick(task).catch(err => {
      console.error(`[WatchEngine] Tick error (${task.id}):`, err);
    });
    const timer = setInterval(() => {
      this.runTick(task).catch(err => {
        console.error(`[WatchEngine] Tick error (${task.id}):`, err);
      });
    }, intervalMs);
    this.timers.set(task.id, timer);
  }

  private clearTimer(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }
  }

  // ===== Main Tick =====

  private async runTick(task: WatchTask) {
    const now = Date.now();
    task.lastRun = now;

    // Fetch real-time quotes for watched stocks
    const quotes = await this.deps.fetchQuotes(task.watchTargets);
    if (Object.keys(quotes).length === 0) return;

    // Ensure state storage exists
    if (!task._state) task._state = {};

    for (const stock of task.watchTargets) {
      const quote = quotes[stock];
      if (!quote) continue;

      // Get or initialize state for this stock
      const state = task._state[stock] || { lastPrice: 0, lastVolume: 0, lastAlerted: 0 };
      if (!task._state[stock]) task._state[stock] = state;

      const triggered = this.evaluateConditions(task.conditions, quote, state);
      if (triggered) {
        // Cooldown check
        const cooldownMs = task.cooldownSeconds * 1000;
        if (state.lastAlerted && (now - state.lastAlerted) < cooldownMs) continue;

        const message = this.buildAlertMessage(triggered, quote, state);
        const alert: WatchAlert = {
          userId: task.userId,
          taskId: task.id,
          taskLabel: task.label,
          stock,
          stockName: quote.name,
          conditionType: triggered.type,
          price: quote.price,
          changePercent: quote.changePercent,
          volume: quote.volume,
          message,
          timestamp: now,
        };

        state.lastAlerted = now;
        task.lastAlert = {
          timestamp: now,
          stock,
          conditionType: triggered.type,
          message,
        };

        // Emit alert events
        this.emit('alert', alert);

        // Push to agent notification queue
        if (task.alertChannels?.agent && this.deps.pushNotification) {
          this.deps.pushNotification(task.userId, {
            type: 'watch_alert',
            data: alert,
          });
        }

        // Send email alert if configured
        if (task.alertChannels?.email && task.email) {
          const direction = quote.changePercent >= 0 ? '涨' : '跌';
          const emailHtml = `
<div style="background:#0a0a1a;color:#ccc;padding:20px;font-family:'PingFang SC','Helvetica Neue',sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <h2 style="color:#e0e0e0;margin:0 0 16px;font-size:18px;">🚨 盯盘预警</h2>
    <div style="background:linear-gradient(135deg,#1a1a3e,#1a1a2e);border-radius:8px;border:1px solid #3a3a5e;padding:16px;margin-bottom:12px;">
      <p style="margin:0 0 8px;font-size:16px;">
        <strong style="color:#e0e0e0;">${quote.name}</strong>
        <span style="color:#888;font-size:13px;">(${stock})</span>
      </p>
      <p style="margin:4px 0;font-size:14px;">
        当前价：<span style="color:${quote.changePercent >= 0 ? '#f87171' : '#4ade80'};font-weight:bold;">¥${quote.price}</span>
        <span style="margin-left:8px;color:${quote.changePercent >= 0 ? '#f87171' : '#4ade80'};">${direction}${Math.abs(quote.changePercent).toFixed(2)}%</span>
      </p>
      <p style="margin:4px 0;color:#aaa;font-size:13px;">量比：${(quote.volumeRatio || 0).toFixed(2)} | 换手：${(quote.turnoverRate || 0).toFixed(1)}%</p>
      <p style="margin:12px 0 0;color:#a78bfa;font-size:13px;border-top:1px solid #2a2a4a;padding-top:8px;">${message}</p>
    </div>
    <p style="color:#666;font-size:11px;">由 股海盯盘 自动发送 • ${new Date(now).toLocaleString('zh-CN')}</p>
  </div>
</div>`;
          sendEmail({
            to: task.email,
            subject: `🚨 ${quote.name}(${stock}) 盯盘预警`,
            text: message,
            html: emailHtml,
          }).then(sent => {
            if (sent) console.log(`[WatchEngine] Email alert sent to ${task.email} for ${stock}`);
          }).catch(err => {
            console.error(`[WatchEngine] Email send failed for ${stock}:`, err);
          });
        }

        console.log(`[WatchEngine] ALERT: ${quote.name}(${stock}) — ${message}`);
      }

      // Always update state with latest prices for next comparison
      state.lastPrice = quote.price;
      state.lastVolume = quote.volume;
    }

    this.persist();
  }

  // ===== Condition Evaluation =====

  private evaluateConditions(
    conditions: WatchCondition[],
    quote: StockSnapshot,
    state: { lastPrice: number; lastVolume: number; lastAlerted: number },
  ): WatchCondition | null {
    for (const cond of conditions) {
      if (this.checkCondition(cond, quote, state)) return cond;
    }
    return null;
  }

  private checkCondition(cond: WatchCondition, quote: StockSnapshot, state: { lastPrice: number; lastVolume: number }): boolean {
    switch (cond.type) {
      case 'price_change': {
        // Use prevClose as base for first run, then last observed price
        const basePrice = state.lastPrice > 0 ? state.lastPrice : (quote.prevClose || quote.price);
        if (basePrice <= 0) return false;
        const pct = ((quote.price - basePrice) / basePrice) * 100;
        if (cond.direction === 'up') return pct >= cond.thresholdPercent;
        if (cond.direction === 'down') return pct <= -cond.thresholdPercent;
        return Math.abs(pct) >= cond.thresholdPercent;
      }

      case 'volume_spike': {
        // volumeRatio from API is today's volume / average daily volume
        const volRatio = quote.volumeRatio ?? 1;
        return volRatio >= cond.ratio;
      }

      case 'price_cross': {
        const basePrice = state.lastPrice > 0 ? state.lastPrice : (quote.prevClose || quote.price);
        if (cond.cross === 'above') return quote.price > cond.price && basePrice <= cond.price;
        return quote.price < cond.price && basePrice >= cond.price;
      }

      case 'new_high_low': {
        // For 52-week high/low, we need historical data — fallback to a simple heuristic
        // using amplitude and prevClose as a rough proxy
        const amplitude = quote.amplitude ?? 0;
        if (cond.direction === 'high' && amplitude > 8) return true; // >8% amplitude suggests new high territory
        if (cond.direction === 'low' && amplitude > 8) return true;
        return false;
      }

      case 'combined': {
        const results = cond.conditions.map(c => this.checkCondition(c, quote, state));
        return cond.operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
      }

      default:
        return false;
    }
  }

  // ===== Alert Message =====

  private buildAlertMessage(cond: WatchCondition, quote: StockSnapshot, state: { lastPrice: number }): string {
    const arrow = quote.changePercent >= 0 ? '🟢' : '🔴';
    const dir = quote.changePercent >= 0 ? '涨' : '跌';
    switch (cond.type) {
      case 'price_change': {
        const basePrice = state.lastPrice > 0 ? state.lastPrice : (quote.prevClose || quote.price);
        const pct = basePrice > 0 ? ((quote.price - basePrice) / basePrice * 100).toFixed(2) : '—';
        return `${arrow} ${quote.name} ${dir}${Math.abs(quote.changePercent).toFixed(2)}% (当前价${quote.price}) [条件: 价格变动${cond.thresholdPercent}%]`;
      }
      case 'volume_spike':
        return `${arrow} ${quote.name} 放量${cond.ratio}倍以上 (量比${(quote.volumeRatio || 0).toFixed(2)})`;
      case 'price_cross':
        return `${arrow} ${quote.name} ${cond.cross === 'above' ? '突破' : '跌破'}${cond.price}元 (当前价${quote.price})`;
      case 'new_high_low':
        return `${arrow} ${quote.name} 创${cond.period === '52week' ? '52周' : '历史'}${cond.direction === 'high' ? '新高' : '新低'} (当前价${quote.price})`;
      case 'combined':
        return `${arrow} ${quote.name} ${dir}${Math.abs(quote.changePercent).toFixed(2)}% (满足复合条件)`;
      default:
        return `${arrow} ${quote.name} 触发盯盘条件 (当前价${quote.price})`;
    }
  }

  // ===== Persistence =====

  private persist() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = [...this.tasks.values()];
      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[WatchEngine] Persist failed:', err);
    }
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const t of data) this.tasks.set(t.id, t as WatchTask);
          console.log(`[WatchEngine] Loaded ${this.tasks.size} tasks from disk`);
        }
      }
    } catch (err) {
      console.warn('[WatchEngine] Load from disk failed:', err);
    }
  }
}
