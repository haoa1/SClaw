/**
 * Unified Stock Tool — stock(search|detail|overview|history)
 *
 * Replaces: search_stocks, get_stock_detail, market_overview, fetch_historical_kline
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { getStocks } from "./stock-info";
import { TushareHistoricalDataFetcher } from "../data/tushare-historical";
import { HistoricalDataFetcher } from "../data/eastmoney-historical";

const tushareFetcher = new TushareHistoricalDataFetcher();
const eastMoneyFetcher = new HistoricalDataFetcher();

// ===== Historical K-line fetch (moved from historical-data.ts) =====

const fetchKLineFn = async (args: Record<string, unknown>): Promise<string> => {
  const code = (args.code as string || "").trim();
  if (!code) return "❌ Error: code is required";

  let market: 'SH' | 'SZ' | 'BJ';
  if (args.market) {
    const m = (args.market as string).toUpperCase();
    if (!['SH', 'SZ', 'BJ'].includes(m)) return "❌ Error: market must be 'SH', 'SZ', or 'BJ'";
    market = m as 'SH' | 'SZ' | 'BJ';
  } else {
    if (code.startsWith('6') || code.startsWith('9')) market = 'SH';
    else if (code.startsWith('8')) market = 'BJ';
    else market = 'SZ';
  }

  const days = Math.min(Math.max(1, (args.days as number) || 120), 1000);
  const format = (args.format as string || 'table').toLowerCase();

  try {
    // Try Tushare first, fallback to East Money
    let data = await tushareFetcher.fetchDailyKLine(code, market, days);
    if (!data || data.length === 0) {
      console.log(`[StockTool] Tushare empty for ${code}, trying East Money fallback...`);
      data = await eastMoneyFetcher.fetchDailyKLine(code, market, days);
    }
    if (!data || data.length === 0) return `ℹ️ No historical data found for ${code} (${market})`;

    if (format === 'json') return JSON.stringify({ code, market, days: data.length, data });
    if (format === 'compact') {
      const lines = data.map(d =>
        `${d.date} O:${d.open.toFixed(2)} H:${d.high.toFixed(2)} L:${d.low.toFixed(2)} C:${d.close.toFixed(2)} V:${d.volume}`
      );
      return `📊 ${code} (${market}) — ${data.length} trading days\n\n${lines.join('\n')}`;
    }

    // Default: table format
    const header = `${'日期'.padEnd(12)} ${'开盘'.padEnd(8)} ${'收盘'.padEnd(8)} ${'最高'.padEnd(8)} ${'最低'.padEnd(8)} ${'涨跌幅'.padEnd(8)} ${'成交量'.padEnd(12)} ${'成交额'.padEnd(12)} ${'换手率'.padEnd(8)}`;
    const sep = '─'.repeat(12) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(11) + ' ─' + '─'.repeat(11) + ' ─' + '─'.repeat(7);
    const lines = data.slice(-60).map((d: any) => {
      const changeStr = d.changePct >= 0 ? `+${d.changePct.toFixed(2)}%` : `${d.changePct.toFixed(2)}%`;
      return `${d.date.padEnd(12)} ${d.open.toFixed(2).padEnd(8)} ${d.close.toFixed(2).padEnd(8)} ${d.high.toFixed(2).padEnd(8)} ${d.low.toFixed(2).padEnd(8)} ${changeStr.padEnd(8)} ${d.volume.toLocaleString().padEnd(12)} ${(d.amount / 1e4).toFixed(0).padEnd(11)}万 ${d.turnoverRate.toFixed(2).padEnd(7)}%`;
    });
    const closes = data.map((d: any) => d.close);
    const maxClose = Math.max(...closes);
    const minClose = Math.min(...closes);
    const avgClose = closes.reduce((a: number, b: number) => a + b, 0) / closes.length;
    const totalVolume = data.reduce((s: number, d: any) => s + d.volume, 0);
    const upDays = data.filter((d: any) => d.changePct > 0).length;
    const downDays = data.filter((d: any) => d.changePct < 0).length;
    const latest = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : null;
    const latestChange = prev ? ((latest.close - prev.close) / prev.close * 100).toFixed(2) : 'N/A';

    return [
      `📊 ${code} (${market}) — 最近 ${data.length} 个交易日`,
      `   最新: ${latest.close.toFixed(2)} (${latestChange}%) | 最高: ${maxClose.toFixed(2)} | 最低: ${minClose.toFixed(2)} | 均价: ${avgClose.toFixed(2)}`,
      `   区间涨幅: ${((closes[closes.length - 1] - closes[0]) / closes[0] * 100).toFixed(2)}% | 上涨: ${upDays}天 | 下跌: ${downDays}天 | 总成交量: ${(totalVolume / 1e8).toFixed(2)}亿`,
      ``,
      header, sep, ...lines,
      data.length > 60 ? `\n... 还有 ${data.length - 60} 天数据未显示（共 ${data.length} 天），设 format=compact 或 format=json 查看全部` : '',
    ].filter(Boolean).join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Error fetching historical data for ${code}: ${msg}`;
  }
};

// ===== Handler: dispatch by sub_cmd =====

const stockHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  if (!subCmd) return "❌ Error: sub_cmd is required. Options: search, detail, overview, history";

  switch (subCmd) {
    case "search": {
      const q = (args.query as string || "").toLowerCase();
      if (!q) return "❌ Error: query is required for search";
      const stocks = await getStocks();
      const results = stocks.filter((s: any) => s.code.includes(q) || s.name.includes(q))
        .slice(0, (args.limit as number) || 50);
      return JSON.stringify(results);
    }

    case "detail": {
      const code = (args.code as string || "").trim();
      if (!code) return "❌ Error: code is required for detail";
      const stocks = await getStocks();
      const found = stocks.find((s: any) => s.code === code);
      return JSON.stringify(found || { error: "Not found" });
    }

    case "overview": {
      const stocks = await getStocks();
      const up = stocks.filter((s: any) => s.changePct > 0).length;
      const down = stocks.filter((s: any) => s.changePct < 0).length;
      return JSON.stringify({
        total: stocks.length, up, down,
        flat: stocks.length - up - down,
        time: new Date().toISOString(),
      });
    }

    case "history": {
      return await fetchKLineFn(args);
    }

    default:
      return `❌ Unknown sub_cmd: "${subCmd}". Options: search, detail, overview, history`;
  }
};

// ===== Params =====

const stockParams: ToolParamDef[] = [
  {
    name: "sub_cmd",
    type: "string",
    description: `Sub-command: search / detail / overview / history

search(query, limit?) — Search stocks by code or name
detail(code) — Get detailed info for a stock
overview — Market overview (up/down counts)
history(code, days?, format?) — Fetch historical K-line data (format: table|json|compact)
`,
  },
  // search
  { name: "query", type: "string", description: "Search query (code or name) — required for sub_cmd=search", required: false },
  { name: "limit", type: "number", description: "Max results for search (default: 50)", required: false },
  // detail / history
  { name: "code", type: "string", description: "Stock code — required for sub_cmd=detail or history", required: false },
  // history only
  { name: "market", type: "string", description: "Market: SH/SZ/BJ (default: auto-detect) — for sub_cmd=history", required: false },
  { name: "days", type: "number", description: "Number of trading days (default: 120, max: 1000) — for sub_cmd=history", required: false },
  { name: "format", type: "string", description: "Output format: table|json|compact (default: table) — for sub_cmd=history", required: false },
];

// ===== Export =====

export const stockTool = new Tool(
  "stock",
  `Unified stock data tool. Use sub_cmd to choose operation.

search(query, limit?) → Search stocks by code or name
detail(code) → Get full detail for one stock
overview → Market summary (up/down counts)
history(code, days?, format?) → Fetch historical K-line data

Examples:
  stock(sub_cmd="search", query="茅台")
  stock(sub_cmd="detail", code="600519")
  stock(sub_cmd="overview")
  stock(sub_cmd="history", code="600519", days=60)
`,
  stockParams,
  stockHandler,
);

export function registerStockTool(registry: ToolRegistry): void {
  registry.register(stockTool);
}
