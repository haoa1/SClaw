/**
 * Unified Stock Tool — stock(search|detail|overview|history)
 *
 * Replaces: search_stocks, get_stock_detail, market_overview, fetch_historical_kline
 * All wrapped in a single tool with sub_cmd dispatch.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";
import { getStocks, getStockByCode, TencentAPIError } from "./stock-info";
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
      amount: 0,          // Tencent API 不提供成交额
      turnoverRate: 0,    // Tencent API 不提供换手率
    };
  });
}

// ===== Historical K-line fetch (Tencent API + retry, no Tushare) =====
// Period: 240=日线, 60=60分钟, 30=30分钟, 15=15分钟, 5=5分钟

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
  const period = (args.period as number) || 240;
  const VALID_PERIODS = [240, 60, 30, 15, 5];
  if (!VALID_PERIODS.includes(period)) {
    return `❌ Error: period must be one of: ${VALID_PERIODS.join(', ')}`;
  }
  const periodLabel = period === 240 ? '日线' : period === 60 ? '60分钟' : period === 30 ? '30分钟' : period === 15 ? '15分钟' : period === 5 ? '5分钟' : `${period}分钟`;
  const format = (args.format as string || 'table').toLowerCase();

  try {
    let rawData: any[];
    let meta: any = null;
    let qualityNote = '';

    if (period === 240) {
      // 日线：走既有路径（SQLite缓存 + Tencent/Sina补充）
      const rawResult = await withRetry(
        () => fetcher.fetchKLine(code, market, days),
        3, 1000, `History ${code}`
      );
      rawData = rawResult.data;
      meta = rawResult.meta;
      if (meta) {
        const sourceNames = meta.sources.map((s: any) => `${s.source}(${s.count}条)`).join(', ');
        if (meta.warnings.length > 0) {
          qualityNote = `\n\n📋 **数据质量说明:** ${meta.warnings.join('; ')}`;
        }
        qualityNote += `\n📦 **数据来源:** ${sourceNames}`;
      }
    } else {
      // 分钟线：走 Sina API (fetchKLineByPeriod)
      const result = await withRetry(
        () => fetcher.fetchKLineByPeriod(code, market, days, period),
        3, 1000, `${periodLabel} ${code}`
      );
      rawData = result.data;
    }

    if (!rawData || rawData.length === 0) return `ℹ️ No ${periodLabel} data found for ${code} (${market})`;

    // 先 enrich 计算 changePct
    const data = enrichKLineData(rawData);

    if (format === 'json') return JSON.stringify({ code, market, period, periodLabel, days: data.length, data, meta_warnings: meta?.warnings || [], meta_sources: meta?.sources || [] });
    if (format === 'compact') {
      const lines = data.map(d =>
        `${d.date} O:${d.open.toFixed(2)} H:${d.high.toFixed(2)} L:${d.low.toFixed(2)} C:${d.close.toFixed(2)} V:${d.volume}`
      );
      return `📊 ${code} (${market}) ${periodLabel} — ${data.length} 根K线\n\n${lines.join('\n')}${qualityNote}`;
    }

    // Default: table format
    const header = `${'时间'.padEnd(12)} ${'开盘'.padEnd(8)} ${'收盘'.padEnd(8)} ${'最高'.padEnd(8)} ${'最低'.padEnd(8)} ${'涨跌幅'.padEnd(8)} ${'成交量'.padEnd(12)}`;
    const sep = '─'.repeat(12) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(11);
    const lines = data.slice(-60).map((d: any) => {
      const changeStr = d.changePct >= 0 ? `+${d.changePct.toFixed(2)}%` : `${d.changePct.toFixed(2)}%`;
      const dt = d.date.length > 10 ? d.date.slice(5, 16) : d.date; // 短格式：MM-DD HH:MM
      return `${dt.padEnd(12)} ${d.open.toFixed(2).padEnd(8)} ${d.close.toFixed(2).padEnd(8)} ${d.high.toFixed(2).padEnd(8)} ${d.low.toFixed(2).padEnd(8)} ${changeStr.padEnd(8)} ${d.volume.toLocaleString().padEnd(12)}`;
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

    const unit = period === 240 ? '天' : '根';
    return [
      `📊 ${code} (${market}) ${periodLabel} — 最近 ${data.length} ${unit}`,
      `   最新: ${latest.close.toFixed(2)} (${latestChange}%) | 最高: ${maxClose.toFixed(2)} | 最低: ${minClose.toFixed(2)} | 均价: ${avgClose.toFixed(2)}`,
      `   区间涨幅: ${((closes[closes.length - 1] - closes[0]) / closes[0] * 100).toFixed(2)}% | 上涨: ${upDays}${unit} | 下跌: ${downDays}${unit} | 总成交量: ${(totalVolume / 1e8).toFixed(2)}亿`,
      ``,
      header, sep, ...lines,
      data.length > 60 ? `\n... 还有 ${data.length - 60} ${unit}数据未显示（共 ${data.length} ${unit}），设 format=compact 或 format=json 查看全部` : '',
      qualityNote,
    ].filter(Boolean).join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Error fetching historical data for ${code}: ${msg}`;
  }
};

// ===== Handler: dispatch by sub_cmd =====

const stockHandler = async (args: Record<string, unknown>): Promise<string> => {
  const subCmd = (args.sub_cmd as string || "").toLowerCase().trim();
  if (!subCmd) return "❌ Error: sub_cmd is required. Options: search, overview, history";

  try {
    switch (subCmd) {
      case "search": {
        // 精确查：code="600519" → getStockByCode 直查 1 只
        const code = (args.code as string || "").trim();
        if (code) {
          const found = await getStockByCode(code);
          if (!found) return `⚠️ 未找到股票 ${code}，请检查代码是否正确`;
          return JSON.stringify(found);
        }
        // 模糊查：query="茅台" → getStocks 全量 .includes 匹配
        const q = (args.query as string || "").toLowerCase();
        if (!q) return "❌ Error: 请提供 code（精确查）或 query（模糊搜）";
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
        return `❌ Unknown sub_cmd: "${subCmd}". Options: search, overview, history`;
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
    description: `Sub-command: search / overview / history

search(code?) — 精确查：code="600519" → 直查 1 只实时行情
search(query, limit?) — 模糊搜：query="茅台" → 全量匹配返回数组
overview — 大盘总览（涨跌家数）
history(code, days?, period?, format?) — K 线 (format: table|json|compact)
`,
  },
  // search
  { name: "query", type: "string", description: "模糊搜索词（code/name）— 用于 search(query=)", required: false },
  { name: "limit", type: "number", description: "模糊搜索最大返回条数 (default: 50)", required: false },
  // search / history
  { name: "code", type: "string", description: "股票代码 — 用于 search(code=)精确查 或 history(code=)", required: false },
  // history only
  { name: "market", type: "string", description: "Market: SH/SZ/BJ (default: auto-detect) — for sub_cmd=history", required: false },
  { name: "days", type: "number", description: "Number of trading days (default: 120, max: 1000) — for sub_cmd=history", required: false },
  { name: "period", type: "number", description: "K线周期: 240=日线(default), 60=60分钟, 30=30分钟, 15=15分钟, 5=5分钟 — for sub_cmd=history", required: false },
  { name: "format", type: "string", description: "Output format: table|json|compact (default: table) — for sub_cmd=history", required: false },
];

// ===== Export =====

export const stockTool = new Tool(
  "stock",
  `Unified stock data tool. Use sub_cmd to choose operation.

search(code) → 精确查 1 只实时行情
search(query, limit?) → 模糊搜索（code/name）
overview → 大盘总览（涨跌家数）
history(code, days?, period?, format?) → K 线 (format: table|json|compact, period: 240=日线 60=60min 30=30min 15=15min 5=5min)

Returned stock fields: code, name, market(SH/SZ), price, open, high, low, close, changePercent(涨跌幅%), volume(成交量手), amount(成交额), turnoverRate(换手率%), pe, pb, marketCap(总市值元), circulatingMarketCap, volumeRatio(量比), priceAboveVwap(分时在均价线上)

Examples:
  stock(sub_cmd="search", code="600519")
  stock(sub_cmd="search", query="茅台")
  stock(sub_cmd="overview")
  stock(sub_cmd="history", code="600519", days=60)
  stock(sub_cmd="history", code="600519", period=30, days=200)  ← 30分钟K线
`,
  stockParams,
  stockHandler,
);

export function registerStockTool(registry: ToolRegistry): void {
  registry.register(stockTool);
}
