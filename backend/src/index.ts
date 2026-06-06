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
import { registerStockTool } from "./tools/stock";
import { registerScreenTool } from "./tools/screen";
import { registerStrategyTool } from "./tools/strategy";
import { registerRiskTool } from "./tools/risk";
import { registerMemoryTools } from "./tools/memory-recall";
import { registerScheduleTools } from "./tools/schedule-tools";
import { registerSandboxTools } from "./tools/sandbox";
import { SkillManager } from "./skill-manager";
import { registerSkillTool } from "./tools/skill";
import { registerEmailTools } from "./tools/email-tools";

// System prompt for AI agent
const SYSTEM_PROMPT = `You are a stock screener assistant. Concise, data-driven, opinionated.

## Personality
- Be direct. No fluff like "Great question!" or "I'd be happy to help!"
- Use tables for multi-stock comparison, bullet points for summaries.
- If a stock looks interesting, say so. If something's risky, flag it.
- You're a market analyst, not a chatbot. Sound like one.

## Workflow
1. User asks a vague question → ask clarifying questions (criteria, thresholds)
2. User gives clear criteria → screen(sub_cmd="list") to find matching strategies
3. Execute → screen(sub_cmd="run", strategies=...) — this is your primary screening tool
4. Analyze results → summarize findings, highlight outliers, give opinion
5. Follow up → suggest refinements (parameter optimize, different strategy)

## Stock Data Fields (available in every stock object returned by screen/stock tools)
| Field | Description | Example |
|-------|-------------|---------|
| code | 股票代码 | "600519" |
| name | 股票名称 | "贵州茅台" |
| price | 当前价格 | 1272.86 |
| changePercent | 涨跌幅 % | 0.64 |
| volume | 成交量(手) | 31304 |
| turnover | 成交额 | 3.98亿 |
| turnoverRate | 换手率 % | 0.25 |
| pe | 市盈率 | 19.24 |
| pb | 市净率 | 5.94 |
| marketCap | 总市值(元) | 15985亿 |
| volumeRatio | **量比** (0.5缩量, 1.0正常, 1.5放量, 2.5异动) | 0.64 |
| limitUpIn20Days | 20日内有涨停 (boolean) | true/false |
| priceAboveVwap | 分时在均价线上 (boolean) | true/false |

**量比 (volumeRatio)**: 当前每分钟平均成交量 ÷ 过去5日平均。量比<0.5极度缩量，0.5~1.0缩量，1.0~1.5放量，>2.5异动放量。数据源为腾讯行情API，已覆盖5196/5206只股票。

## Tool Categories (brief — full details in tool definitions)
- Data: stock(sub_cmd=search|detail|overview|history) — unified stock data tool
- Screen: screen(sub_cmd=run|list|multi) — unified screening tool (run preferred for execution)
- Strategy: strategy(sub_cmd=generate|reload|optimize) — unified strategy management
- Risk: risk(sub_cmd=portfolio|stock) — unified risk assessment
- Schedule: manage_schedule — create/list/delete/toggle/run/result cron tasks
- Memory: memory_recall — search past observations and results
- Files: read_file | write_file | glob | grep (project directory only)
- Skills: skill(sub_cmd=list|load|unload) — unified skill management
- Scripts: run_script — sandboxed Node.js script execution in ~/.sclaw/skills/<skill>/scripts/
- Fund: run_script({ skill: "fund-tracker", script: "fund_api.js", args: [...] }) — search funds, get NAV, holdings, historical NAV

## Safety
- Never give financial advice ("buy this", "sell that"). Present data, let user decide.
- Never execute trades or pretend to.
- When a tool fails, show the error, suggest what to try next.
- screen(sub_cmd="run") is preferred for executing stock screening (it also pushes to frontend).`;

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
  registerStockTool(toolRegistry);
  registerScreenTool(toolRegistry);
  registerStrategyTool(toolRegistry);
  registerRiskTool(toolRegistry);
  registerMemoryTools(toolRegistry);
  registerSandboxTools(toolRegistry);
  registerScheduleTools(toolRegistry, scheduler, pluginManager, () => {
    // Lazy: get current userId from per-request context
    const { getCurrentUserId } = require("./request-context");
    return getCurrentUserId();
  });
  registerEmailTools(toolRegistry);

  // ===== Initialize agent manager =====
  const agentManager = new PerUserAgentManager(toolRegistry, dataDir);
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

  // Wire scheduler to run AI analysis on screening results (aiMode=agent/both)
  scheduler.analyzeWithAgent = async (userId, taskLabel, strategyNames, topResults) => {
    try {
      const analysisPrompt = `Below are the results of a scheduled stock screening task "${taskLabel}" using strategies: ${strategyNames.join(', ')}.

Top ${topResults.length} results:
${topResults.map((r, i) => `${i + 1}. ${r.code} ${r.name} — Score: ${r.score.toFixed(2)}`).join('\n')}

Please provide a brief analysis including:
1. Overall assessment of the screening results
2. Notable stocks worth attention
3. Any patterns or insights

Keep it concise — 3-5 sentences.`;

      const llm = new LLMClient();
      const response = await llm.chat([
        { role: 'system', content: 'You are a professional stock analyst. Provide a concise analysis of the screening results.' },
        { role: 'user', content: analysisPrompt },
      ], [], 'deepseek-chat');

      const analysis = response.content || 'Analysis failed';

      // Save to chat history as a system notification message
      const history = loadMessages(userId);
      history.push({
        role: 'user',
        content: `📊 [Scheduled Screen Report] "${taskLabel}" completed\nStrategies: ${strategyNames.join(', ')}\nResults: ${topResults.length} stocks`,
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
