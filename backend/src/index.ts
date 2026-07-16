/**
 * SClaw Backend — main entry point.
 *
 * Integrates:
 *   - Plugin system (loaded from plugins/)
 *   - Strategy engine (plugin-based screening)
 *   - Data fetcher (market data)
 *   - AI agent (per-user chat with tool execution)
 *   - Auth (session-based)
 *   - User storage (config, screen history, logs)
 */

// Load .env config (must be first)
import 'dotenv/config';
import express from "express";
import cors from "cors";
import path from "path";
import { PluginManager } from "./plugin-system/plugin-manager";
import { StrategyEngine } from "./strategies/strategy-engine";
import { DataFetcher } from "./data/data-fetcher";
import { ToolRegistry } from "./tools/registry";
import { UserStore } from "./user-store";
import { PerUserAgentManager } from "./agent/manager";
import { createRoutes } from "./routes/api";
import { createAuthRoutes } from "./routes/auth";
import { createChatRoutes } from "./routes/chat";
import { createUserRoutes } from "./routes/user";

// Scheduler
import { ScreenScheduler } from "./scheduler";
import { createSchedulerRoutes } from "./routes/scheduler";

// Backtest
import { createBacktestRoutes } from "./routes/backtest";
import { LocalDatabase } from "./data/local-database";
import { LocalDBDataProvider } from "./backtest/data-provider";

// Data sync
import { createDataSyncRoutes } from "./routes/data-sync";

// Garuda admin routes
import { createGarudaRoutes } from "./routes/garuda";

// Trade routes (proxy to Garuda Trade Bridge on Mac:5001)
import { createTradeRoutes } from "./routes/trade";

// Chat (for saving AI analysis results)
import { saveMessages, loadMessages, chatUpdateNotify } from "./routes/chat";

// LLM client (for silent agent analysis — currently unused, import kept for reference)
// import { LLMClient } from "./agent/llm";

// Register all tools
import { registerFileTools, bashTool } from "./tools/file-tools";
import { registerStockTool } from "./tools/stock";
import { registerStockIndicatorsTool } from "./tools/stock-indicators";
import { registerScreenTool } from "./tools/screen";
import { registerStrategyTool } from "./tools/strategy";
import { registerRiskTool } from "./tools/risk";
import { registerMemoryTools } from "./tools/memory-recall";
import { registerScheduleTools } from "./tools/schedule-tools";
import { registerSandboxTools } from "./tools/sandbox";
import { SkillManager } from "./skill-manager";
import { registerSkillTool } from "./tools/skill";
import { registerEmailTools } from "./tools/email-tools";
import { registerDeepAnalysisTool } from "./tools/deep-analysis";
import { registerCompactTool } from "./tools/compact-tool";
import { registerGoalTool } from "./tools/goal-tools";

// Watch engine (盯盘)
import { WatchEngine } from "./watch-engine";
import { registerManageWatchTool } from "./tools/manage-watch-tool";
import { createWatchStreamRoutes } from "./routes/watch-stream";
import { registerTradeTools } from "./tools/trade";

// SubAgent system
import { SubAgentManager } from "./agent/sub-agent-manager";
import { SubAgentYamlLoader } from "./agent/subagent-yaml-loader";
import { registerSubAgentTool } from "./tools/subagent-tool";
import { createSubAgentRoutes } from "./routes/subagent";

// System prompt for AI agent — keep it simple, delegate complexity to sub-agents
const SYSTEM_PROMPT = `You are the **main agent** — a coordinator for SClaw stock analysis platform.

## Your Role
1. Handle **simple requests** directly (quotes, K-line, screens, account, schedules)
2. **Delegate complex work** to sub-agents via \`agent_tool\`

## Delegate When
- Task needs 3+ tool calls, deep analysis (缠论/筹码/深度), complex research, or you're uncertain
- Available sub-agent types: general-purpose, coder, analyzer, debugger, researcher, planner, reviewer, integrator, chanlun

## Safety
- Present data; let user decide. Never say "buy this/sell that".
- Account/position queries: execute directly.
- Buy/sell: always show details, get user confirmation first.
- Never fabricate data. If a tool fails, explain clearly.
- Rely on tool function definitions for parameter details.
`;

/**
 * Create and configure the Express app — no side effects, no listening.
 * Used by both main() and tests.
 */
export async function createApp(options?: { pluginsDir?: string; dataDir?: string }) {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  // ===== Initialize core components =====
  const pluginsDir = options?.pluginsDir || path.resolve(__dirname, "../../plugins/common");
  const usersPluginsDir = options?.pluginsDir
    ? path.resolve(options.pluginsDir, '..', 'users')
    : path.resolve(__dirname, "../../plugins/users");
  const dataDir = options?.dataDir || path.resolve(process.cwd(), "data");

  const pluginManager = new PluginManager(pluginsDir, usersPluginsDir);
  const dataFetcher = new DataFetcher();
  const strategyEngine = new StrategyEngine(() => pluginManager.getAll());
  const userStore = new UserStore(dataDir);

  // Load plugins
  await pluginManager.loadAll();
  pluginManager.startWatching();

  // ===== Initialize scheduler =====
  const scheduler = new ScreenScheduler(
    strategyEngine,
    dataFetcher,
    userStore,
    dataDir,
    () => pluginManager.getAll(),
  );

  // ===== Initialize watch engine (盯盘) =====
  const watchEngine = new WatchEngine(
    path.resolve(dataDir, 'watch-tasks.json'),
    {
      fetchQuotes: (codes) => dataFetcher.fetchQuotes(codes).then(r => r.quotes),
    },
  );

  // ===== Initialize tool registry =====
  const toolRegistry = new ToolRegistry();
  registerFileTools(toolRegistry);
  toolRegistry.register(bashTool);
  registerStockTool(toolRegistry);
  registerStockIndicatorsTool(toolRegistry);
  registerScreenTool(toolRegistry);
  registerStrategyTool(toolRegistry);

  // Wire PluginManager to strategy tools (for user-scoped plugin access)
  const { setPluginManager } = require("./tools/strategy-validator");
  setPluginManager(pluginManager);
  registerRiskTool(toolRegistry);
  registerMemoryTools(toolRegistry);
  registerSandboxTools(toolRegistry);
  registerScheduleTools(toolRegistry, scheduler, pluginManager, () => {
    // Lazy: get current userId from per-request context
    const { getCurrentUserId } = require("./request-context");
    return getCurrentUserId();
  });
  registerEmailTools(toolRegistry);
  registerDeepAnalysisTool(toolRegistry);
  registerCompactTool(toolRegistry);
  registerGoalTool(toolRegistry);
  registerManageWatchTool(toolRegistry, watchEngine, () => {
    const { getCurrentUserId } = require("./request-context");
    return getCurrentUserId();
  });
  registerTradeTools(toolRegistry);

  // ===== Initialize SubAgent system =====
  const subAgentManager = new SubAgentManager(toolRegistry);

  // YAML agent loader (hot-reloadable agents from agents/ directory)
  const yamlAgentLoader = new SubAgentYamlLoader(
    path.resolve(__dirname, "../agents"),
  );
  yamlAgentLoader.init();
  subAgentManager.setYamlLoader(yamlAgentLoader);

  registerSubAgentTool(toolRegistry, subAgentManager, () => {
    const { getCurrentUserId } = require("./request-context");
    return getCurrentUserId();
  });

  // ===== Initialize agent manager =====
  const MAIN_AGENT_TOOLS = [
    // Core file/command
    "read_file", "write_file", "bash", "glob", "grep",
    // Stock data
    "stock", "stock_indicators",
    // Screening
    "screen", "run_screen",
    // Strategy
    "strategy", "list_strategies", "run_multi_strategy",
    // Risk
    "risk", "assess_portfolio_risk", "assess_stock_risk",
    // Memory & context
    "memory_recall", "compact", "goal",
    // Schedule & watch
    "manage_schedule", "manage_watch",
    // Trade
    "trade",
    // Sub-agent delegation (unified: spawn/get/stop/list via sub_cmd)
    "agent_tool",
    // Skills
    "skill", "list_skills", "load_skill", "unload_skill",
    // Deep analysis
    "run_deep_analysis",
    // Email
    "send_email",
    "send_screen_report",
    "send_backtest_report",
  ];
  const agentManager = new PerUserAgentManager(toolRegistry, dataDir, MAIN_AGENT_TOOLS);
  // Override system prompt
  agentManager.systemPrompt = SYSTEM_PROMPT;

  // ===== Initialize skill system =====
  const skillManager = new SkillManager();
  registerSkillTool(toolRegistry, skillManager, agentManager, () => {
    const { getCurrentUserId } = require("./request-context");
    return getCurrentUserId();
  });

  // Wire scheduler to push notifications to agent manager
  scheduler.pushNotification = (userId, notification) => {
    agentManager.pushNotification(userId, notification);
  };

  // Wire scheduler to push user-facing queue notifications to agent manager
  scheduler.pushUserNotification = (userId, notification) => {
    agentManager.pushNotification(userId, { ...notification, status: notification.type === 'completed' ? 'completed' : 'failed', strategies: '', matchedCount: 0, totalCount: 0, topResults: [], timestamp: Date.now() });
  };

  // Wire scheduler to abort agents on task cancel
  scheduler.abortAgent = (userId) => {
    agentManager.abortAgent(userId);
  };

  // Wire watch engine to push notifications to agent manager
  watchEngine.deps = {
    ...watchEngine.deps,
    pushNotification: (userId, notification) => {
      agentManager.pushNotification(userId, notification);
    },
  };

  // Wire scheduler to run AI analysis on screening results (aiMode=agent/both)
  // Uses the full PerUserAgentManager agent so it has tool access (K-line, data fetch, etc.)
  scheduler.analyzeWithAgent = async (taskId, userId, taskLabel, strategyNames, topResults, customPrompt) => {
    try {
      const agent = agentManager.getAgent(userId);
      agent.setDebug(true);
      agent.reset(); // Fresh start — no leftover state from previous failed runs

      // Build context: use custom prompt if provided, otherwise default stock analysis
      const context = customPrompt
        ? `📋 [定时任务] "${taskLabel}"\n\n${customPrompt}`
        : `📊 [定时选股任务] "${taskLabel}"

策略: ${strategyNames.join(', ')}

选股结果（前${topResults.length}只）:
${topResults.map((r, i) => `${i + 1}. ${r.code} ${r.name} — 评分: ${r.score.toFixed(2)}`).join('\n')}

请对以上选股结果进行专业分析。使用工具拉取K线数据、实时行情等，完成以下分析要求：

1. 🔄 重新评分排名 — 机选评分仅供参考。请根据实时行情、技术面、估值等数据，对每只股票重新打分(0-100)并排序，给出你的评分理由
2. 📊 筹码分析 — 分析每只股票的筹码分布情况：主力资金动向（大单买卖）、成交量变化趋势、换手率是否异常、是否有资金吸筹或出货迹象
3. 📈 缠论买卖点分析 — 拉取日K线数据，分析每只股票的中枢位置、是否出现背驰信号、一/二/三类买卖点判断
4. 🏆 综合评级与建议 — 综合以上分析给出操作建议（强烈推荐/推荐/观望/回避），并说明理由

请直接开始分析，用工具获取数据后给出完整报告。`;

      const result = await agent.run(
        context,
        (token) => { scheduler.emitAgentEvent(taskId, 'token', { token }); },
        (token) => { scheduler.emitAgentEvent(taskId, 'reasoning', { token }); },
        (tc) => { scheduler.emitAgentEvent(taskId, 'tool_call', tc); },
        (turn) => { scheduler.emitAgentEvent(taskId, 'turn', { turn }); },
        (name, content) => { scheduler.emitAgentEvent(taskId, 'tool_result', { name, content: content.slice(0, 300) }); },
        undefined,
      );

      // Signal done via SSE
      scheduler.emitAgentEvent(taskId, 'done', {
        response: (result.response || '分析完成').slice(0, 500),
        toolCalls: result.toolCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      scheduler.closeAgentStream(taskId);

      const analysis = result.response || '分析完成';

      // Save to chat history as a message pair
      const history = loadMessages(userId);

      // Different message format depending on whether this is a screening-based or pure agent task
      const isAgentTask = strategyNames.length === 0 && topResults.length === 0;
      if (isAgentTask) {
        history.push({
          role: 'user',
          content: `🤖 [AI任务完成] "${taskLabel}"`,
        });
      } else {
        history.push({
          role: 'user',
          content: `📊 [定时选股报告] "${taskLabel}" 已完成\n策略: ${strategyNames.join(', ')}\n结果: ${topResults.length} 只股票`,
        });
      }
      history.push({
        role: 'assistant',
        content: analysis,
      });
      saveMessages(userId, history);

      // Notify chat SSE watchers that new messages are available
      chatUpdateNotify(userId);

      console.log(`[Scheduler] Agent analysis completed for user ${userId} (${analysis.length} chars)`);
      return analysis;
    } catch (err) {
      console.error('[Scheduler] Agent analysis error:', err);
      scheduler.emitAgentEvent(taskId, 'error', { message: String(err).slice(0, 300) });
      scheduler.closeAgentStream(taskId);

      // Even if AI analysis fails, save the screening results and notify the user
      try {
        const history = loadMessages(userId);
        const isAgentTask = strategyNames.length === 0 && topResults.length === 0;
        if (!isAgentTask) {
          history.push({
            role: 'user',
            content: `📊 [定时选股报告] "${taskLabel}" 已完成（AI分析失败）\n策略: ${strategyNames.join(', ')}\n结果: ${topResults.length} 只股票\n\n⚠️ AI分析失败: ${String(err).slice(0, 200)}`,
          });
          history.push({
            role: 'assistant',
            content: `选股结果如下:\n${topResults.slice(0, 10).map((r: any, i: number) => `${i + 1}. ${r.code} ${r.name} — 评分: ${r.score.toFixed(2)}`).join('\n')}`,
          });
          saveMessages(userId, history);
          chatUpdateNotify(userId);
        }
      } catch (e2) {
        console.error('[Scheduler] Failed to save fallback message:', e2);
      }

      return '';
    }
  };

  await scheduler.initialize();

  // Start the watch engine polling loop
  watchEngine.start();

  // ===== Register routes =====
  // API routes (plugins, strategies, screen, data, health, kline)
  const apiRoutes = createRoutes(pluginManager, strategyEngine, dataFetcher);
  app.use(apiRoutes);

  // Auth routes (login, logout, me)
  const authRoutes = createAuthRoutes();
  app.use(authRoutes);

  // Chat routes (POST /api/chat SSE, GET/POST /api/messages)
  const chatRoutes = createChatRoutes(agentManager, dataDir);
  app.use(chatRoutes);

  // User routes (config, screens, logs)
  const userRoutes = createUserRoutes(userStore);
  app.use(userRoutes);

  // Scheduler routes (CRUD for scheduled tasks)
  const schedulerRoutes = createSchedulerRoutes(scheduler, userStore, pluginManager);
  app.use(schedulerRoutes);

  // Backtest routes (POST /api/backtest/run, etc.)
  const localDb = new LocalDatabase(dataDir);
  const backtestDataProvider = new LocalDBDataProvider(localDb, dataFetcher);
  const backtestRoutes = createBacktestRoutes(strategyEngine, backtestDataProvider);
  app.use(backtestRoutes);

  // Data sync routes (POST /api/data/sync, GET /api/data/status)
  const tushareToken = process.env.TUSHARE_TOKEN || '';
  const dataSyncRoutes = createDataSyncRoutes(localDb, dataDir, tushareToken);
  app.use('/api/data', dataSyncRoutes);

  // Garuda admin routes + Trade routes (proxy to Garuda Trade Bridge at 127.0.0.1:5001)
  const garudaRoutes = createGarudaRoutes();
  app.use(garudaRoutes);
  const tradeRoutes = createTradeRoutes();
  app.use(tradeRoutes);

  // Watch stream SSE route (GET /api/watch/stream)
  const watchStreamRoutes = createWatchStreamRoutes(watchEngine);
  app.use(watchStreamRoutes);

  // SubAgent management routes
  const subAgentRoutes = createSubAgentRoutes(subAgentManager);
  app.use("/api/subagent", subAgentRoutes);

  // Wire scheduler to run backtest tasks
  scheduler.runBacktest = async (config) => {
    const { BacktestEngine } = require('./backtest/backtest-engine');
    const engine = new BacktestEngine(strategyEngine, backtestDataProvider);
    const result = await engine.run({
      startDate: config.startDate,
      endDate: config.endDate,
      strategies: config.strategies,
      rebalanceFrequency: config.rebalanceFrequency,
      initialCapital: config.initialCapital,
      maxPositions: config.maxPositions,
      commission: config.commission,
      benchmark: config.benchmark,
      stopLoss: config.stopLoss,
      takeProfit: config.takeProfit,
      slippageModel: config.slippageModel || 'fixed',
    });

    type TradeItem = { date: string; type: string; code: string; name: string; price: number; shares: number; amount: number };
    type HoldingItem = { code: string; name: string; weight: number };
    type PeriodItem = { holdings: HoldingItem[] };
    type EquityPoint = { date: string; value: number };

    const trades: TradeItem[] = (result.trades || []).map((t: TradeItem) => ({
      date: t.date,
      type: t.type,
      code: t.code,
      name: t.name,
      price: t.price,
      shares: t.shares,
      amount: t.amount,
    }));

    const topResults = result.periods && result.periods.length > 0
      ? result.periods
          .flatMap((p: PeriodItem) => p.holdings)
          .filter((h: HoldingItem, i: number, arr: HoldingItem[]) => arr.findIndex((x: HoldingItem) => x.code === h.code) === i)
          .slice(0, 5)
          .map((h: HoldingItem) => ({ code: h.code, name: h.name, score: h.weight }))
      : [];

    return {
      summary: {
        totalReturn: result.summary.totalReturn,
        annualizedReturn: result.summary.annualizedReturn,
        maxDrawdown: result.summary.maxDrawdown,
        sharpeRatio: result.summary.sharpeRatio,
        winRate: result.summary.winRate,
        totalTrades: result.summary.totalTrades,
        finalCapital: result.summary.finalCapital,
        benchmarkReturn: result.summary.benchmarkReturn,
      },
      trades,
      topResults,
      equityCurve: result.equityCurve.map((e: EquityPoint) => ({ date: e.date, value: e.value })),
    };
  };

  // ===== Static file serving for frontend =====
  const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
  // Cache JS/CSS bundles aggressively (hashed filenames), but NOT index.html
  app.use(express.static(frontendDist, {
    maxAge: "7d",
    setHeaders: (res, filePath) => {
      // index.html must NEVER be cached — otherwise browser loads old bundle after deploy
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }));
  // SPA fallback: serve index.html for any non-API route
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: "Not Found" });
    } else {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(path.join(frontendDist, "index.html"));
    }
  });

  return { app, pluginManager, dataFetcher, strategyEngine, userStore, agentManager, toolRegistry, scheduler, watchEngine };
}

async function main() {
  const PORT = process.env.PORT || 3001;
  const { app, pluginManager, toolRegistry } = await createApp();

  // ===== Start server =====
  app.listen(PORT, () => {
    console.log(`\n🚀 SClaw running at http://localhost:${PORT}`);
    console.log(`📊 Plugins loaded: ${pluginManager.getAll().length}`);
    console.log(`🔧 Tools registered: ${toolRegistry.getAll().length}`);
    console.log(`⚡ Hot-reload watching: enabled\n`);
  });
}

// Only run main() when this file is executed directly
if (require.main === module) {
  main().catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

export default createApp;
