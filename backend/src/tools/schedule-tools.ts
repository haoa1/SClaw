/**
 * Schedule Tool — unified AI agent tool for scheduled screening tasks.
 *
 * One tool, 5 actions: create / list / delete / toggle / run
 */

import { ToolRegistry, Tool } from './registry';
import { ScreenScheduler } from '../scheduler';
import { PluginManager } from '../plugin-system/plugin-manager';

export function registerScheduleTools(
  registry: ToolRegistry,
  scheduler: ScreenScheduler,
  pluginManager: PluginManager,
  getUserId: () => string | null,
): void {
  registry.register(new Tool(
    'manage_schedule',
    '管理定时选股/回测任务。支持操作: create(创建), list(列出), delete(删除), toggle(启用/停用), run(立即执行), result(查看最近一次执行结果)。\n\n创建选股任务 (taskType=screen, 默认):\n  aiMode 参数说明:\n    - email (默认): 纯机械筛选→发邮件，不进AI\n    - agent: 机械筛选→AI分析→存聊天记录，不发邮件\n    - both: 发邮件 + AI分析都做\n\n创建回测任务 (taskType=backtest):\n  额外需要 backtestConfig JSON: {\n    startDate: "2024-01-01",\n    endDate: "2025-12-31",\n    rebalanceFrequency: "monthly" | "weekly" | "quarterly" | "none",\n    initialCapital: 1000000,\n    maxPositions: 5,\n    commission: 0.0003,\n    benchmark: "000300.SH" (可选),\n    stopLoss: -15 (可选),\n    takeProfit: 50 (可选),\n    slippageModel: "fixed" | "none" | "volume"\n  }',
    [
      { name: 'action', type: 'string', description: '操作: create / list / delete / toggle / run / result' },
      { name: 'taskId', type: 'string', description: '任务ID（delete/toggle/run 需要）', required: false },
      { name: 'cronExpr', type: 'string', description: 'cron 表达式，例如 "0 9 * * 1-5" = 工作日9点（create 需要）', required: false },
      { name: 'email', type: 'string', description: '接收报告的邮箱（create需要，回测任务可选）', required: false },
      { name: 'taskType', type: 'string', description: '任务类型: screen(默认,选股) / backtest(回测)', required: false },
      { name: 'backtestConfig', type: 'string', description: '回测配置JSON（taskType=backtest时需要）', required: false },
      { name: 'strategies', type: 'string', description: 'JSON 策略数组，例如 [{"pluginId":"volume","strategyId":"volume-surge","params":{"minChange":5}}]（create 需要）', required: false },
      { name: 'enabled', type: 'string', description: 'true=启用 false=停用（toggle 需要）', required: false },
      { name: 'label', type: 'string', description: '任务标签（create 可选）', required: false },
      { name: 'aiMode', type: 'string', description: 'AI分析模式(仅筛选任务): email(默认,纯邮件)/agent(仅AI分析存聊天)/both(邮件+AI分析)', required: false },
    ],
    async (args) => {
      const userId = getUserId();
      if (!userId) return '❌ 未登录';

      const action = args['action'] as string;

      switch (action) {
        // ===== CREATE =====
        case 'create': {
          const cronExpr = args['cronExpr'] as string;
          const email = (args['email'] as string) || '';
          const label = args['label'] as string | undefined;
          const taskType = (args['taskType'] as string) || 'screen';
          const aiMode = (args['aiMode'] as 'email' | 'agent' | 'both') || 'email';

          if (!cronExpr) {
            return '❌ create 需要提供 cronExpr';
          }

          let strategies: Array<{ pluginId: string; strategyId: string; params: Record<string, any> }>;
          try {
            strategies = JSON.parse(args['strategies'] as string);
          } catch {
            return '❌ strategies 格式错误，请提供有效的 JSON 数组';
          }
          if (!strategies?.length) return '❌ 至少需要一个策略';

          const cron = require('node-cron');
          if (!cron.validate(cronExpr)) {
            return '❌ 无效的 cron 表达式，请使用 5 段式 (分 时 日 月 周)';
          }

          const allPlugins = pluginManager.getAll();
          const resolvedData = strategies.map(s => {
            const plugin = allPlugins.find(p => p.id === s.pluginId);
            const strat = plugin?.strategies.find(st => st.id === s.strategyId);
            return {
              pluginId: s.pluginId,
              strategyId: s.strategyId,
              strategyName: strat?.name || s.strategyId,
              params: s.params || {},
            };
          });

          // ===== Backtest task =====
          if (taskType === 'backtest') {
            let backtestConfig: any;
            try {
              backtestConfig = JSON.parse(args['backtestConfig'] as string);
            } catch {
              return '❌ backtestConfig 格式错误，请提供有效的 JSON';
            }
            if (!backtestConfig.startDate || !backtestConfig.endDate) {
              return '❌ backtestConfig 需要 startDate 和 endDate';
            }

            const task = scheduler.addTask({
              userId,
              taskType: 'backtest',
              cronExpr,
              email,
              strategies: resolvedData,
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
              label: label || `回测: ${resolvedData.map(s => s.strategyName).join(', ')}`,
              enabled: true,
            });

            return `✅ 定时回测任务已创建！
  ───
  任务ID: ${task.id}
  标签: ${task.label}
  Cron: ${cronExpr}
  策略: ${resolvedData.map(s => s.strategyName).join(', ')}
  期间: ${backtestConfig.startDate} → ${backtestConfig.endDate}
  再平衡: ${backtestConfig.rebalanceFrequency || 'monthly'}
  初始资金: ¥${(backtestConfig.initialCapital || 1000000).toLocaleString()}
  基准: ${backtestConfig.benchmark || '无'}${email ? `\n  报告发送至: ${email}` : ''}`;
          }

          // ===== Screening task =====
          // email is required for email/both mode, optional for agent mode
          if ((aiMode === 'email' || aiMode === 'both') && !email) {
            return '❌ email/both 模式需要提供 email';
          }

          const aiModeLabel =
            aiMode === 'email' ? '纯邮件' :
            aiMode === 'agent' ? 'AI分析(存聊天)' : '邮件+AI分析';

          const task = scheduler.addTask({
            userId,
            taskType: 'screen',
            cronExpr,
            email,
            aiMode,
            strategies: resolvedData,
            label: label || `定时选股: ${resolvedData.map(s => s.strategyName).join(', ')}`,
            enabled: true,
          });

          let result = `✅ 定时任务已创建！
  ───
  任务ID: ${task.id}
  标签: ${task.label}
  Cron: ${cronExpr}
  策略: ${resolvedData.map(s => s.strategyName).join(', ')}
  模式: ${aiModeLabel}`;

          if (email) {
            result += `\n  发送至: ${email}`;
          }

          return result;
        }

        // ===== LIST =====
        case 'list': {
          const tasks = scheduler.listTasks(userId);
          if (tasks.length === 0) return '📭 暂无定时任务';

          let output = `📋 定时任务 (共 ${tasks.length} 个):\n`;
          for (const t of tasks) {
            const status = t.enabled ? '🟢' : '🔴';
            const lastRun = t.lastRun ? new Date(t.lastRun).toLocaleString('zh-CN') : '从未';
            const aiModeLabel =
              t.aiMode === 'agent' ? '🤖' :
              t.aiMode === 'both' ? '📧🤖' : '📧';
            output += `\n${status} ${aiModeLabel} [${t.id}] ${t.label || '未命名'}
   Cron: ${t.cronExpr} | ${t.email ? `邮件: ${t.email} | ` : ''}上次: ${lastRun}`;
          }
          return output;
        }

        // ===== DELETE =====
        case 'delete': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ 需要 taskId';
          return scheduler.removeTask(taskId)
            ? `✅ 任务 ${taskId} 已删除`
            : `❌ 任务 ${taskId} 未找到`;
        }

        // ===== TOGGLE =====
        case 'toggle': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ 需要 taskId';
          const enabled = args['enabled'] === 'true';
          return scheduler.setEnabled(taskId, enabled)
            ? `✅ 任务 ${taskId} 已${enabled ? '启用' : '停用'}`
            : `❌ 任务 ${taskId} 未找到`;
        }

        // ===== RUN =====
        case 'run': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ 需要 taskId';
          const started = await scheduler.runNow(taskId);
          return started
            ? `✅ 任务 ${taskId} 已触发执行，结果将通过邮件发送`
            : `❌ 任务 ${taskId} 未找到或执行失败`;
        }

        // ===== RESULT =====
        case 'result': {
          const taskId = args['taskId'] as string;
          if (!taskId) return '❌ 需要 taskId';
          const tasks = scheduler.listAllTasks();
          const task = tasks.find(t => t.id === taskId && t.userId === userId);
          if (!task) return `❌ 任务 ${taskId} 未找到`;
          if (!task.lastResult) return `📭 任务 "${task.label || taskId}" 还没有执行记录`;
          const r = task.lastResult;
          const time = new Date(r.timestamp).toLocaleString('zh-CN');
          let output = `📊 任务 "${task.label || taskId}" 最近一次执行结果 (${time}):\n`;
          output += `  策略: ${r.strategies}\n`;
          output += `  命中: ${r.matchedCount} / ${r.totalCount}\n`;
          if (r.topResults.length > 0) {
            output += `  前 ${r.topResults.length} 名:\n`;
            for (const s of r.topResults) {
              output += `    ${s.code} ${s.name} (评分: ${s.score.toFixed(2)})\n`;
            }
          }
          return output;
        }

        default:
          return `❌ 未知操作 "${action}"，支持: create, list, delete, toggle, run, result`;
      }
    },
  ));
}
