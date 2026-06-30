/**
 * Deep Analysis Tool — run_deep_analysis(strategy_id, limit?)
 *
 * One-shot tool that:
 * 1. Runs screening via POST /api/screen
 * 2. Fetches K-line data via GET /api/stock/:code/kline
 * 3. Returns structured JSON with pre-computed technical metrics
 *
 * The agent analyzes the returned data for 缠论/筹码 signals.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";

async function httpPost(path: string, body: object): Promise<any> {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port: 3001, path, method: "POST",
        headers: { "Content-Type": "application/json" } },
      (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function httpGet(path: string): Promise<any> {
  const http = require("http");
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3001${path}`, (res: any) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on("error", reject);
  });
}

interface KLinePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  changePct?: number;
  turnoverRate?: number;
}

function computeMetrics(klineData: KLinePoint[]): Record<string, unknown> {
  const closes = klineData.map(d => d.close).filter(c => c > 0);
  const volumes = klineData.map(d => d.volume).filter(v => v > 0);
  const highs = klineData.map(d => d.high).filter(h => h > 0);
  const lows = klineData.map(d => d.low).filter(l => l > 0);
  const opens = klineData.map(d => d.open).filter(o => o > 0);

  if (closes.length === 0) return {};

  const latestClose = closes[closes.length - 1];
  const avgVolume = volumes.length > 0
    ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const latestVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;

  const ma = (n: number) =>
    closes.length >= n
      ? closes.slice(-n).reduce((a, b) => a + b, 0) / n
      : latestClose;

  const ma5 = ma(5);
  const ma20 = ma(20);
  const ma60 = ma(60);

  // Price range
  const maxClose = Math.max(...closes);
  const minClose = Math.min(...closes);
  const priceRange = maxClose - minClose;

  // Position within range (0 = at bottom, 1 = at top)
  const rangePosition = priceRange > 0 ? (latestClose - minClose) / priceRange : 0.5;

  // Volatility (standard deviation of returns)
  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance);

  // Volume trend: compare recent 5-day avg volume to 20-day avg
  const vol5 = volumes.length >= 5
    ? volumes.slice(-5).reduce((a, b) => a + b, 0) / 5 : avgVolume;
  const vol20 = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : avgVolume;
  const volumeTrend = vol20 > 0 ? vol5 / vol20 : 1;

  // Count up/down days
  const upDays = closes.slice(1).filter((c, i) => c > closes[i]).length;
  const downDays = closes.slice(1).filter((c, i) => c < closes[i]).length;

  // Highest high and lowest low in recent 20 days
  const recent20 = klineData.slice(-20);
  const recentHigh = Math.max(...recent20.map(d => d.high).filter(h => h > 0), latestClose);
  const recentLow = Math.min(...recent20.map(d => d.low).filter(l => l > 0), latestClose);

  // ===== 筹码分析指标 =====

  // 1. VWAP (成交量加权均价) — 市场平均成本
  let totalVolPrice = 0, totalVol = 0;
  for (const d of klineData) {
    if (d.close > 0 && d.volume > 0 && d.high > 0 && d.low > 0) {
      const typicalPrice = (d.high + d.low + d.close) / 3;
      totalVolPrice += typicalPrice * d.volume;
      totalVol += d.volume;
    }
  }
  const vwap = totalVol > 0 ? totalVolPrice / totalVol : latestClose;
  const priceToVwap = totalVol > 0 ? (latestClose / vwap - 1) * 100 : 0;

  // 2. 近10日VWAP (短期成本)
  const recentKline = klineData.slice(-10);
  let recentVolPrice = 0, recentVol = 0;
  for (const d of recentKline) {
    if (d.close > 0 && d.volume > 0) {
      recentVolPrice += ((d.high + d.low + d.close) / 3) * d.volume;
      recentVol += d.volume;
    }
  }
  const recentVwap = recentVol > 0 ? recentVolPrice / recentVol : latestClose;

  // 3. 主动买盘/卖盘比 (涨量 vs 跌量)
  let upVolume = 0, downVolume = 0, flatVolume = 0;
  for (const d of klineData) {
    if (d.close > 0 && d.open > 0 && d.volume > 0) {
      if (d.close > d.open) upVolume += d.volume;
      else if (d.close < d.open) downVolume += d.volume;
      else flatVolume += d.volume;
    }
  }
  const buySellRatio = downVolume > 0 ? upVolume / downVolume : 2;
  // 净买入占比 (0~1): >0.5 =买方主导
  const netBuyRatio = totalVol > 0 ? (upVolume - downVolume) / (upVolume + downVolume) : 0;

  // 4. 近期买盘占比 (近10日)
  let recentUpVol = 0, recentDownVol = 0;
  for (const d of recentKline) {
    if (d.close > 0 && d.open > 0 && d.volume > 0) {
      if (d.close > d.open) recentUpVol += d.volume;
      else if (d.close < d.open) recentDownVol += d.volume;
    }
  }
  const recentBuyPressure = (recentUpVol + recentDownVol) > 0
    ? recentUpVol / (recentUpVol + recentDownVol) : 0.5;

  // 5. 筹码集中度估计 (将价格区间分为10档, 看成交量分布)
  const allHighs = [...highs, latestClose];
  const allLows = [...lows, latestClose];
  const overallHigh = Math.max(...allHighs);
  const overallLow = Math.min(...allLows);
  const priceStep = overallHigh > overallLow ? (overallHigh - overallLow) / 10 : 1;

  if (priceStep > 0) {
    const zoneVolumes = new Array(10).fill(0);
    for (const d of klineData) {
      if (d.high > 0 && d.low > 0 && d.close > 0 && d.volume > 0) {
        const midPrice = d.close;
        const zoneIdx = Math.min(9, Math.floor((midPrice - overallLow) / priceStep));
        zoneVolumes[zoneIdx] += d.volume;
      }
    }
    // 赫芬达尔指数 (HHI) 衡量集中度: 0~1, 越大越集中
    const totalZoneVol = zoneVolumes.reduce((a, b) => a + b, 0);
    const concentrationHHI = totalZoneVol > 0
      ? zoneVolumes.reduce((a, b) => a + (b / totalZoneVol) ** 2, 0)
      : 0;

    // 顶部/底部成交量占比
    const top3Vol = zoneVolumes.slice(-3).reduce((a, b) => a + b, 0);
    const bot3Vol = zoneVolumes.slice(0, 3).reduce((a, b) => a + b, 0);
    const topBottomRatio = bot3Vol > 0 ? top3Vol / bot3Vol : 1;

    // 当前价格所在区间的成交量占比 (看该价位是否有密集成交)
    const currentZone = Math.min(9, Math.floor((latestClose - overallLow) / priceStep));
    const currentZoneVolRatio = totalZoneVol > 0 ? zoneVolumes[currentZone] / totalZoneVol : 0;

    // 6. 获利盘比例估计 (近20日成本 vs 当前价)
    const costBasis = recentVwap; // 短期成本
    const profitRatio = (latestClose - costBasis) / costBasis;

    // 7. 量价背离检测
    // 价创新高但量萎缩 -> 背离
    const recentVolMax = Math.max(...volumes.slice(-10));
    const priceAtRecentVolMax = closes[volumes.indexOf(recentVolMax)] || latestClose;
    const priceNewHigh = latestClose >= Math.max(...closes.slice(-10));
    const volumeShrinking = latestVolume < avgVolume * 0.7;
    const divergenceSignal = priceNewHigh && volumeShrinking ? 1 : 0;

    // 8. 底部放量 (近期最大量出现在价格低位)
    const recentVolumes = volumes.slice(-20);
    const maxVolIdx = recentVolumes.indexOf(Math.max(...recentVolumes));
    const priceAtMaxVol = closes.slice(-20)[maxVolIdx] || latestClose;
    const bottomVolumeSignal = priceAtMaxVol < ma20 ? 1 : 0;

    return {
      latestClose: Math.round(latestClose * 100) / 100,
      ma5: Math.round(ma5 * 100) / 100,
      ma20: Math.round(ma20 * 100) / 100,
      ma60: Math.round(ma60 * 100) / 100,
      aboveMa5: latestClose > ma5,
      aboveMa20: latestClose > ma20,
      aboveMa60: latestClose > ma60,
      distanceToMa5: Math.round((latestClose / ma5 - 1) * 10000) / 100,
      distanceToMa20: Math.round((latestClose / ma20 - 1) * 10000) / 100,
      avgVolume: Math.round(avgVolume),
      latestVolume: Math.round(latestVolume),
      volumeRatio: avgVolume > 0 ? Math.round((latestVolume / avgVolume) * 100) / 100 : 1,
      volumeTrend: Math.round(volumeTrend * 100) / 100,
      maxClose: Math.round(maxClose * 100) / 100,
      minClose: Math.round(minClose * 100) / 100,
      rangePosition: Math.round(rangePosition * 100) / 100,
      volatility: Math.round(volatility * 10000) / 100,
      upDays, downDays,
      recentHigh: Math.round(recentHigh * 100) / 100,
      recentLow: Math.round(recentLow * 100) / 100,
      totalDays: closes.length,

      // ===== 筹码指标 =====
      vwap: Math.round(vwap * 100) / 100,
      priceToVwap: Math.round(priceToVwap * 100) / 100,  // % 偏离
      recentVwap: Math.round(recentVwap * 100) / 100,     // 近10日成本
      profitRatio: Math.round(profitRatio * 10000) / 100, // 获利比例%
      buySellRatio: Math.round(buySellRatio * 100) / 100, // 买/卖量比
      netBuyRatio: Math.round(netBuyRatio * 10000) / 100, // 净买入% (-100~+100)
      recentBuyPressure: Math.round(recentBuyPressure * 10000) / 100, // 近10日买入占比%
      concentrationHHI: Math.round(concentrationHHI * 10000) / 100,   // 筹码集中度 0~100
      currentZoneVolRatio: Math.round(currentZoneVolRatio * 10000) / 100, // 当前价区成交量占比%
      topBottomRatio: Math.round(topBottomRatio * 100) / 100,  // 顶底成交量比
      divergenceSignal,    // 量价背离信号 0/1
      bottomVolumeSignal,  // 底部放量信号 0/1
    };
  }

  // Fallback if priceStep is 0
  return {
    latestClose: Math.round(latestClose * 100) / 100,
    ma5: Math.round(ma5 * 100) / 100,
    ma20: Math.round(ma20 * 100) / 100,
    ma60: Math.round(ma60 * 100) / 100,
    aboveMa5: latestClose > ma5,
    aboveMa20: latestClose > ma20,
    aboveMa60: latestClose > ma60,
    distanceToMa5: Math.round((latestClose / ma5 - 1) * 10000) / 100,
    distanceToMa20: Math.round((latestClose / ma20 - 1) * 10000) / 100,
    avgVolume: Math.round(avgVolume),
    latestVolume: Math.round(latestVolume),
    volumeRatio: avgVolume > 0 ? Math.round((latestVolume / avgVolume) * 100) / 100 : 1,
    volumeTrend: Math.round(volumeTrend * 100) / 100,
    maxClose: Math.round(maxClose * 100) / 100,
    minClose: Math.round(minClose * 100) / 100,
    rangePosition: Math.round(rangePosition * 100) / 100,
    volatility: Math.round(volatility * 10000) / 100,
    upDays, downDays,
    recentHigh: Math.round(recentHigh * 100) / 100,
    recentLow: Math.round(recentLow * 100) / 100,
    totalDays: closes.length,
  };
}

// ===== Handler =====

const handler = async (args: Record<string, unknown>): Promise<string> => {
  const t0 = Date.now();
  const strategyId = (args.strategy_id as string || "chan-5filters-main").trim();
  const limit = Math.min(Math.max(1, (args.limit as number) || 10), 20);
  // Allow custom params; default to relaxed settings to get enough candidates
  const userParams = (args.params as Record<string, unknown>) || {};
  const defaultParams: Record<string, unknown> = {
    minChange: 2, maxChange: 10, minVolumeRatio: 0.8,
    minTurnover: 3, maxTurnover: 15, minMcap: 30, maxMcap: 500,
  };
  const screenParams = { ...defaultParams, ...userParams };

  const timing: Record<string, number> = {};

  try {
    // Step 1: Discover pluginId
    const t1 = Date.now();
    let pluginId = "chan-5filters-screener";
    try {
      const strategiesResp = await httpGet("/api/strategies");
      const stratList = strategiesResp?.strategies || strategiesResp || [];
      if (Array.isArray(stratList)) {
        const found = stratList.find((s: any) => s.strategyId === strategyId || s.id === strategyId);
        if (found) pluginId = found.pluginId || found.plugin_id || pluginId;
      }
    } catch {
      // fallback to default
    }
    timing.discoverPlugin = Date.now() - t1;

    // Step 2: Execute screen
    const t2 = Date.now();
    const screenResult = await httpPost("/api/screen", {
      strategies: [{ pluginId, strategyId, params: screenParams }],
    });
    timing.screen = Date.now() - t2;

    const stats = screenResult.stats || {};
    const results: any[] = screenResult.results || [];
    const topResults = results.slice(0, limit);

    if (topResults.length === 0) {
      timing.total = Date.now() - t0;
      return JSON.stringify({
        strategyId, totalStocks: stats.totalStocks || 0,
        matchedStocks: stats.matchedStocks || 0, stocks: [],
        timing,
        message: "No stocks matched screening criteria.",
      });
    }

    // Step 3: Fetch K-line for each top stock (sequential)
    const t3 = Date.now();
    const stocks: any[] = [];
    const klineTiming: Record<string, number> = {};
    for (const r of topResults) {
      const code = r.code || "";
      const market = code.startsWith("6") || code.startsWith("9") ? "SH"
        : code.startsWith("8") ? "BJ" : "SZ";

      const tk = Date.now();
      try {
        const klineResp = await httpGet(`/api/stock/${code}/kline?market=${market}&days=60`);
        const klineData: KLinePoint[] = klineResp?.data || [];
        const metrics = computeMetrics(klineData);
        klineTiming[code] = Date.now() - tk;

        stocks.push({
          code, name: r.name || code, market,
          screenScore: r.score || 0,
          signals: r.signals || [],
          price: r.price || 0,
          changePercent: r.changePercent || 0,
          volumeRatio: r.volumeRatio || 0,
          turnoverRate: r.turnoverRate || 0,
          ...metrics,
        });
      } catch (err: unknown) {
        klineTiming[code] = Date.now() - tk;
        stocks.push({
          code, name: r.name || code,
          screenScore: r.score || 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    timing.klineFetch = Date.now() - t3;
    timing.total = Date.now() - t0;

    // Log timing summary
    const avgKline = timing.klineFetch / stocks.length;
    console.log(`[DeepAnalysis] ${strategyId} limit=${limit} stocks=${stocks.length} | ` +
      `discover=${timing.discoverPlugin}ms screen=${timing.screen}ms ` +
      `kline=${timing.klineFetch}ms(avg=${Math.round(avgKline)}ms) total=${timing.total}ms`);

    return JSON.stringify({
      strategyId,
      totalResults: stats.totalStocks || 0,
      matchedResults: stats.matchedStocks || 0,
      analyzedCount: stocks.length,
      timing,
      stocks,
      instruction: `Analyze each stock's data for:
1. 缠论买卖点 (Chan Theory buy/sell points) — look at recentHigh/recentLow for pivot points, volumeRatio for divergence, price position relative to MAs
2. 筹码分析 (Chip distribution) — vwap=cost basis, priceToVwap=deviation from avg cost, profitRatio=estimated profit%, buySellRatio/netBuyRatio=buying vs selling pressure, concentrationHHI=chip concentration, currentZoneVolRatio=volume density at current price, divergenceSignal=divergence alert, bottomVolumeSignal=bottom volume signal
3. Re-score each stock (0-100) based on your analysis
4. Rank and present results, use send_email to send report if user requests`,
    });
  } catch (err: unknown) {
    return JSON.stringify({
      error: `Deep analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};

// ===== Tool definition =====

const params: ToolParamDef[] = [
  {
    name: "strategy_id", type: "string",
    description: `Strategy ID. Default: "chan-5filters-main". Use screen(sub_cmd="list") to discover others.`,
    required: false,
  },
  {
    name: "limit", type: "number",
    description: "Max stocks to analyze (1-20, default: 10). Lower = faster.",
    required: false,
  },
  {
    name: "params", type: "object",
    description: `Custom screen params (e.g. {"minChange":2,"maxChange":10,"minVolumeRatio":0.8}). Defaults are relaxed to get enough candidates.`,
    required: false,
  },
];

export const deepAnalysisTool = new Tool(
  "run_deep_analysis",
  `One-shot deep stock analysis. Runs screening, fetches K-line for top stocks, returns structured data with pre-computed technical metrics (MAs, volume trends, volatility).

Use when user asks for: 深度分析, 缠论分析, 筹码分析, 5条件做T, or any comprehensive stock analysis.

After calling, analyze each stock and present: 1) 缠论买卖点 signals 2) 筹码分析 3) Re-ranked scores 4) Email with send_email if requested.

Example: run_deep_analysis(strategy_id="chan-5filters-main", limit=10)`,
  params, handler,
);

export function registerDeepAnalysisTool(registry: ToolRegistry): void {
  registry.register(deepAnalysisTool);
}
