/**
 * Stock Indicators Tool — stock_indicators(code, period?)
 *
 * Fetches K-line for a single stock and returns pre-computed technical
 * indicators: MACD, 缠论(Pivot/Divergence/Zhongshu), 筹码分析, MAs, etc.
 *
 * Agent uses this to analyze ANY stock without going through screening.
 * Supports intraday periods: 240(日线), 60, 30, 15, 5.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { computeMetrics, KLinePoint } from "./deep-analysis";

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

async function handler(args: Record<string, unknown>): Promise<string> {
  const code = (args.code as string || "").trim();
  if (!code) return JSON.stringify({ error: "Missing required parameter: code" });

  const period = parseInt(args.period as string) || 240;
  const VALID_PERIODS = [240, 60, 30, 15, 5];
  if (!VALID_PERIODS.includes(period)) {
    return JSON.stringify({ error: `Invalid period. Must be one of: ${VALID_PERIODS.join(", ")}` });
  }

  const periodLabel = period === 240 ? "日线"
    : period === 60 ? "60分钟"
    : period === 30 ? "30分钟"
    : period === 15 ? "15分钟"
    : period === 5 ? "5分钟"
    : `${period}分钟`;

  try {
    // Fetch K-line data from local API
    const klineResp = await httpGet(`/api/stock/${code}/kline?period=${period}&days=120`);
    const klineData: KLinePoint[] = (klineResp?.data || []).map((d: any) => ({
      date: d.date || d.datetime || "",
      open: d.open || 0,
      high: d.high || 0,
      low: d.low || 0,
      close: d.close || 0,
      volume: d.volume || 0,
      changePct: d.changePct,
      turnoverRate: d.turnoverRate,
    }));

    if (klineData.length === 0) {
      return JSON.stringify({ error: `No K-line data for ${code}`, code, period, periodLabel });
    }

    const metrics = computeMetrics(klineData);

    const result = {
      code,
      market: klineResp?.market || "",
      period,
      periodLabel,
      klineCount: klineData.length,
      latestKline: klineData[klineData.length - 1],
      indicators: metrics,
    };

    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return JSON.stringify({ error: `Failed to fetch indicators: ${err.message}`, code, period });
  }
}

const params: ToolParamDef[] = [
  {
    name: "code", type: "string",
    description: "Stock code (e.g. 600519, 000001, 300750)",
    required: true,
  },
  {
    name: "period", type: "number",
    description: "K-line period: 240(日线), 60(60分钟), 30(30分钟), 15(15分钟), 5(5分钟). Default: 240",
    required: false,
    default: 240,
  },
];

export const stockIndicatorsTool = new Tool(
  "stock_indicators",
  `Fetch technical indicators for a single stock: MACD (dif/dea/histogram), 缠论 (pivot divergence/zhongshu), 筹码分析 (VWAP/concentration/buy-sell pressure), MAs, volatility, volume trends, and more.

Use this when the user asks about a specific stock's technical analysis, MACD, 缠论背驰, 中枢, 筹码分布, or any indicator.

Example: stock_indicators(code="600519", period=240)

Period: 240=日线(default), 60=60分钟, 30=30分钟, 15=15分钟, 5=5分钟.`,
  params, handler,
);

export function registerStockIndicatorsTool(registry: ToolRegistry): void {
  registry.register(stockIndicatorsTool);
}
