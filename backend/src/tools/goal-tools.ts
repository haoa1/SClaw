/**
 * Goal Tool — manage active goals with step tracking.
 *
 * One tool, 9 actions: set / set_plan / add_step / remove_step / complete_step / status / done / cancel / resume
 *
 * Data stored in <dataDir>/goals.json, scoped by userId.
 * userId is obtained from request-context (AsyncLocalStorage), set by chat routes via runWithUserId().
 */

import { ToolRegistry, Tool } from './registry';
import { getCurrentUserId } from '../request-context';
import * as fs from 'fs';
import * as path from 'path';

// ===== Types =====

interface GoalStep {
  step: number;
  desc: string;
  status: 'pending' | 'done';
  summary?: string;
}

interface Goal {
  id: string;
  description: string;
  status: 'active' | 'completed' | 'cancelled';
  paused: boolean;
  plan: GoalStep[];
  current_step: number;
  created_at: string;
  updated_at: string;
}

interface UserGoals {
  current: Goal | null;
  history: Goal[];
}

interface GoalsStore {
  sessions: Record<string, UserGoals>;
}

// ===== Storage =====

function getDataDir(): string {
  // backend/src/tools/goal-tools.ts -> backend -> SClaw root
  return path.resolve(__dirname, '..', '..', '..', 'data');
}

function getGoalsPath(): string {
  return path.join(getDataDir(), 'goals.json');
}

function loadGoals(): GoalsStore {
  const p = getGoalsPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {
    console.error('[Goal] Failed to load goals.json, starting fresh:', e);
  }
  return { sessions: {} };
}

function saveGoals(store: GoalsStore): void {
  const p = getGoalsPath();
  try {
    fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Goal] Failed to save goals.json:', e);
  }
}

function getSessionKey(userId: string): string {
  return `session-${userId}`;
}

function getOrCreateUserGoals(store: GoalsStore, userId: string): UserGoals {
  const key = getSessionKey(userId);
  if (!store.sessions[key]) {
    store.sessions[key] = { current: null, history: [] };
  }
  return store.sessions[key];
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ===== Tool Executor =====

function goalExecutor(args: Record<string, unknown>): string {
  const userId = getCurrentUserId();
  if (!userId) {
    return '❌ 未登录，无法使用 goal 工具';
  }

  const action = (args['action'] as string) || '';
  const store = loadGoals();
  const userGoals = getOrCreateUserGoals(store, userId);

  switch (action) {
    // ===== SET =====
    case 'set': {
      const description = (args['description'] as string) || '';
      if (!description) {
        return '❌ set 需要提供 description（目标描述）';
      }

      const goal: Goal = {
        id: generateId(),
        description,
        status: 'active',
        paused: false,
        plan: [],
        current_step: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Archive current goal if exists
      if (userGoals.current) {
        userGoals.history.push(userGoals.current);
      }

      userGoals.current = goal;
      saveGoals(store);

      return `✅ 目标已创建: "${description}"\n📋 目标ID: ${goal.id}\n💡 下一步: 使用 goal(action="set_plan", steps_json=...) 设置步骤计划`;
    }

    // ===== SET PLAN =====
    case 'set_plan': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标，请先使用 goal(action="set", description="...") 创建目标';
      }

      const stepsJson = (args['steps_json'] as string) || '';
      let steps: Array<{ step: number; desc: string }>;

      try {
        steps = JSON.parse(stepsJson);
      } catch {
        return '❌ steps_json 格式错误，请提供有效的 JSON 数组\n示例: [{"step":1,"desc":"第一步"}, {"step":2,"desc":"第二步"}]';
      }

      if (!Array.isArray(steps) || steps.length === 0) {
        return '❌ 至少需要一个步骤';
      }

      userGoals.current.plan = steps.map(s => ({
        step: s.step,
        desc: s.desc,
        status: 'pending' as const,
      }));
      userGoals.current.current_step = 1;
      userGoals.current.updated_at = new Date().toISOString();
      saveGoals(store);

      const stepList = steps.map(s => `  ${s.step}. ${s.desc}`).join('\n');
      return `✅ 计划已设置，共 ${steps.length} 步:\n${stepList}\n\n💡 使用 goal(action="complete_step", step_number=n, summary="...") 逐步完成`;
    }

    // ===== ADD STEP =====
    case 'add_step': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标';
      }

      const stepDesc = (args['step_desc'] as string) || '';
      if (!stepDesc) {
        return '❌ add_step 需要提供 step_desc';
      }

      const nextStepNum = userGoals.current.plan.length + 1;
      userGoals.current.plan.push({
        step: nextStepNum,
        desc: stepDesc,
        status: 'pending',
      });
      userGoals.current.updated_at = new Date().toISOString();
      saveGoals(store);

      return `✅ 已添加步骤 ${nextStepNum}: "${stepDesc}"`;
    }

    // ===== REMOVE STEP =====
    case 'remove_step': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标';
      }

      const stepNumber = args['step_number'] as number;
      if (!stepNumber || stepNumber < 1) {
        return '❌ remove_step 需要有效的 step_number';
      }

      const idx = userGoals.current.plan.findIndex(s => s.step === stepNumber);
      if (idx === -1) {
        return `❌ 未找到步骤 ${stepNumber}`;
      }

      const removed = userGoals.current.plan.splice(idx, 1)[0];
      // Renumber remaining steps
      userGoals.current.plan = userGoals.current.plan.map((s, i) => ({
        ...s,
        step: i + 1,
      }));
      userGoals.current.updated_at = new Date().toISOString();
      saveGoals(store);

      return `✅ 已移除步骤 ${stepNumber}: "${removed.desc}"`;
    }

    // ===== COMPLETE STEP =====
    case 'complete_step': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标';
      }

      const stepNumber = args['step_number'] as number;
      if (!stepNumber || stepNumber < 1) {
        return '❌ complete_step 需要有效的 step_number';
      }

      const step = userGoals.current.plan.find(s => s.step === stepNumber);
      if (!step) {
        return `❌ 未找到步骤 ${stepNumber}`;
      }

      step.status = 'done';
      step.summary = (args['summary'] as string) || '';
      userGoals.current.current_step = stepNumber + 1;
      userGoals.current.updated_at = new Date().toISOString();

      // Check if all steps are done
      const allDone = userGoals.current.plan.every(s => s.status === 'done');
      if (allDone) {
        userGoals.current.status = 'completed';
        const goal = userGoals.current;
        userGoals.history.push(goal);
        userGoals.current = null;
        saveGoals(store);
        return `🎉 所有步骤已完成！目标 "${goal.description}" 已完成！`;
      }

      saveGoals(store);

      const doneCount = userGoals.current.plan.filter(s => s.status === 'done').length;
      const totalCount = userGoals.current.plan.length;
      const nextStep = userGoals.current.plan.find(s => s.status === 'pending');

      let reply = `✅ 步骤 ${stepNumber} "${step.desc}" 已完成！[${doneCount}/${totalCount}]`;
      if (nextStep) {
        reply += `\n📋 下一步: 步骤 ${nextStep.step}: "${nextStep.desc}"`;
      }
      return reply;
    }

    // ===== STATUS =====
    case 'status': {
      if (!userGoals.current) {
        // Show last completed goal if any
        const lastCompleted = userGoals.history.filter(g => g.status === 'completed').slice(-1)[0];
        if (lastCompleted) {
          const doneCount = lastCompleted.plan.filter(s => s.status === 'done').length;
          return `📭 当前没有活跃目标\n✅ 上一个已完成目标: "${lastCompleted.description}" (${doneCount}/${lastCompleted.plan.length} 步)`;
        }
        return '📭 当前没有活跃目标';
      }

      const g = userGoals.current;
      const doneCount = g.plan.filter(s => s.status === 'done').length;
      const totalCount = g.plan.length;
      const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

      let statusIcon = g.paused ? '⏸️' : '▶️';
      let statusText = g.paused ? '已暂停' : '进行中';

      let reply = `${statusIcon} 目标: "${g.description}" [${statusText}]\n`;
      reply += `📊 进度: ${doneCount}/${totalCount} 步 (${progress}%)\n`;

      if (g.plan.length > 0) {
        reply += `\n📋 步骤计划:\n`;
        for (const s of g.plan) {
          const icon = s.status === 'done' ? '✅' : '⬜';
          const summary = s.summary ? ` — ${s.summary}` : '';
          reply += `  ${icon} ${s.step}. ${s.desc}${summary}\n`;
        }
      } else {
        reply += '\n💡 尚未设置步骤计划，使用 goal(action="set_plan", steps_json=...) 设置';
      }

      return reply;
    }

    // ===== DONE =====
    case 'done': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标';
      }

      const goal = userGoals.current;
      goal.status = 'completed';
      goal.updated_at = new Date().toISOString();

      // Mark all pending steps as done
      for (const s of goal.plan) {
        if (s.status === 'pending') {
          s.status = 'done';
          s.summary = s.summary || '(标记完成)';
        }
      }

      userGoals.history.push(goal);
      userGoals.current = null;
      saveGoals(store);

      return `🎉 目标 "${goal.description}" 已完成！共 ${goal.plan.length} 步。`;
    }

    // ===== CANCEL =====
    case 'cancel': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标';
      }

      const goal = userGoals.current;
      goal.status = 'cancelled';
      goal.updated_at = new Date().toISOString();

      userGoals.history.push(goal);
      userGoals.current = null;
      saveGoals(store);

      return `🗑️ 目标 "${goal.description}" 已取消。`;
    }

    // ===== RESUME =====
    case 'resume': {
      if (!userGoals.current) {
        return '❌ 当前没有活跃目标';
      }

      if (!userGoals.current.paused) {
        return 'ℹ️ 目标当前不是暂停状态';
      }

      userGoals.current.paused = false;
      userGoals.current.updated_at = new Date().toISOString();
      saveGoals(store);

      return `▶️ 目标 "${userGoals.current.description}" 已恢复。继续加油！`;
    }

    default: {
      return `❌ 未知操作: "${action}"\n\n支持的操作:\n  set(description)         — 创建新目标\n  set_plan(steps_json)     — 设置步骤计划\n  add_step(step_desc)      — 添加步骤\n  remove_step(step_number) — 移除步骤\n  complete_step(step_number, summary, is_last) — 完成步骤\n  status                   — 查看当前目标进度\n  done                     — 完成整个目标\n  cancel                   — 取消目标\n  resume                   — 恢复暂停的目标`;
    }
  }
}

// ===== Register =====

export function registerGoalTool(registry: ToolRegistry): void {
  registry.register(
    new Tool(
      'goal',
      '管理活跃目标 — 设置、跟踪进度、完成或取消。' +
      '支持操作: set / set_plan / add_step / remove_step / complete_step / status / done / cancel / resume。\n' +
      '  • goal(action="set", description="...") — 创建新目标\n' +
      '  • goal(action="set_plan", steps_json=\'[{"step":1,"desc":"..."}]\') — 设置步骤计划\n' +
      '  • goal(action="add_step", step_desc="...") — 添加步骤\n' +
      '  • goal(action="remove_step", step_number=1) — 移除步骤\n' +
      '  • goal(action="complete_step", step_number=1, summary="完成内容", is_last=false) — 完成某步骤\n' +
      '  • goal(action="status") — 查看当前目标进度\n' +
      '  • goal(action="done") — 完成整个目标\n' +
      '  • goal(action="cancel") — 取消目标\n' +
      '  • goal(action="resume") — 恢复暂停的目标',
      [
        {
          name: 'action',
          type: 'string',
          description: '操作: set / set_plan / add_step / remove_step / complete_step / status / done / cancel / resume',
        },
        {
          name: 'description',
          type: 'string',
          description: '目标描述 (action=set 时需要)',
          required: false,
        },
        {
          name: 'steps_json',
          type: 'string',
          description: '步骤计划 JSON 数组 (action=set_plan 时需要)，如 [{"step":1,"desc":"第一步"}, {"step":2,"desc":"第二步"}]',
          required: false,
        },
        {
          name: 'step_number',
          type: 'number',
          description: '步骤编号 (action=remove_step/complete_step 时需要)',
          required: false,
        },
        {
          name: 'step_desc',
          type: 'string',
          description: '步骤描述 (action=add_step 时需要)',
          required: false,
        },
        {
          name: 'summary',
          type: 'string',
          description: '完成摘要 (action=complete_step 时可选)',
          required: false,
        },
        {
          name: 'is_last',
          type: 'boolean',
          description: '是否是最后一步 (action=complete_step 时可选，默认自动检测)',
          required: false,
        },
      ],
      (args) => {
        return goalExecutor(args);
      }
    )
  );
}
