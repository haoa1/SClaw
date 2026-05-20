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

// Chat (for saving AI analysis results)
import { saveMessages, loadMessages } from "./routes/chat";

// LLM client (for silent agent analysis)
import { LLMClient } from "./agent/llm";

// Register all tools
import { registerFileTools } from "./tools/file-tools";
import { registerStockTools } from "./tools/stock-info";
import { registerStrategyTools } from "./tools/strategy-validator";
import { registerRiskTools } from "./tools/risk-assessment";
import { registerStrategyGeneratorTools } from "./tools/strategy-generator";
import { registerOptimizeTools } from "./tools/strategy-optimize";
import { registerFrontendTools } from "./tools/frontend-actions";
import { registerMemoryTools } from "./tools/memory-recall";
import { registerScheduleTools } from "./tools/schedule-tools";

// System prompt for AI agent
const SYSTEM_PROMPT = `你是股海操盘手，帮助用户管理股票筛选策略并分析市场数据。

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

记忆工具：
- memory_recall(query, limit) — 搜索你的记忆，查看过往的观察、决策、结果和错误

定时任务工具：
- manage_schedule(action, ...) — 管理定时选股任务。action=create/list/delete/toggle/run/result
  - create: 创建定时任务 (cronExpr, email, strategies, aiMode?)
    - aiMode参数: email(默认,纯邮件)/agent(AI分析存聊天)/both(邮件+AI分析)
  - list: 列出所有任务
  - delete: 删除任务 (taskId)
  - toggle: 启用/停用 (taskId, enabled)
  - run: 立即执行 (taskId)
  - result: 查看最近一次执行结果 (taskId)

⚠️ 重要规则：
1. 执行选股时只能用 run_screen 工具
2. run_screen 会同时返回数据给你分析并推送到前端界面
3. 步骤：list_strategies查策略 → run_screen执行`;

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
  const pluginsDir = options?.pluginsDir || path.resolve(__dirname, "../../plugins");
  const dataDir = options?.dataDir || path.resolve(process.cwd(), "data");

  const pluginManager = new PluginManager(pluginsDir);
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

  // ===== Initialize tool registry =====
  const toolRegistry = new ToolRegistry();
  registerFileTools(toolRegistry);
  registerStockTools(toolRegistry);
  registerStrategyTools(toolRegistry);
  registerRiskTools(toolRegistry);
  registerStrategyGeneratorTools(toolRegistry);
  registerOptimizeTools(toolRegistry);
  registerFrontendTools(toolRegistry);
  registerMemoryTools(toolRegistry);
  registerScheduleTools(toolRegistry, scheduler, pluginManager, () => {
    // Lazy: get current userId from per-request context
    const { getCurrentUserId } = require("./request-context");
    return getCurrentUserId();
  });

  // ===== Initialize agent manager =====
  const agentManager = new PerUserAgentManager(toolRegistry, dataDir);
  // Override system prompt
  (agentManager as any).systemPrompt = SYSTEM_PROMPT;

  // Wire scheduler to push notifications to agent manager
  scheduler.pushNotification = (userId, notification) => {
    agentManager.pushNotification(userId, notification);
  };

  // Wire scheduler to run AI analysis on screening results (aiMode=agent/both)
  scheduler.analyzeWithAgent = async (userId, taskLabel, strategyNames, topResults) => {
    try {
      const analysisPrompt = `Below are the results of a scheduled stock screening task "${taskLabel}" using strategies: ${strategyNames.join(', ')}.

Top ${topResults.length} results:
${topResults.map((r, i) => `${i + 1}. ${r.code} ${r.name} — Score: ${r.score.toFixed(2)}`).join('\n')}

Please provide a brief analysis (in Chinese) including:
1. Overall assessment of the screening results
2. Notable stocks worth attention
3. Any patterns or insights

Keep it concise — 3-5 sentences.`;

      const llm = new LLMClient();
      const response = await llm.chat([
        { role: 'system', content: '你是一位专业的股票分析师。请简洁地分析选股结果。' },
        { role: 'user', content: analysisPrompt },
      ], [], 'deepseek-chat');

      const analysis = response.content || '分析失败';

      // Save to chat history as a system notification message
      const history = loadMessages(userId);
      history.push({
        role: 'user',
        content: `📊 [定时选股报告] "${taskLabel}" 已完成\n策略: ${strategyNames.join(', ')}\n结果: ${topResults.length} 只股票`,
      });
      history.push({
        role: 'assistant',
        content: analysis,
      });
      saveMessages(userId, history);

      console.log(`[Scheduler] AI analysis saved to chat for user ${userId}`);
      return analysis;
    } catch (err) {
      console.error('[Scheduler] AI analysis error:', err);
      return '';
    }
  };

  await scheduler.initialize();

  // ===== Register routes =====
  // API routes (plugins, strategies, screen, data, health, kline)
  const apiRoutes = createRoutes(pluginManager, strategyEngine, dataFetcher);
  app.use(apiRoutes);

  // Auth routes (login, logout, me)
  const authRoutes = createAuthRoutes();
  app.use(authRoutes);

  // Chat routes (POST /api/chat SSE, GET/POST /api/messages)
  const chatRoutes = createChatRoutes(agentManager);
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
  app.use(express.static(frontendDist));
  // SPA fallback: serve index.html for any non-API route
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: "Not Found" });
    } else {
      res.sendFile(path.join(frontendDist, "index.html"));
    }
  });

  return { app, pluginManager, dataFetcher, strategyEngine, userStore, agentManager, toolRegistry, scheduler };
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
