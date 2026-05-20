/**
 * Scheduler API routes — CRUD for scheduled screening tasks.
 */

import { Router, Request, Response } from 'express';
import { ScreenScheduler } from '../scheduler';
import { UserStore } from '../user-store';
import { PluginManager } from '../plugin-system/plugin-manager';

// Simple auth middleware: get userId from Authorization header
function getUserId(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  // Token format: userId_sessionId
  return auth.slice(7).split('_')[0] || null;
}

export function createSchedulerRoutes(
  scheduler: ScreenScheduler,
  userStore: UserStore,
  pluginManager: PluginManager,
): Router {
  const router = Router();

  /** GET /api/scheduler/tasks — list tasks for current user */
  router.get('/api/scheduler/tasks', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return;
    }
    const tasks = scheduler.listTasks(userId);
    res.json({ tasks });
  });

  /** POST /api/scheduler/tasks — create a new scheduled task */
  router.post('/api/scheduler/tasks', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return;
    }

    const { cronExpr, email, strategies, label, aiMode, taskType, backtestConfig } = req.body;

    if (!cronExpr) {
      res.status(400).json({ error: '请提供 cronExpr' });
      return;
    }

    if (!strategies || strategies.length === 0) {
      res.status(400).json({ error: '请提供 strategies' });
      return;
    }

    // Validate cron expression
    const cron = require('node-cron');
    if (!cron.validate(cronExpr)) {
      res.status(400).json({ error: '无效的 cron 表达式' });
      return;
    }

    // Resolve strategies to display names
    const allPlugins = pluginManager.getAll();
    const resolvedStrategies = strategies.map((s: any) => {
      const plugin = allPlugins.find(p => p.id === s.pluginId);
      const strat = plugin?.strategies.find(st => st.id === s.strategyId);
      return {
        pluginId: s.pluginId,
        strategyId: s.strategyId,
        strategyName: strat?.name || s.strategyId,
        params: s.params || {},
      };
    });

    const type = taskType || 'screen';

    if (type === 'backtest') {
      // Validate backtest config
      if (!backtestConfig) {
        res.status(400).json({ error: '回测任务需要提供 backtestConfig' });
        return;
      }
      if (!backtestConfig.startDate || !backtestConfig.endDate) {
        res.status(400).json({ error: 'backtestConfig 需要 startDate 和 endDate' });
        return;
      }

      const task = scheduler.addTask({
        userId,
        taskType: 'backtest',
        cronExpr,
        email: email || '',
        strategies: resolvedStrategies,
        backtestConfig: {
          startDate: backtestConfig.startDate,
          endDate: backtestConfig.endDate,
          rebalanceFrequency: backtestConfig.rebalanceFrequency || 'monthly',
          initialCapital: backtestConfig.initialCapital || 1000000,
          maxPositions: backtestConfig.maxPositions || 5,
          commission: backtestConfig.commission || 0.0003,
          benchmark: backtestConfig.benchmark || '',
          stopLoss: backtestConfig.stopLoss,
          takeProfit: backtestConfig.takeProfit,
          slippageModel: backtestConfig.slippageModel || 'fixed',
        },
        label: label || `回测: ${resolvedStrategies.map((s: any) => s.strategyName).join(', ')}`,
        enabled: true,
      });

      userStore.addLog(userId, {
        type: 'system',
        action: '创建定时回测任务',
        detail: `定时: ${cronExpr} | 策略: ${resolvedStrategies.map((s: any) => s.strategyName).join(', ')} | 期间: ${backtestConfig.startDate} → ${backtestConfig.endDate}`,
      });

      res.json({ task });
      return;
    }

    // ===== Screening task =====
    // email required for email/both mode, optional for agent
    const mode = aiMode || 'email';
    if ((mode === 'email' || mode === 'both') && !email) {
      res.status(400).json({ error: 'email/both 模式需要提供 email' });
      return;
    }

    const task = scheduler.addTask({
      userId,
      taskType: 'screen',
      cronExpr,
      email,
      aiMode: mode,
      strategies: resolvedStrategies,
      label: label || `${resolvedStrategies.map((s: any) => s.strategyName).join(', ')}`,
      enabled: true,
    });

    const modeLabel =
      mode === 'email' ? '纯邮件' :
      mode === 'agent' ? 'AI分析' : '邮件+AI分析';

    userStore.addLog(userId, {
      type: 'system',
      action: '创建定时任务',
      detail: `定时: ${cronExpr} | 策略: ${resolvedStrategies.map((s: any) => s.strategyName).join(', ')} | 模式: ${modeLabel}${email ? ` | 发送至: ${email}` : ''}`,
    });

    res.json({ task });
  });

  /** DELETE /api/scheduler/tasks/:id — delete a task */
  router.delete('/api/scheduler/tasks/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return;
    }

    const deleted = scheduler.removeTask(req.params['id']);
    if (!deleted) {
      res.status(404).json({ error: '任务未找到' });
      return;
    }

    userStore.addLog(userId, {
      type: 'system',
      action: '删除定时任务',
      detail: `任务ID: ${req.params['id']}`,
    });

    res.json({ success: true });
  });

  /** PUT /api/scheduler/tasks/:id/toggle — enable/disable */
  router.put('/api/scheduler/tasks/:id/toggle', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return;
    }

    const { enabled } = req.body;
    const updated = scheduler.setEnabled(req.params['id'], enabled);
    if (!updated) {
      res.status(404).json({ error: '任务未找到' });
      return;
    }

    userStore.addLog(userId, {
      type: 'system',
      action: enabled ? '启用定时任务' : '停用定时任务',
      detail: `任务ID: ${req.params['id']}`,
    });

    res.json({ success: true });
  });

  /** POST /api/scheduler/tasks/:id/run — run immediately */
  router.post('/api/scheduler/tasks/:id/run', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return;
    }

    // Run in background
    scheduler.runNow(req.params['id']).catch(err => {
      console.error('[Scheduler] Immediate run failed:', err);
    });

    res.json({ success: true, message: '任务已触发执行' });
  });

  return router;
}
