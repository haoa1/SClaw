/**
 * Unified Stock Tool — stock(search|detail|overview|history)
 *
 * Replaces: search_stocks, get_stock_detail, market_overview, fetch_historical_kline
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { getStocks, TencentAPIError } from "./stock-info";
import { DataFetcher, withRetry } from "../data/data-fetcher";

const fetcher = new DataFetcher();
const MAX_CACHE_AGE_S = 15; // 超过 15s 的缓存视为过旧

/** 检查缓存数据年龄，过旧或接近过期时给出提示 */
function checkStaleCache(stocks: any[]): string | null {
  if (!stocks || stocks.length === 0) return null;
  const age = stocks[0]._cacheAge;
  if (age === undefined || age === null) return null;
  if (age === 0) return null; // 全新数据
  if (age > MAX_CACHE_AGE_S) {
    return `\u26a0\ufe0f \u5f53\u524d\u6570\u636e\u662f ${age} \u79d2\u524d\u7684\u7f13\u5b58\uff0c\u53ef\u80fd\u4e0d\u662f\u6700\u65b0\u884c\u60c5\u3002\u5efa\u8bae\u51e0\u79d2\u540e\u91cd\u65b0\u83b7\u53d6\u3002`;
  }
  return `\u2139\ufe0f \u5f53\u524d\u6570\u636e\u662f ${age} \u79d2\u524d\u83b7\u53d6\u7684\uff08\u4ecd\u5728\u6709\u6548\u671f\u5185\uff09\u3002`;
}


// ===== Compute changePct from close price =====
function enrichKLineData(data: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): any[] {
  return data.map((d, i) => {
    const prevClose = i > 0 ? data[i - 1].close : d.open;
    const changePct = prevClose > 0 ? ((d.close - prevClose) / prevClose) * 100 : 0;
    return {
      ...d,
      changePct: parseFloat(changePct.toFixed(2)),
      amount: 0,          // Sina API 不提供成交额
      turnoverRate: 0,    // Sina API 不提供换手率
    };
  });
}

// ===== Historical K-line fetch (Sina API + retry, no Tushare) =====

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

  // BJ 暂不支持 K 线，退回 SH/SZ
  if (market === 'BJ') market = 'SH';

  const days = Math.min(Math.max(1, (args.days as number) || 120), 1000);
  const format = (args.format as string || 'table').toLowerCase();

  try {
    const rawResult = await withRetry(
      () => fetcher.fetchKLine(code, market as 'SH' | 'SZ', days),
      3, 1000, `History ${code}`
    );
    const rawData = rawResult.data;
    if (!rawData || rawData.length === 0) return `ℹ️ No historical data found for ${code} (${market})`;

    // Log data source feedback to console
    if (rawResult.meta.warnings.length > 0) {
      console.log(`[KLine ${code}] ${rawResult.meta.warnings.join('; ')}`);
    }

    // 用 Tencent 快照补充最新价（可选）
    // 先 enrich 计算 changePct
    const data = enrichKLineData(rawData);

    if (format === 'json') return JSON.stringify({ code, market, days: data.length, data });
    if (format === 'compact') {
      const lines = data.map(d =>
        `${d.date} O:${d.open.toFixed(2)} H:${d.high.toFixed(2)} L:${d.low.toFixed(2)} C:${d.close.toFixed(2)} V:${d.volume}`
      );
      return `📊 ${code} (${market}) — ${data.length} trading days\n\n${lines.join('\n')}`;
    }

    // Default: table format
    const header = `${'日期'.padEnd(12)} ${'开盘'.padEnd(8)} ${'收盘'.padEnd(8)} ${'最高'.padEnd(8)} ${'最低'.padEnd(8)} ${'涨跌幅'.padEnd(8)} ${'成交量'.padEnd(12)}`;
    const sep = '─'.repeat(12) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(11);
    const lines = data.slice(-60).map((d: any) => {
      const changeStr = d.changePct >= 0 ? `+${d.changePct.toFixed(2)}%` : `${d.changePct.toFixed(2)}%`;
      return `${d.date.padEnd(12)} ${d.open.toFixed(2).padEnd(8)} ${d.close.toFixed(2).padEnd(8)} ${d.high.toFixed(2).padEnd(8)} ${d.low.toFixed(2).padEnd(8)} ${changeStr.padEnd(8)} ${d.volume.toLocaleString().padEnd(12)}`;
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

  try {
    switch (subCmd) {
      case "search": {
        const q = (args.query as string || "").toLowerCase();
        if (!q) return "❌ Error: query is required for search";
        const stocks = await getStocks();
        if (!stocks || stocks.length === 0) {
          return "❌ 实时数据暂时不可用（腾讯行情API未返回数据），等几秒后重试(sub_cmd=\"overview\")即可";
        }
        const cacheWarn = checkStaleCache(stocks);
        const results = stocks.filter((s: any) => s.code.includes(q) || s.name.includes(q))
          .slice(0, (args.limit as number) || 50);
        if (results.length === 0) {
          return `⚠️ 未找到匹配 "${q}" 的股票`;
        }
        if (cacheWarn) return cacheWarn + "\n" + JSON.stringify(results);
        return JSON.stringify(results);
      }

      case "detail": {
        const code = (args.code as string || "").trim();
        if (!code) return "❌ Error: code is required for detail";
        const stocks = await getStocks();
        if (!stocks || stocks.length === 0) {
          return "❌ 实时数据暂时不可用（腾讯行情API未返回数据），等几秒后重试(sub_cmd=\"overview\")即可";
        }
        const cacheWarn = checkStaleCache(stocks);
        const found = stocks.find((s: any) => s.code === code);
        if (!found) return `⚠️ 未找到股票 ${code}，请检查代码是否正确`;
        if (cacheWarn) return cacheWarn + "\n" + JSON.stringify(found);
        return JSON.stringify(found);
      }

      case "overview": {
        const stocks = await getStocks();
        if (!stocks || stocks.length === 0) {
          return "❌ 实时数据暂时不可用（腾讯行情API未返回数据），等几秒后重试(sub_cmd=\"overview\")即可";
        }
        const cacheWarn = checkStaleCache(stocks);
        const up = stocks.filter((s: any) => s.changePct > 0).length;
        const down = stocks.filter((s: any) => s.changePct < 0).length;
        const result = JSON.stringify({
          total: stocks.length, up, down,
          flat: stocks.length - up - down,
          time: new Date().toISOString(),
        });
        if (cacheWarn) return cacheWarn + "\n" + result;
        return result;
      }

      case "history": {
        return await fetchKLineFn(args);
      }

      default:
        return `❌ Unknown sub_cmd: "${subCmd}". Options: search, detail, overview, history`;
    }
  } catch (err: unknown) {
    if (err instanceof TencentAPIError) {
      return `❌ 行情数据获取失败: ${err.message}`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ stock ${subCmd} 执行出错: ${msg}`;
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

Returned stock fields: code, name, market(SH/SZ), price, open, high, low, close, changePercent(涨跌幅%), volume(成交量手), amount(成交额), turnoverRate(换手率%), pe, pb, marketCap(总市值元), circulatingMarketCap, volumeRatio(量比), priceAboveVwap(分时在均价线上)

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
