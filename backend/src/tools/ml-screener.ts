/**
 * ML Screener Tool — 基于87因子ML模型的AI选股工具 (v12)
 *
 * v20260816 修复: execSync 同步阻塞 → 异步 exec + 结果缓存 + 并发锁
 *  - 不再阻塞 Node 事件循环(原 3-4 分钟全服务假死)
 *  - 缓存: 6 小时内重复调用秒回(日频特征,结果不变)
 *  - 并发锁: 同一时刻只跑一个 ML 进程,后续请求等待复用结果
 */
import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { exec } from "child_process";
import * as fs from "fs";
import { getCurrentUserId } from "../request-context";
import { pushUserAction } from "./frontend-actions";

const ML_SCRIPT = "/root/sclaw/ml_screener/fetch_screen_v12.py";
const CACHE_FILE = "/root/sclaw/ml_screener/ml_results_cache.json";
const CACHE_TTL_MS = 6 * 3600 * 1000; // 6 小时
const EXEC_TIMEOUT_MS = 360000; // 6 分钟 (脚本全市场约 3-4 分钟)

let runningPromise: Promise<string> | null = null; // 并发锁

interface MLCache { date: string; generated_at: number; results: any[]; }

function loadCache(): MLCache | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as MLCache;
      if (c && c.generated_at && Array.isArray(c.results) &&
          (Date.now() - c.generated_at) < CACHE_TTL_MS) {
        return c;
      }
    }
  } catch { /* 缓存损坏则忽略 */ }
  return null;
}

function saveCache(date: string, results: any[]): void {
  try {
    const c: MLCache = { date, generated_at: Date.now(), results };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch { /* 缓存写失败不致命 */ }
}

function runMLScript(effLimit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = `python3 ${ML_SCRIPT} ${effLimit}`;
    console.log(`[ML Screener] running: ${cmd}`);
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      });
  });
}

function formatResults(date: string, results: any[], minScore: number): string {
  const filtered = minScore > 0 ? results.filter((r: any) => (r.score ?? 0) >= minScore) : results;
  const top = filtered.slice(0, 5);

  let res = `## ML因子选股结果 (v12, 共${results.length}只, ${date})\n\n`;
  if (top.length > 0) {
    res += `| 排名 | 代码 | 名称 | 评分 | 涨跌幅 | 换手率 |\n`;
    res += `| --- | --- | --- | --- | --- | --- |\n`;
    for (const r of top) {
      const chg = r.change_percent != null
        ? `${r.change_percent > 0 ? "+" : ""}${r.change_percent.toFixed(2)}%`
        : "N/A";
      res += `| ${r.rank} | ${r.code} | ${r.name} | ${r.score} | ${chg} | ${r.turnover_rate ?? "-"} |\n`;
    }
    if (filtered.length > 5) {
      res += `\n... 还有 ${filtered.length - 5} 只股票未显示\n`;
    }
  } else {
    res += `没有评分大于 ${minScore} 的股票。\n`;
  }
  res += `\n**评分说明**: 基于v12深度ML模型(87核心特征/8集成) 全市场打分，评分范围0-100，已过滤ST/退市/仙股/停牌。`;
  return res;
}

/**
 * 推送 ML 结果到当前用户的前端列表 (ml_screen 事件)
 * - 与 run_screen 的 action 格式对齐，前端新增 ml_screen case 直接 setResults + setTab('results')
 * - 不弹 ResultsModal（避免全屏遮罩打断），仅中间列表展示 + 可点击股票进入缠论
 */
function pushMlResultsToFrontend(results: any[], date: string): void {
  try {
    const userId = getCurrentUserId();
    if (!userId) return;
    const fr = (results || []).map((r: any) => ({
      code: r.code ?? "",
      name: r.name ?? r.code ?? "",
      score: Math.round((r.score ?? 0) * 10) / 10,
      signals: [`ML v12`, ...(r.rank ? [`#${r.rank}`] : [])],
      metrics: {
        changePercent: r.change_percent ?? 0,
        turnoverRate: r.turnover_rate ?? 0,
        price: r.price ?? 0,
      },
    }));
    pushUserAction(userId, "ml_screen", {
      strategies: [{ pluginId: "ml-screener", strategyId: "ml-v12", strategyName: "ML因子选股 v12" }],
      results: fr,
      stats: {
        totalStocks: (results || []).length,
        matchedStocks: (results || []).length,
        executionTime: 0,
        date,
      },
    });
    console.log(`[ML Screener] pushed ml_screen action to user ${userId}: ${fr.length} stocks`);
  } catch (e: any) {
    console.log(`[ML Screener] pushUserAction failed: ${e.message}`);
  }
}

const mlScreenerHandler = async (args: Record<string, unknown>): Promise<string> => {
  const limit = (args.limit as number) || 100;
  const minScore = (args.min_score as number) || 0;
  const quick = args.quick === true;

  // 1) 缓存命中 → 秒回(不跑脚本)
  const cache = loadCache();
  if (cache) {
    console.log(`[ML Screener] cache hit: ${cache.date}, ${cache.results.length} stocks`);
    pushMlResultsToFrontend(cache.results, cache.date);
    return formatResults(cache.date, cache.results, minScore);
  }

  // 2) 并发锁: 已有 ML 进程在跑 → 等待其完成
  if (runningPromise) {
    console.log("[ML Screener] waiting for in-flight ML run...");
    try {
      const stdout = await runningPromise;
      const data = JSON.parse(stdout);
      pushMlResultsToFrontend(data.results, data.date);
      return formatResults(data.date, data.results, minScore);
    } catch (e: any) {
      return `ML Screener error: ${e.stderr?.slice(0, 200) || e.message}`;
    }
  }

  // 3) 无缓存无并发 → 启动异步 ML 进程
  const effLimit = quick ? 20 : limit;
  runningPromise = runMLScript(effLimit).then((stdout) => {
    try {
      const data = JSON.parse(stdout);
      if (data && Array.isArray(data.results)) {
        saveCache(data.date, data.results);
      }
      return stdout;
    } catch {
      return stdout;
    }
  }).finally(() => { runningPromise = null; });

  try {
    const stdout = await runningPromise;
    const data = JSON.parse(stdout);
    pushMlResultsToFrontend(data.results, data.date);
    return formatResults(data.date, data.results, minScore);
  } catch (e: any) {
    if (e.stdout) {
      try {
        const data = JSON.parse(e.stdout);
        let res = `## ML因子选股结果 (v12, 共${data.count ?? 0}只)\n\n`;
        for (const r of (data.results || []).slice(0, 10)) {
          res += `- #${r.rank} ${r.code} ${r.name} 评分:${r.score} 涨跌:${r.change_percent?.toFixed(2) || "0"}%\n`;
        }
        return res;
      } catch {}
    }
    return `ML Screener error: ${e.stderr?.slice(0, 200) || e.message}`;
  }
};

const params: ToolParamDef[] = [
  { name: "limit", type: "number", description: "分析股票数量 (默认: 100)", required: false },
  { name: "min_score", type: "number", description: "最低评分阈值 0-100 (默认: 0)", required: false },
  { name: "quick", type: "boolean", description: "快速模式 - 仅分析20只", required: false },
];

export const mlScreenerTool = new Tool(
  "ml_screener",
  `ML因子选股工具 - 基于v12深度ML模型(87核心特征/8模型集成) 全市场打分的A股智能筛选

使用经过训练的ML因子模型（v12-mlp-87）对A股进行评分，全市场打分后取top N，内置ST/退市/仙股/停牌过滤，输出排名、评分和信号。

模型特征：87核心特征 | 8模型集成 | hids=[64] | 数据2009-2026(664万样本) | IC 0.133 | 含换手率/估值/龙虎榜/筹码因子

使用示例：
  ml_screener(limit=100) - 分析100只股票
  ml_screener(quick=true) - 快速分析20只
  ml_screener(limit=200, min_score=30) - 分析200只，只显示30分以上`,
  params,
  mlScreenerHandler,
);

export function registerMlScreenerTool(registry: ToolRegistry): void {
  registry.register(mlScreenerTool);
}
