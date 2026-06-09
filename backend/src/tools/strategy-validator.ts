/**
 * Strategy validator — loads existing plugins and wraps execute() as Agent tools.
 * Now uses PluginManager (injected via setPluginManager()) instead of independent loader.
 * Falls back to independent loading if PluginManager is not set (for tests/backward compat).
 */

import { Tool, ToolParamDef } from "./registry";
import { getStocks } from "./stock-info";
import { HistoricalDataFetcher } from "../data/eastmoney-historical";
import * as path from "path";
import * as fs from "fs";
import { PluginManager } from "../plugin-system/plugin-manager";

// ===== PluginManager reference (wired from index.ts) =====

let pluginManagerRef: PluginManager | null = null;

export function setPluginManager(pm: PluginManager): void {
  pluginManagerRef = pm;
}

export function getPluginManager(): PluginManager | null {
  return pluginManagerRef;
}

// ===== Historical Enrichment =====

const HISTORICAL_DIR = path.resolve(__dirname, '../../data/historical');
const LIMIT_UP_THRESHOLD = 9.5; //涨停阈值（A股主板10%, 创业板/科创板20%, 用9.5作为通用阈值）

/**
 * Check if a stock has had a limit-up (涨停) in the last N trading days.
 * Uses disk-cached historical K-line data. If no cache exists, returns false.
 */
function checkLimitUpLastNDays(code: string, market: string, days: number = 20): boolean {
  const marketKey = market === 'SH' ? 'SH' : (market === 'BJ' ? 'BJ' : 'SZ');
  const cachePath = path.join(HISTORICAL_DIR, `${marketKey}_${code}.json`);
  
  if (!fs.existsSync(cachePath)) return false;
  
  try {
    const items: any[] = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const recent = items.slice(-days);
    return recent.some(item => (item.changePct ?? 0) >= LIMIT_UP_THRESHOLD);
  } catch {
    return false;
  }
}

/**
 * Enrich stock data array with historical information (limit-up detection).
 */
function enrichWithHistory(stocks: any[]): void {
  for (const stock of stocks) {
    if (stock.code) {
      (stock as any).limitUpIn20Days = checkLimitUpLastNDays(stock.code, stock.market || 'SZ', 20);
    }
  }
}

// ===== Types =====

interface StockData {
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ";
  price: number;
  changePercent: number;
  volume: number;
  turnover: number;
  open?: number;
  high?: number;
  low?: number;
  turnoverRate?: number;
  pe?: number;
  pb?: number;
  marketCap?: number;
}

interface FilterResult {
  code: string;
  name: string;
  score: number;
  signals: string[];
  metrics: Record<string, number>;
}

interface StrategyParam {
  key: string;
  label: string;
  type: string;
  default: any;
  options?: string[];
  min?: number;
  max?: number;
}

interface Strategy {
  id: string;
  name: string;
  description: string;
  category: string;
  params: StrategyParam[];
  execute: (data: StockData[], params: Record<string, any>) => FilterResult[];
}

interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  strategies: Strategy[];
}

// ===== Plugin Loader (fallback — used when PluginManager not available) =====

let loadedPlugins: Plugin[] | null = null;
let loadError: string | null = null;

function findPluginsDir(): string | null {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "plugins"),
    path.resolve(process.cwd(), "..", "plugins"),
    path.resolve(process.cwd(), "plugins"),
    path.resolve(__dirname, "..", "..", "..", "..", "plugins"),
  ];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const entries = fs.readdirSync(dir).filter((e) => {
          const fullPath = path.join(dir, e);
          return fs.statSync(fullPath).isDirectory() && 
            (fs.existsSync(path.join(fullPath, "index.ts")) || 
             fs.existsSync(path.join(fullPath, "index.js")));
        });
        if (entries.length > 0) return dir;
      }
    } catch { continue; }
  }
  return null;
}

/**
 * Fallback loader — used when PluginManager is not wired.
 * Also used by reloadPlugins() which is called from strategy-generator.
 */
function loadPlugins(): Plugin[] {
  if (loadedPlugins) return loadedPlugins;

  const pluginsDir = findPluginsDir();
  if (!pluginsDir) {
    loadError = "No plugins directory found";
    loadedPlugins = [];
    return [];
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  const plugins: Plugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsDir, entry.name);
    const indexPath = path.join(pluginDir, "index.ts");
    const indexJsPath = path.join(pluginDir, "index.js");

    let entryPath: string | null = null;
    if (fs.existsSync(indexPath)) entryPath = indexPath;
    else if (fs.existsSync(indexJsPath)) entryPath = indexJsPath;

    if (!entryPath) continue;

    try {
      delete require.cache[entryPath];
      const mod = require(entryPath);
      const plugin = mod.default || mod;

      if (!plugin || !plugin.id || !plugin.name || !Array.isArray(plugin.strategies)) {
        console.warn(`[StrategyValidator] Invalid plugin: ${entry.name}`);
        continue;
      }

      plugins.push(plugin as Plugin);
      console.log(`[StrategyValidator] Loaded: ${plugin.name} (${plugin.strategies.length} strategies)`);
    } catch (e: unknown) {
      console.warn(`[StrategyValidator] Failed to load ${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  loadedPlugins = plugins;
  return plugins;
}

/**
 * Reload plugins — uses PluginManager if available, fallback otherwise.
 */
export function reloadPlugins(): Plugin[] {
  loadedPlugins = null;
  
  if (pluginManagerRef) {
    // Use PluginManager to reload
    pluginManagerRef.reloadAll().catch(err => {
      console.error("[StrategyValidator] PluginManager reloadAll failed:", err);
    });
    // Return whatever is currently loaded
    const result: Plugin[] = pluginManagerRef.getAll() as Plugin[];
    // Also try to get common plugins for the fallback format
    return result;
  }
  
  return loadPlugins();
}

/**
 * Get plugins appropriate for the current user.
 * Uses PluginManager if available, falls back to old loader.
 */
function getPluginsForCurrentUser(): Plugin[] {
  if (pluginManagerRef) {
    try {
      const { getCurrentUserId } = require("../request-context");
      const userId = getCurrentUserId();
      if (userId) {
        // Load user plugins if not already loaded
        pluginManagerRef.loadForUser(userId).catch(() => {});
        return pluginManagerRef.getAllForUser(userId) as unknown as Plugin[];
      }
    } catch {
      // request-context might not be available
    }
    return pluginManagerRef.getAll() as unknown as Plugin[];
  }
  
  return loadPlugins();
}

// ===== Helper: format FilterResult[] into readable text =====

function formatResults(
  results: FilterResult[],
  strategyName: string,
  totalStocks: number,
  maxResults: number = 30
): string {
  if (results.length === 0) {
    return `「${strategyName}」无匹配结果（共扫描 ${totalStocks} 只股票）`;
  }

  const top = results.slice(0, maxResults);
  const lines = [
    `「${strategyName}」匹配 ${results.length}/${totalStocks} 只股票 (显示前${top.length}名)`,
    ``,
    `  ${"排名".padEnd(4)} ${"代码".padEnd(8)} ${"名称".padEnd(10)} ${"评分".padEnd(4)} ${"信号".padEnd(40)}`,
    `  ${"────".padEnd(4)} ${"────────".padEnd(8)} ${"──────────".padEnd(10)} ${"────".padEnd(4)} ${"────────────────────────────────────────".padEnd(40)}`,
  ];

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    lines.push(
      `  ${(i + 1).toString().padEnd(4)} ${r.code.padEnd(8)} ${r.name.padEnd(10)} ${r.score.toString().padEnd(4)} ${r.signals.join(", ").slice(0, 40)}`
    );
  }

  if (results.length > maxResults) {
    lines.push(`  ... 还有 ${results.length - maxResults} 只未显示`);
  }

  return lines.join("\n");
}

// ===== Tool: list_strategies =====

const listStrategiesParams: ToolParamDef[] = [
  { name: "category", type: "string", description: "Filter by category (long-term, mid-term, short-term, day-trade, etc.)", required: false },
];

const listStrategiesFn = (args: Record<string, unknown>): string => {
  const category = (args.category as string || "").toLowerCase().trim();
  const plugins = getPluginsForCurrentUser();
  
  if (plugins.length === 0) {
    const err = loadError || "Unknown error";
    return `无法加载策略：${err}`;
  }

  const lines: string[] = [];
  for (const plugin of plugins) {
    lines.push(`\n📦 ${plugin.name} v${plugin.version} — ${plugin.description}`);
    
    const strategies = category
      ? plugin.strategies.filter((s) => s.category === category)
      : plugin.strategies;

    for (const s of strategies) {
      const params = s.params
        .map((p) => `${p.key}(${p.type}, default=${p.default})`)
        .join(", ");
      lines.push(`  [${s.id}] ${s.name}`);
      lines.push(`    ${s.description}`);
      lines.push(`    类别: ${s.category} | 参数: ${params || "无"}`);
    }
  }

  return lines.join("\n");
};

export const listStrategiesTool = new Tool(
  "list_strategies",
  "List all available strategies with descriptions and parameters",
  listStrategiesParams,
  listStrategiesFn
);

// ===== Tool: run_multi_strategy =====

const multiStrategyParams: ToolParamDef[] = [
  { name: "strategies_json", type: "string", description: `JSON array of strategy configs, e.g. [{"id":"low-pe","params":{"maxPe":10}},{"id":"volume-surge","params":{}}]` },
  { name: "combine_mode", type: "string", description: "How to combine: 'score' (need multiple hits) or 'union' (all matches)", required: false, default: "score" },
  { name: "limit", type: "number", description: "Max results to show", required: false, default: 20 },
];

const multiStrategyFn = async (args: Record<string, unknown>): Promise<string> => {
  const strategiesJson = args.strategies_json as string;
  const combineMode = (args.combine_mode as string || "score").toLowerCase();
  const limit = (args.limit as number) ?? 20;

  if (!strategiesJson) return "Error: strategies_json is required";

  let strategyConfigs: Array<{ id: string; params: Record<string, any> }>;
  try {
    strategyConfigs = JSON.parse(strategiesJson);
  } catch {
    return "Error: strategies_json 格式无效";
  }
  if (!Array.isArray(strategyConfigs) || strategyConfigs.length === 0) {
    return "Error: strategies_json 必须是包含至少一个策略的数组";
  }

  // Load plugins for current user
  const plugins = getPluginsForCurrentUser();
  if (plugins.length === 0) return `无法加载策略：${loadError || "未找到插件"}`;

  // Resolve strategies
  const resolved: Array<{ plugin: Plugin; strategy: Strategy; params: Record<string, any> }> = [];
  for (const cfg of strategyConfigs) {
    let found = false;
    for (const plugin of plugins) {
      const s = plugin.strategies.find((st) => st.id === cfg.id);
      if (s) {
        const params: Record<string, any> = { ...cfg.params };
        for (const p of s.params) {
          if (params[p.key] === undefined) params[p.key] = p.default;
        }
        resolved.push({ plugin, strategy: s, params });
        found = true;
        break;
      }
    }
    if (!found) return `未找到策略: ${cfg.id}`;
  }

  // Get stock data
  try {
    const stocks = await getStocks();
    const totalStocks = stocks.length;

    // Enrich with historical data (limit-up detection, etc.)
    enrichWithHistory(stocks);

    // Run all strategies in parallel (they're pure functions)
    const allResults = resolved.map(({ strategy, params }) => ({
      name: strategy.name,
      results: strategy.execute(stocks, params),
    }));

    // Combine
    if (resolved.length === 1 || combineMode === "union") {
      // Union: flatten all results
      const combined = allResults.flatMap(
        (r) => r.results.map((item) => ({ ...item, strategyName: r.name }))
      );
      const sorted = combined.sort((a, b) => b.score - a.score);
      const top = sorted.slice(0, limit);

      const lines = [
        `多策略筛选结果 (${resolved.length}个策略, union模式)`,
        `扫描 ${totalStocks} 只股票, 共 ${sorted.length} 次命中`,
        ``,
        ...top.map((r, i) => 
          `  ${i + 1}. ${r.code} ${r.name} | 评分${r.score} | ${r.strategyName} | ${r.signals.join(", ")}`
        ),
      ];
      if (sorted.length > limit) lines.push(`  ... 还有 ${sorted.length - limit} 条未显示`);
      return lines.join("\n");
    } else {
      // Score mode: aggregate by stock code
      const aggregated = new Map<string, {
        name: string;
        hits: Array<{ strategyName: string; score: number; signals: string[] }>;
      }>();

      for (const { name, results } of allResults) {
        for (const r of results) {
          const key = r.code;
          if (!aggregated.has(key)) {
            aggregated.set(key, { name: r.name, hits: [] });
          }
          aggregated.get(key)!.hits.push({
            strategyName: name,
            score: r.score,
            signals: r.signals,
          });
        }
      }

      // Filter: need at least 1 hit per strategy for meaningful results
      const minHits = Math.min(resolved.length, Math.max(2, Math.round(resolved.length * 0.4)));
      const scored = Array.from(aggregated.entries())
        .filter(([_, v]) => v.hits.length >= minHits)
        .map(([code, v]) => {
          const avgScore = Math.round(v.hits.reduce((s, h) => s + h.score, 0) / v.hits.length);
          const hitStr = v.hits.map((h) => h.strategyName).join(", ");
          const signalStr = v.hits.flatMap((h) => h.signals).slice(0, 3).join("; ");
          return { code, name: v.name, score: avgScore, hitStr, signalStr, hitCount: v.hits.length };
        })
        .sort((a, b) => b.score - a.score);

      const top = scored.slice(0, limit);
      const lines = [
        `多策略交叉验证 (${resolved.length}个策略, score模式, 要求命中≥${minHits}个策略)`,
        `扫描 ${totalStocks} 只股票, ${scored.length} 只满足条件`,
        ``,
        `  ${"排名".padEnd(4)} ${"代码".padEnd(8)} ${"名称".padEnd(10)} ${"评分".padEnd(4)} ${"命中".padEnd(4)} 策略`,
        `  ${"────".padEnd(4)} ${"────────".padEnd(8)} ${"──────────".padEnd(10)} ${"────".padEnd(4)} ${"────".padEnd(4)} ${"──────────────────────────────".padEnd(30)}`,
        ...top.map((r, i) =>
          `  ${(i + 1).toString().padEnd(4)} ${r.code.padEnd(8)} ${r.name.padEnd(10)} ${r.score.toString().padEnd(4)} ${r.hitCount.toString().padEnd(4)} ${r.hitStr.slice(0, 30)}`
        ),
      ];
      if (scored.length > limit) lines.push(`  ... 还有 ${scored.length - limit} 只未显示`);
      return lines.join("\n");
    }
  } catch (e: unknown) {
    return `执行策略出错: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const multiStrategyTool = new Tool(
  "run_multi_strategy",
  "Run multiple strategies simultaneously and combine results (score or union mode)",
  multiStrategyParams,
  multiStrategyFn
);
