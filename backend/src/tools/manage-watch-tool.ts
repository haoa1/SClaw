/**
 * Watch Tool — AI agent tool for managing 盯盘 (real-time stock monitoring) tasks.
 *
 * One tool, 6 actions: create / list / delete / toggle / result / update
 */

import { ToolRegistry, Tool } from './registry';
import { WatchEngine } from '../watch-engine';
import type { WatchTask, WatchCondition } from '../types';

export function registerManageWatchTool(
  registry: ToolRegistry,
  watchEngine: WatchEngine,
  getUserId: () => string | null,
): void {
  registry.register(new Tool(
    'manage_watch',
    `管理盯盘（实时监控）任务。支持: create(创建), list(列出), delete(删除), toggle(启用/停用), result(上次报警), update(更新).

条件类型说明 (conditions JSON 数组，OR 逻辑，任一满足即报警):
1. price_change: 价格变动
   {"type":"price_change","direction":"up|down|either","thresholdPercent":5}
   direction: up=涨超, down=跌超, either=涨跌都算

2. volume_spike: 放量
   {"type":"volume_spike","ratio":3}
   ratio: 量比倍数

3. price_cross: 突破/跌破价位
   {"type":"price_cross","cross":"above|below","price":200}
   above=向上突破, below=向下跌破

4. new_high_low: 创52周新高/新低
   {"type":"new_high_low","period":"52week","direction":"high|low"}

5. combined: 复合条件
   {"type":"combined","operator":"AND|OR","conditions":[...]}
   operator: AND=全部满足, OR=任一满足

示例: '[{"type":"price_change","direction":"down","thresholdPercent":3},{"type":"volume_spike","ratio":2}]'
= 跌超3% 或 量比超2倍 就报警`,
    [
      { name: 'action', type: 'string', description: '操作: create / list / delete / toggle / result / update', required: true },
      { name: 'taskId', type: 'string', description: '任务ID（delete/toggle/result/update需要）', required: false },
      { name: 'label', type: 'string', description: '任务标签（create可选）', required: false },
      { name: 'watchTargets', type: 'string', description: '逗号分隔的股票代码，如 "000001,300750,600519"（create需要）', required: false },
      { name: 'conditions', type: 'string', description: 'JSON条件数组（create需要），见工具描述', required: false },
      { name: 'interval', type: 'number', description: '检查间隔秒数，最小30秒（默认60）', required: false },
      { name: 'cooldownSeconds', type: 'number', description: '重复报警冷却秒数（默认300，即5分钟）', required: false },
      { name: 'enabled', type: 'string', description: 'true=启用 false=停用（toggle需要）', required: false },
    ],
    async (args) => {
      const userId = getUserId();
      if (!userId) return '❌ 未登录';

      const action = args['action'] as string;

      switch (action) {
        // ===== CREATE =====
        case 'create': {
          const watchTargets = args['watchTargets'] as string;
          const conditionsStr = args['conditions'] as string;

          if (!watchTargets || !conditionsStr) {
            return '❌ create 需要 watchTargets（股票代码）和 conditions（条件）';
          }

          let conditions: WatchCondition[];
          try {
            conditions = JSON.parse(conditionsStr);
          } catch {
            return '❌ conditions 格式错误，请提供有效的 JSON 数组';
          }

          if (!Array.isArray(conditions) || conditions.length === 0) {
            return '❌ 至少需要一个条件';
          }

          const codes = watchTargets.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
          if (codes.length === 0) return '❌ 请提供有效的股票代码';

          // Use nanoid if available, else simple ID
          let taskId: string;
          try {
            const { nanoid } = require('nanoid');
            taskId = nanoid();
          } catch {
            taskId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          }

          const task: WatchTask = {
            id: taskId,
            userId,
            enabled: true,
            interval: (args['interval'] as number) || 60,
            watchTargets: codes,
            conditions,
            label: (args['label'] as string) || undefined,
            cooldownSeconds: (args['cooldownSeconds'] as number) || 300,
            alertChannels: { frontend: true, email: false, agent: true },
            _state: {},
            createdAt: Date.now(),
          };

          watchEngine.addTask(task);
          return `✅ 盯盘任务创建成功！
  ID: ${taskId}
  ${task.label ? `标签: ${task.label}` : ''}
  监控: ${codes.length} 只股票
  间隔: ${task.interval}秒
  条件数: ${conditions.length}
  冷却: ${task.cooldownSeconds}秒`;
        }

        // ===== LIST =====
        case 'list': {
          const tasks = watchEngine.listTasks(userId);
          if (tasks.length === 0) return '📭 暂无盯盘任务';

          const lines = tasks.map(t => {
            const status = t.enabled ? '🟢' : '🔴';
            const label = t.label ? `「${t.label}」` : '';
            return `${status} [${t.id}] ${label} ${t.watchTargets.length}只股票 @ ${t.interval}s/次
   条件: ${t.conditions.map(c => c.type).join(', ')}
   冷却: ${t.cooldownSeconds}s${t.lastAlert ? ` | 上次报警: ${new Date(t.lastAlert.timestamp).toLocaleString('zh-CN')}` : ''}`;
          });

          return `📋 共 ${tasks.length} 个盯盘任务\n\n${lines.join('\n\n')}`;
        }

        // ===== DELETE =====
        case 'delete': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ delete 需要 taskId';

          const deleted = watchEngine.removeTask(taskId);
          return deleted ? `✅ 任务 ${taskId} 已删除` : `❌ 任务 ${taskId} 未找到`;
        }

        // ===== TOGGLE =====
        case 'toggle': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ toggle 需要 taskId';

          const enabled = args['enabled'] as string | undefined;
          const targetState = enabled !== undefined ? enabled === 'true' : undefined;

          const task = watchEngine.toggleTask(taskId, targetState);
          if (!task) return `❌ 任务 ${taskId} 未找到`;

          return `✅ 任务 ${taskId} 已${task.enabled ? '启用' : '停用'}`;
        }

        // ===== RESULT =====
        case 'result': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ result 需要 taskId';

          const task = watchEngine.getTask(taskId);
          if (!task) return `❌ 任务 ${taskId} 未找到`;
          if (!task.lastAlert) return '📭 暂无报警记录';

          const t = task.lastAlert;
          return `📊 上次报警 (${task.label || taskId})
  股票: ${t.stock}
  条件: ${t.conditionType}
  消息: ${t.message}
  时间: ${new Date(t.timestamp).toLocaleString('zh-CN')}`;
        }

        // ===== UPDATE =====
        case 'update': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ update 需要 taskId';

          const existing = watchEngine.getTask(taskId);
          if (!existing) return `❌ 任务 ${taskId} 未找到`;

          const update: Partial<WatchTask> = {};

          if (args['watchTargets']) {
            update.watchTargets = (args['watchTargets'] as string).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
          }
          if (args['conditions']) {
            try {
              update.conditions = JSON.parse(args['conditions'] as string) as WatchCondition[];
            } catch {
              return '❌ conditions 格式错误';
            }
          }
          if (args['interval'] !== undefined) update.interval = args['interval'] as number;
          if (args['cooldownSeconds'] !== undefined) update.cooldownSeconds = args['cooldownSeconds'] as number;
          if (args['label'] !== undefined) update.label = args['label'] as string;

          const updated = watchEngine.updateTask(taskId, update);
          return updated ? `✅ 任务 ${taskId} 已更新` : `❌ 更新失败`;
        }

        default:
          return `❌ 未知操作: ${action}，支持: create / list / delete / toggle / result / update`;
      }
    },
  ));
}
