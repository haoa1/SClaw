/**
 * Scheduler API routes — CRUD for scheduled screening tasks.
 */

import { Router, Request, Response } from 'express';
import { ScreenScheduler } from '../scheduler';
import { UserStore } from '../user-store';
import { PluginManager } from '../plugin-system/plugin-manager';
import { validateSession } from '../auth';

// Auth middleware: extract userId from session token
function getUserId(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const session = validateSession(token);
  return session ? session.userId : null;
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

    const { cronExpr, email, strategies, label, aiMode, taskType, backtestConfig, prompt } = req.body;

    if (!cronExpr) {
      res.status(400).json({ error: '请提供 cronExpr' });
      return;
    }

    // Agent tasks don't need strategies; screen/backtest tasks do
    const type = taskType || 'screen';
    if (type !== 'agent' && (!strategies || strategies.length === 0)) {
      res.status(400).json({ error: '请提供 strategies' });
      return;
    }

    // Validate cron expression
    const cron = require('node-cron');
    if (!cron.validate(cronExpr)) {
      res.status(400).json({ error: '无效的 cron 表达式' });
      return;
    }

    // ===== Agent task (no screening, just AI with prompt) =====
    if (type === 'agent') {
      if (!prompt) {
        res.status(400).json({ error: 'AI任务需要提供 prompt' });
        return;
      }

      const task = scheduler.addTask({
        userId,
        taskType: 'agent',
        cronExpr,
        strategies: [],
        email: email || '',
        backtestConfig: undefined,
        aiMode: 'agent',
        label: label || `AI任务: ${prompt.slice(0, 30)}${prompt.length > 30 ? '...' : ''}`,
        prompt,
        enabled: true,
      });

      userStore.addLog(userId, {
        type: 'system',
        action: '创建定时AI任务',
        detail: `定时: ${cronExpr} | prompt: ${prompt.slice(0, 50)}`,
      });

      res.json({ task });
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
      prompt,
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

  /** PUT /api/scheduler/tasks/:id — update task fields (prompt, label, cronExpr, etc.) */
  router.put('/api/scheduler/tasks/:id', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return;
    }

    const { prompt, label, cronExpr, email, aiMode, strategies, backtestConfig, enabled } = req.body;

    const updated = scheduler.updateTask(req.params['id'], {
      prompt, label, cronExpr, email, aiMode, strategies, backtestConfig, enabled,
    });

    if (!updated) {
      res.status(404).json({ error: '任务未找到' });
      return;
    }

    userStore.addLog(userId, {
      type: 'system',
      action: '更新定时任务',
      detail: `任务ID: ${req.params['id']} | label: ${label || '(unchanged)'}`,
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

  /** POST /api/scheduler/tasks/:id/cancel — cancel a queued or running task */
  router.post('/api/scheduler/tasks/:id/cancel', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '\u672a\u767b\u5f55' });
      return;
    }

    const result = scheduler.cancelTask(req.params['id']);
    res.json(result);
  });

  /** GET /api/scheduler/agent-stream/:taskId — SSE stream for agent real-time output */
  router.get('/api/scheduler/agent-stream/:taskId', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '\u672a\u767b\u5f55' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: connected\ndata: {}\n\n');

    scheduler.subscribeAgentStream(req.params['taskId'], res);
  });

  /** GET /api/scheduler/queue — get queue/running status for current user */
  
  router.get('/api/scheduler/queue', (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: '\u672a\u767b\u5f55' });
      return;
    }

    const status = scheduler.getQueueStatus(userId);
    res.json(status);
  });

  return router;
}
