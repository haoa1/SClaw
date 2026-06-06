/**
 * Historical data tool — fetch K-line data for analysis and backtesting.
 * Wraps Tushare TushareHistoricalDataFetcher and exposes it as an AI tool.
 * Fallback: tries Tushare first; if fails, attempts East Money.
 */

import { Tool, ToolParamDef } from "./registry";
import { TushareHistoricalDataFetcher } from "../data/tushare-historical";
import { HistoricalDataFetcher } from "../data/eastmoney-historical";

const tushareFetcher = new TushareHistoricalDataFetcher();
const eastMoneyFetcher = new HistoricalDataFetcher();

// ===== Tool: fetch_historical_kline =====

const fetchKLineParams: ToolParamDef[] = [
  { name: "code", type: "string", description: "Stock code, e.g. '600000', '000001'" },
  { name: "market", type: "string", description: "Market: 'SH', 'SZ', or 'BJ' (default: auto-detect from code prefix)", required: false },
  { name: "days", type: "number", description: "Number of trading days to fetch (default: 120, max: 1000)", required: false },
  { name: "format", type: "string", description: "Output format: 'table' (readable table), 'json' (raw JSON), 'compact' (OHLC only) — default: 'table'", required: false },
];

const fetchKLineFn = async (args: Record<string, unknown>): Promise<string> => {
  const code = (args.code as string || "").trim();
  if (!code) return "❌ Error: code is required";

  // Auto-detect market from code prefix
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
    // Try Tushare first, fallback to East Money (which may be deprecated)
    let data = await tushareFetcher.fetchDailyKLine(code, market, days);

    if (!data || data.length === 0) {
      console.log(`[HistoricalData] Tushare returned empty for ${code}, trying East Money fallback...`);
      data = await eastMoneyFetcher.fetchDailyKLine(code, market, days);
    }

    if (!data || data.length === 0) {
      return `ℹ️ No historical data found for ${code} (${market})`;
    }

    if (format === 'json') {
      return JSON.stringify({ code, market, days: data.length, data });
    }

    if (format === 'compact') {
      const lines = data.map(d =>
        `${d.date} O:${d.open.toFixed(2)} H:${d.high.toFixed(2)} L:${d.low.toFixed(2)} C:${d.close.toFixed(2)} V:${d.volume}`
      );
      return `📊 ${code} (${market}) — ${data.length} trading days\n\n${lines.join('\n')}`;
    }

    // Default: table format
    const header = `${'日期'.padEnd(12)} ${'开盘'.padEnd(8)} ${'收盘'.padEnd(8)} ${'最高'.padEnd(8)} ${'最低'.padEnd(8)} ${'涨跌幅'.padEnd(8)} ${'成交量'.padEnd(12)} ${'成交额'.padEnd(12)} ${'换手率'.padEnd(8)}`;
    const sep = '─'.repeat(12) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(7) + ' ─' + '─'.repeat(11) + ' ─' + '─'.repeat(11) + ' ─' + '─'.repeat(7);

    const lines = data.slice(-60).map(d => {  // Show last 60 days in table
      const changeStr = d.changePct >= 0 ? `+${d.changePct.toFixed(2)}%` : `${d.changePct.toFixed(2)}%`;
      return `${d.date.padEnd(12)} ${d.open.toFixed(2).padEnd(8)} ${d.close.toFixed(2).padEnd(8)} ${d.high.toFixed(2).padEnd(8)} ${d.low.toFixed(2).padEnd(8)} ${changeStr.padEnd(8)} ${d.volume.toLocaleString().padEnd(12)} ${(d.amount / 1e4).toFixed(0).padEnd(11)}万 ${d.turnoverRate.toFixed(2).padEnd(7)}%`;
    });

    // Summary statistics
    const closes = data.map(d => d.close);
    const maxClose = Math.max(...closes);
    const minClose = Math.min(...closes);
    const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
    const totalVolume = data.reduce((s, d) => s + d.volume, 0);
    const upDays = data.filter(d => d.changePct > 0).length;
    const downDays = data.filter(d => d.changePct < 0).length;

    // Latest price info
    const latest = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : null;
    const latestChange = prev ? ((latest.close - prev.close) / prev.close * 100).toFixed(2) : 'N/A';

    return [
      `📊 ${code} (${market}) — 最近 ${data.length} 个交易日`,
      `   最新: ${latest.close.toFixed(2)} (${latestChange}%) | 最高: ${maxClose.toFixed(2)} | 最低: ${minClose.toFixed(2)} | 均价: ${avgClose.toFixed(2)}`,
      `   区间涨幅: ${((closes[closes.length - 1] - closes[0]) / closes[0] * 100).toFixed(2)}% | 上涨: ${upDays}天 | 下跌: ${downDays}天 | 总成交量: ${(totalVolume / 1e8).toFixed(2)}亿`,
      ``,
      header,
      sep,
      ...lines,
      data.length > 60 ? `\n... 还有 ${data.length - 60} 天数据未显示 (共 ${data.length} 天)，设 format=compact 或 format=json 查看全部` : '',
    ].filter(Boolean).join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Error fetching historical data for ${code}: ${msg}`;
  }
};

export const fetchHistoricalKLineTool = new Tool(
  "fetch_historical_kline",
  "Fetch historical daily K-line data for a stock. Returns OHLCV data with change %, turnover rate, and summary statistics. Data source: Tushare Pro (primary) + East Money (fallback). Cached to disk for performance.",
  fetchKLineParams,
  fetchKLineFn
);
