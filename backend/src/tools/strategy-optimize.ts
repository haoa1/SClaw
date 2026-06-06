/**
 * Strategy optimizer — automatically find optimal parameters for a strategy.
 * Uses grid search over parameter ranges to find the best configuration.
 */

import { Tool, ToolParamDef } from "./registry";
import { getStocks } from "./stock-info";
import * as path from "path";
import * as fs from "fs";

// ===== Minimal type definitions =====

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

// ===== Plugin Loader (same as strategy-validator) =====

let loadedPlugins: Plugin[] | null = null;
let loadError: string | null = null;

function findPluginsDir(): string | null {
  const candidates = [
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

function loadPlugins(): Plugin[] {
  if (loadedPlugins) return loadedPlugins;
  const pluginsDir = findPluginsDir();
  if (!pluginsDir) { loadError = "No plugins directory found"; loadedPlugins = []; return []; }

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
      if (!plugin || !plugin.id || !plugin.name || !Array.isArray(plugin.strategies)) continue;
      plugins.push(plugin as Plugin);
    } catch { continue; }
  }
  loadedPlugins = plugins;
  return plugins;
}

// ===== Optimizer Core =====

interface OptConfig {
  strategyId: string;
  param: string;            // Parameter key to optimize
  min: number;              // Min value
  max: number;              // Max value
  steps: number;            // Number of steps (default 10)
  fixedParams: Record<string, any>;  // Fixed params for other values
  mode: "balance" | "maximize" | "minimize";  // Optimization goal
  targetMatchCount?: number;  // For "balance": ideal match count
}

interface OptPoint {
  value: number;
  matchCount: number;
  avgScore: number;
  totalStocks: number;
  score: number;          // Composite score for this point
}

/**
 * Score an optimization result point.
 * - "maximize": higher match count = better
 * - "minimize": lower match count = better
 * - "balance": how close to targetMatchCount
 */
function scorePoint(
  point: Omit<OptPoint, "score">,
  mode: string,
  targetMatchCount: number,
  totalStocks: number
): number {
  switch (mode) {
    case "maximize":
      return point.matchCount;  // More matches = better
    case "minimize":
      return totalStocks - point.matchCount;  // Fewer matches = better
    case "balance":
    default: {
      // Gaussian around target: 100 at target, drops off
      const diff = Math.abs(point.matchCount - targetMatchCount);
      const sigma = Math.max(10, targetMatchCount * 0.3);
      const gaussianScore = 100 * Math.exp(-(diff * diff) / (2 * sigma * sigma));
      // Bonus for higher avgScore
      const scoreBonus = point.avgScore * 0.2;
      return Math.round(gaussianScore + scoreBonus);
    }
  }
}

// ===== Tool: optimize_strategy =====

const optimizeParams: ToolParamDef[] = [
  { name: "strategy_id", type: "string", description: "Strategy ID to optimize" },
  { name: "param", type: "string", description: "Parameter key to optimize (e.g. 'maxPe', 'minChangePercent')" },
  { name: "min", type: "number", description: "Minimum value to test" },
  { name: "max", type: "number", description: "Maximum value to test" },
  { name: "steps", type: "number", description: "Number of steps in grid search", required: false, default: 10 },
  { name: "fixed_params_json", type: "string", description: "JSON of fixed params (optional)", required: false },
  { name: "mode", type: "string", description: "Goal: 'balance' (find sweet spot), 'maximize' (most matches), 'minimize' (fewest)", required: false, default: "balance" },
  { name: "target_match_count", type: "number", description: "For 'balance' mode: ideal number of matches", required: false, default: 100 },
];

const optimizeFn = async (args: Record<string, unknown>): Promise<string> => {
  const strategyId = (args.strategy_id as string || "").trim();
  const paramKey = (args.param as string || "").trim();
  const minVal = args.min as number;
  const maxVal = args.max as number;
  const steps = (args.steps as number) ?? 10;
  const fixedParamsJson = args.fixed_params_json as string | undefined;
  const mode = (args.mode as string || "balance").toLowerCase();
  const targetMatchCount = (args.target_match_count as number) ?? 100;

  // Validate required
  if (!strategyId) return "Error: strategy_id is required";
  if (!paramKey) return "Error: param is required";
  if (minVal === undefined || maxVal === undefined) return "Error: min and max are required";
  if (minVal >= maxVal) return "Error: min must be less than max";
  if (steps < 3) return "Error: steps must be at least 3";
  if (!["balance", "maximize", "minimize"].includes(mode)) {
    return "Error: mode must be 'balance', 'maximize', or 'minimize'";
  }

  // Load plugins
  const plugins = loadPlugins();
  if (plugins.length === 0) return `无法加载策略：${loadError || "未找到插件"}`;

  // Find strategy
  let foundStrategy: Strategy | null = null;
  for (const plugin of plugins) {
    const s = plugin.strategies.find((st) => st.id === strategyId);
    if (s) { foundStrategy = s; break; }
  }
  if (!foundStrategy) {
    const allIds = plugins.flatMap((p) => p.strategies.map((s) => s.id));
    return `未找到策略 "${strategyId}"。可用: ${allIds.join(", ")}`;
  }

  // Validate that param exists in the strategy
  const paramDef = foundStrategy.params.find((p) => p.key === paramKey);
  if (!paramDef) {
    const validKeys = foundStrategy.params.map((p) => p.key);
    return `策略 "${strategyId}" 没有参数 "${paramKey}"。可用参数: ${validKeys.join(", ")}`;
  }

  // Parse fixed params
  let fixedParams: Record<string, any> = {};
  if (fixedParamsJson) {
    try { fixedParams = JSON.parse(fixedParamsJson); }
    catch { return "Error: fixed_params_json 格式无效"; }
  }
  // Fill defaults for other params
  for (const p of foundStrategy.params) {
    if (p.key !== paramKey && fixedParams[p.key] === undefined) {
      fixedParams[p.key] = p.default;
    }
  }

  // Get stock data
  let stocks: StockData[];
  try { stocks = await getStocks(); }
  catch (e: unknown) {
    return `获取行情数据失败: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Grid search
  const points: OptPoint[] = [];
  const stepSize = (maxVal - minVal) / (steps - 1);

  for (let i = 0; i < steps; i++) {
    const value = Math.round((minVal + i * stepSize) * 100) / 100;
    const testParams = { ...fixedParams, [paramKey]: value };

    const results = foundStrategy.execute(stocks, testParams);
    const avgScore = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
      : 0;

    points.push({
      value,
      matchCount: results.length,
      avgScore,
      totalStocks: stocks.length,
      score: 0, // filled below
    });
  }

  // Score each point
  for (const p of points) {
    p.score = scorePoint(p, mode, targetMatchCount, stocks.length);
  }

  // Sort by score descending
  const ranked = [...points].sort((a, b) => b.score - a.score);
  const best = ranked[0];

  // Build output
  const lines: string[] = [
    `📊 参数优化: ${foundStrategy.name}`,
    `   优化参数: ${paramKey} (${paramDef.label || paramKey})`,
    `   范围: ${minVal} → ${maxVal}, ${steps}步`,
    `   模式: ${mode === "balance" ? `均衡(目标${targetMatchCount}只)` : mode === "maximize" ? "最大化匹配" : "最小化匹配"}`,
    `   扫描: ${stocks.length}只股票`,
    ``,
    `🏆 最优参数: ${paramKey} = ${best.value}`,
    `   匹配: ${best.matchCount}只 | 平均评分: ${best.avgScore} | 综合评分: ${best.score}`,
    ``,
    `📈 参数-结果曲线:`,
    `  ${"参数值".padEnd(10)} ${"匹配数".padEnd(8)} ${"平均评分".padEnd(8)} ${"综合评分".padEnd(8)} ${"趋势"}`,
    `  ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(20)}`,
  ];

  for (const p of points) {
    // Visual indicator
    const barLen = Math.round((p.matchCount / Math.max(...points.map((x) => x.matchCount), 1)) * 20);
    const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
    const isBest = p.value === best.value;
    const prefix = isBest ? "★" : " ";
    lines.push(
      `  ${prefix}${p.value.toFixed(2).padStart(8)}  ${p.matchCount.toString().padEnd(8)} ${p.avgScore.toString().padEnd(8)} ${p.score.toString().padEnd(8)} ${bar}`
    );
  }

  // Analysis
  const matchCounts = points.map((p) => p.matchCount);
  const maxMatch = Math.max(...matchCounts);
  const minMatch = Math.min(...matchCounts);
  const range = maxMatch - minMatch;

  lines.push(``);
  lines.push(`📋 分析:`);
  lines.push(`   参数范围与结果: 最低 ${minVal}→${points.find(p => p.value === minVal)?.matchCount ?? minMatch}只, 最高 ${maxVal}→${points.find(p => p.value === maxVal)?.matchCount ?? maxMatch}只`);
  lines.push(`   敏感度: ${range > 100 ? "高" : range > 30 ? "中" : "低"} (匹配数变化 ${range}只)`);

  if (mode === "balance") {
    const closest = points.reduce((prev, curr) =>
      Math.abs(curr.matchCount - targetMatchCount) < Math.abs(prev.matchCount - targetMatchCount) ? curr : prev
    );
    lines.push(`   接近目标(${targetMatchCount}只): ${paramKey}=${closest.value} → ${closest.matchCount}只`);
  }

  // Recommendations
  const top3 = ranked.slice(0, 3);
  lines.push(``);
  lines.push(`💡 推荐参数 (Top 3):`);
  for (const r of top3) {
    lines.push(`   ${paramKey}=${r.value} → ${r.matchCount}只匹配, 平均评分${r.avgScore}`);
  }

  return lines.join("\n");
};

export const optimizeStrategyTool = new Tool(
  "optimize_strategy",
  "Grid-search optimize a strategy parameter. Finds best value by testing a range.",
  optimizeParams,
  optimizeFn
);
