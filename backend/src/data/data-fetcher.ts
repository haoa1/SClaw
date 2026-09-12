import * as fs from 'fs';
import * as path from 'path';
import iconv from 'iconv-lite';
import { StockData, KLineData, KLineMeta } from '../types';

// ===== Local Database (direct SQLite for K-line) =====
const DB_PATH = path.resolve(__dirname, '../../data/stock_history.db');
// 前复权干净库（与回测 / 毒性排除同一口径）——读取优先，原始库仅作回退
//   clean_daily.db :: daily  (日线前复权, 1993~今)
//   clean_m30.db   :: m30    (30分钟前复权, 与 clean_daily 同日因子保证同口径)
//   clean_m60.db   :: m60    (60分钟前复权)
const CLEAN_DAILY_DB = path.resolve(__dirname, '../../data/clean_daily.db');
const CLEAN_M30_DB = path.resolve(__dirname, '../../data/clean_m30.db');
const CLEAN_M60_DB = path.resolve(__dirname, '../../data/clean_m60.db');
// 磁盘缓存已移除：用户需要实时数据，直接走网络刷新

/**
 * Tencent QQ 股票行情 API
 * 
 * 批量查询:
 *   http://qt.gtimg.cn/q=sh600000,sz000001,...
 * 
 * 返回格式: v_CODE="field1~field2~...~fieldN";
 * 
 * 字段映射（已验证）:
 *   [0]  = 交易所标识 (1=SH, 51=SZ, 不用来判断市场)
 *   [1]  = 股票名称
 *   [2]  = 股票代码
 *   [3]  = 当前价格
 *   [4]  = 昨收
 *   [5]  = 今开
 *   [6]  = 成交量(手)
 *   [31] = 涨跌额
 *   [32] = 涨跌幅 %
 *   [33] = 最高价
 *   [34] = 最低价
 *   [37] = 成交额(万元)
 *   [38] = 换手率 %
 *   [39] = 市盈率 PE
 *   [43] = 振幅 %
 *   [44] = 流通市值(亿)
 *   [45] = 总市值(亿)
 *   [46] = 市净率 PB
 *   [49] = 量比
 */

// 股票代码列表
const STOCK_LIST_FILE = path.resolve(__dirname, '../../data/stock_list.json');

// 批量查询参数
const TENCENT_BATCH_SIZE = 500;  // 每批股票数
const TENCENT_DELAY_MS = 200;    // 批间延迟

// 重试参数
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * 重试包装器：失败时重试最多 retries 次
 * 成功返回结果，全部失败则抛出最后一次错误
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY_MS,
  context?: string
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        console.warn(`[withRetry]${context ? ' [' + context + ']' : ''} 第${attempt}/${retries}次失败，${delayMs}ms后重试...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError!;
}

interface StockListItem {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
}

export class DataFetcher {
  // 个股循环缓存（最大 20 条，10s TTL）
  private quotesCache: Map<string, { data: StockSnapshot; timestamp: number }> = new Map();
  private cacheOrder: string[] = [];
  private static readonly CACHE_MAX = 20;
  private static readonly CACHE_TTL = 10_000;  // 10s

  // fetchAllStocks 请求去重（避免并发重复请求，但不缓存结果）
  private fetchAllPromise: Promise<StockData[]> | null = null;
  private stockListPromise: Promise<StockListItem[]> | null = null;

  // ===== Public API =====

  /** 获取全市场数据：每次实时从网络拉取，不做缓存 */
  async fetchAllStocks(
    markets: ('SH' | 'SZ' | 'BJ')[] | 'SH' | 'SZ' | 'BJ' = ['SH', 'SZ', 'BJ'],
  ): Promise<StockData[]> {
    // ⚠️ 容错：调用方可能传单市场字符串（如 /api/screen 的 request.market='SH'），
    // 直接透传会导致 markets.join(...) 抛 "markets.join is not a function" → 整个选股 500
    const mkts: ('SH' | 'SZ' | 'BJ')[] = typeof markets === 'string' ? [markets] : markets;
    // 请求去重：同一时间多个并发请求共享一次网络拉取
    if (this.fetchAllPromise) {
      return await this.fetchAllPromise;
    }
    this.fetchAllPromise = this.refreshFromNetwork(mkts);
    try {
      return await this.fetchAllPromise;
    } finally {
      this.fetchAllPromise = null;
    }
  }

  /**
   * 获取个股K线数据（本地SQLite + 缓存补充）
   * 返回 { data, meta } 结构，meta 包含数据来源、质量反馈和回滚告警
   */
  async fetchKLine(code: string, market: 'SH' | 'SZ' | 'BJ', days: number = 120): Promise<{
    data: KLineData[];
    meta: KLineMeta;
  }> {
    const warnings: string[] = [];
    const sources: KLineMeta['sources'] = [];
    let allData: KLineData[] = [];
    let usedFallback = false;

    const endDate = new Date();
    const todayStr = endDate.toISOString().slice(0, 10);

    try {
      // Step 1: Query historical K-line from local SQLite database
      const dbDays = days + 20;
      const startDate = new Date(endDate.getTime() - dbDays * 24 * 60 * 60 * 1000);
      const startStr = startDate.toISOString().slice(0, 10);

      const { rows: dbRows, source: localSrc } = this.queryLocalKLine(code, startStr, todayStr);
      allData = dbRows.map(r => ({
        date: r.date, open: r.open, close: r.close,
        high: r.high, low: r.low, volume: r.volume,
      }));

      if (dbRows.length > 0) {
        sources.push({
          source: localSrc,
          count: dbRows.length,
          range: `${dbRows[0].date} to ${dbRows[dbRows.length - 1].date}`,
        });
      }

      // Step 2: If SQLite data has a gap or insufficient data, fetch from Tencent online API
      // This fills the missing periods (like 5月-6月 gap) with forward-adjusted prices
      const lastDbDate = dbRows.length > 0 ? dbRows[dbRows.length - 1].date : '';
      const needsOnline = allData.length < Math.min(days, 20) || 
        (lastDbDate && this.daysBetween(lastDbDate, todayStr) > 7);
      
      if (needsOnline) {
        const onlineDays = days + 30; // Fetch extra for coverage
        const { data: onlineData, source: onlineSource } = await this.fetchOnlineKLine(code, market, onlineDays);
        
        if (onlineData.length > 0) {
          // Track online data count (dynamic source label: tencent_online or sina_online)
          sources.push({
            source: onlineSource,
            count: onlineData.length,
            range: `${onlineData[0].date} to ${onlineData[onlineData.length - 1].date}`,
          });
          
          // 口径一致化（2026-09-12）：本地 clean_daily 已是前复权，与在线腾讯 qfq 同口径。
          // 因此改为「本地优先 + 在线只补本地缺失日期」，避免在线整体覆盖已审计的历史。
          const localDates = new Set(allData.map(d => d.date));
          const onlineOnly = onlineData.filter(d => !localDates.has(d.date));
          const nLocal = allData.length;
          allData = [...allData, ...onlineOnly];
          console.log(`[DataFetcher] fetchKLine: local ${nLocal} (${localSrc}) + online-only ${onlineOnly.length} ${onlineSource} for ${code}`);
        } else {
          console.warn(`[DataFetcher] fetchKLine: online API returned no data for ${code}`);
        }
      }

      // Step 3: Sort, deduplicate (keep last entry per date), and trim
      // Dedup: if same date has entries from multiple sources, keep the last one (online/cache > SQLite)
      const dateMap = new Map<string, KLineData>();
      // Sort first, then iterate to keep last entry per date
      allData.sort((a, b) => a.date.localeCompare(b.date));
      for (const d of allData) dateMap.set(d.date, d);
      allData = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
      allData = allData.slice(-days);

      // --- Build warnings ---

      // Check data completeness
      const hasOnlineSource = sources.some(s => s.source === 'tencent_online' || s.source === 'sina_online');
      
      if (dbRows.length > 0) {
        const lastDbDate = dbRows[dbRows.length - 1].date;
        const expectedEnd = todayStr;
        if (lastDbDate < expectedEnd) {
          if (hasOnlineSource) {
            warnings.push(`本地数据库仅包含至 ${lastDbDate} 的历史数据，已通过在线API补充${todayStr}前的缺失数据`);
          } else {
            warnings.push(`本地数据库仅包含至 ${lastDbDate} 的历史数据，缺失 ${expectedEnd} 前的最近交易日数据（已通过缓存补充）`);
          }
        }
      }

      // Check insufficient data
      if (allData.length === 0) {
        warnings.push(`没有获取到 ${code} 的任何K线数据`);
      } else if (allData.length < Math.min(days, 20)) {
        warnings.push(`数据不完整：仅 ${allData.length} 条，可能不足以计算技术指标`);
      }

      // Check for missing trading days (gap > 7 calendar days)
      // Skip if we used online source (it should have filled the gaps)
      if (!hasOnlineSource) {
        for (let i = 1; i < allData.length; i++) {
          const gapDays = this.daysBetween(allData[i - 1].date, allData[i].date);
          if (gapDays > 7) {
            warnings.push(`数据不连续：${allData[i - 1].date} 至 ${allData[i].date} 之间有 ${gapDays} 天缺口`);
          }
        }
      }

    } catch (err) {
      console.error(`[DataFetcher] Failed to fetch KLine for ${code}:`, err);
      usedFallback = true;

      warnings.push(`数据库查询异常：${err instanceof Error ? err.message : String(err)}`);
    }

    // Final warning if fallback was used
    if (usedFallback) {
      warnings.push('⚠️ 已触发降级：历史数据不可用，仅返回缓存数据');
    }

    // Build final meta
    const from = allData.length > 0 ? allData[0].date : 'N/A';
    const to = allData.length > 0 ? allData[allData.length - 1].date : 'N/A';

    return {
      data: allData,
      meta: {
        total: allData.length,
        requested_days: days,
        date_range: { from, to },
        sources,
        warnings,
      },
    };
  }

  /**
   * 从本地 SQLite 查日线（前复权优先，2026-09-12 口径统一）
   *   1) clean_daily.db :: daily        —— 前复权，与回测/毒性排除同口径（首选）
   *   2) stock_history.db :: stock_daily —— 未复权（仅当干净库无数据时回退）
   */
  private queryLocalKLine(code: string, startDate: string, endDate: string): {
    rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    source: string;
  } {
    const clean = this.querySqliteBars(CLEAN_DAILY_DB, 'daily', 'date', code, startDate, endDate);
    if (clean.length > 0) return { rows: clean, source: 'sqlite_clean_daily' };
    const raw = this.querySqliteBars(DB_PATH, 'stock_daily', 'date', code, startDate, endDate);
    if (raw.length > 0) {
      console.warn(`[DataFetcher] clean_daily 无 ${code} 数据，回退原始未复权库 stock_daily（口径不一致告警）`);
      return { rows: raw, source: 'sqlite_local_raw' };
    }
    return { rows: [], source: 'sqlite_clean_daily' };
  }

  /** 通用：从指定库/表按 [startDate, endDate] 取 OHLCV（升序） */
  private querySqliteBars(
    dbPath: string, table: string, timeCol: string,
    code: string, startDate: string, endDate: string,
  ): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
    try {
      if (!fs.existsSync(dbPath)) {
        console.warn(`[DataFetcher] DB not found: ${dbPath}`);
        return [];
      }
      // Use better-sqlite3 for sync query (it's fast for indexed queries)
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.prepare(`
          SELECT ${timeCol} AS date, open, high, low, close, volume
          FROM ${table}
          WHERE code = ? AND ${timeCol} >= ? AND ${timeCol} <= ?
          ORDER BY ${timeCol}
        `).all(code, startDate, endDate) as Array<{
          date: string; open: number; high: number; low: number; close: number; volume: number;
        }>;
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[DataFetcher] querySqliteBars error for ${code} @ ${dbPath}:${table}:`, err);
      return [];
    }
  }

  /**
   * 从在线API获取日K线数据
   * 优先使用腾讯前复权 API (支持 SH/SZ)，失败时降级到新浪 API (支持 BJ)
   * 返回 { data, source } 结构，source 标识实际使用的数据源
   */
  private async fetchOnlineKLine(code: string, market: 'SH' | 'SZ' | 'BJ', days: number): Promise<{
    data: KLineData[];
    source: string;
  }> {
    // Step 1: Try Tencent API first
    const tencentData = await this.fetchTencentFQKLine(code, market, days);
    if (tencentData.length > 1) {
      return { data: tencentData, source: 'tencent_online' }; // Only use Tencent if we got meaningful data (> 1 row)
    }
    // Step 2: Fall back to Sina API (especially for BJ stocks where Tencent has no K-line)
    if (tencentData.length <= 1) {
      const sinaData = await this.fetchSinaKLine(code, market, days);
      if (sinaData.length > 0) {
        return { data: sinaData, source: 'sina_online' };
      }
    }
    // Step 3: Return whatever Tencent gave us (might be 0 or 1 row)
    return { data: tencentData, source: 'tencent_online' };
  }

  /**
   * 腾讯 PC 端 K 线 API (前复权日K)
   */
  private async fetchTencentFQKLine(code: string, market: 'SH' | 'SZ' | 'BJ', days: number): Promise<KLineData[]> {
    try {
      const symbol = market === 'SH' ? 'sh' + code : market === 'BJ' ? 'bj' + code : 'sz' + code;
      const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const text = await res.text();
        if (!text || text.startsWith('<')) {
          console.warn(`[DataFetcher] fetchTencentFQKLine: HTML response for ${code}`);
          return [];
        }
        const j = JSON.parse(text);
        const stockData = j?.data?.[symbol] || {};
        // qfqday = 前复权日K, 优先使用; day = 未复权日K (降级)
        const dayData: any[][] = stockData.qfqday || stockData.day || [];
        if (!Array.isArray(dayData) || dayData.length === 0) return [];
        
        return dayData.map((row: any[]) => ({
          date: String(row[0]),
          open: parseFloat(row[1]) || 0,
          close: parseFloat(row[2]) || 0,
          high: parseFloat(row[3]) || 0,
          low: parseFloat(row[4]) || 0,
          volume: parseFloat(row[5]) || 0,
        })).filter(d => d.date && d.close > 0);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.warn(`[DataFetcher] fetchTencentFQKLine error for ${code}:`, err);
      return [];
    }
  }

  /**
   * 新浪财经 K 线 API (备用数据源，支持 BJ 股票)
   * https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData
   * params: symbol=bj{code}&scale=240&ma=no&datalen={days}
   * 返回格式: { day, open, high, low, close, volume } (字符串字段)
   * 注意：新浪返回的是未复权原始价格
   */
  private async fetchSinaKLine(code: string, market: 'SH' | 'SZ' | 'BJ', days: number): Promise<KLineData[]> {
    try {
      const prefix = market === 'SH' ? 'sh' : market === 'BJ' ? 'bj' : 'sz';
      const symbol = prefix + code;
      const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
      const params = new URLSearchParams({
        symbol,
        scale: '240',
        ma: 'no',
        datalen: String(Math.min(days, 1000)),
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const res = await fetch(`${url}?${params}`, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://finance.sina.com.cn',
          },
        });
        const text = await res.text();
        if (!text || text === 'null' || text.startsWith('<')) {
          console.warn(`[DataFetcher] fetchSinaKLine: invalid response for ${symbol}`);
          return [];
        }
        const rows = JSON.parse(text);
        if (!Array.isArray(rows) || rows.length === 0) return [];

        return rows.map((row: any) => ({
          date: String(row.day || '').slice(0, 10),
          open: parseFloat(row.open) || 0,
          high: parseFloat(row.high) || 0,
          low: parseFloat(row.low) || 0,
          close: parseFloat(row.close) || 0,
          volume: parseInt(row.volume, 10) || 0,
        })).filter(d => d.date && d.close > 0);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.warn(`[DataFetcher] fetchSinaKLine error for ${code}:`, err);
      return [];
    }
  }

  /**
   * 分钟线（period < 240）—— 2026-09-12 起「本地前复权优先」
   *
   * 口径统一设计：
   *   1) 历史部分取本地 clean_m30.db / clean_m60.db（前复权，与 clean_daily 同日因子）
   *   2) 本地最后一根之后的「新 bar」取新浪原始价，用重叠交易日的日末收盘价
   *      自校验出复权因子后折算（factor = 本地qfq末价 / 新浪原始末价），
   *      校验不过则丢弃在线新 bar（宁缺勿错）
   *   3) 本地库缺失时才退回新浪原始价（未复权），并打告警
   */
  async fetchKLineByPeriod(code: string, market: 'SH' | 'SZ' | 'BJ', days: number = 120, period: number = 240): Promise<{
    data: KLineData[];
    period: number;
  }> {
    if (period === 30 || period === 60) {
      const want = Math.max(days, 200);
      const local = this.queryLocalMinute(code, period as 30 | 60, want);
      const sina = await this.fetchSinaMinute(code, market, want, period);
      if (local.length === 0) {
        if (sina.length > 0) {
          console.warn(`[DataFetcher] clean_m${period} 无 ${code} 分钟数据：回退新浪未复权分钟线（口径不一致告警）`);
          return { data: sina.slice(-days), period };
        }
        return { data: [], period };
      }
      if (sina.length === 0) return { data: local.slice(-days), period };
      const f = this.impliedAdjustFactor(local, sina);
      if (f === null) {
        console.warn(`[DataFetcher] ${code} p=${period} 重叠日校验失败：仅返回本地前复权数据（丢弃在线新bar）`);
        return { data: local.slice(-days), period };
      }
      const lastLocalDay = local[local.length - 1].date.slice(0, 10);
      const fresh = sina
        .filter(d => d.date.slice(0, 10) > lastLocalDay)
        .map(d => ({ ...d, open: d.open * f, high: d.high * f, low: d.low * f, close: d.close * f }));
      if (fresh.length > 0) {
        console.log(`[DataFetcher] ${code} p=${period}: 本地前复权 ${local.length} 根 + 在线折算 ${fresh.length} 根 (factor=${f.toFixed(4)})`);
      }
      return { data: [...local, ...fresh].slice(-days), period };
    }
    const data = await this.fetchSinaMinute(code, market, days, period);
    return { data: data.slice(-days), period };
  }

  /**
   * 本地分钟线（前复权）读取：clean_m30.db::m30 / clean_m60.db::m60
   * 返回最后 limit 根，时间格式与新浪保持一致：'YYYY-MM-DD HH:MM:SS'（本地存 'YYYY-MM-DD HH:MM'）
   */
  private queryLocalMinute(code: string, period: 30 | 60, limit: number): KLineData[] {
    try {
      const dbPath = period === 30 ? CLEAN_M30_DB : CLEAN_M60_DB;
      const table = period === 30 ? 'm30' : 'm60';
      if (!fs.existsSync(dbPath)) return [];
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      let rows: Array<{ datetime: string; open: number; high: number; low: number; close: number; volume: number }> = [];
      try {
        rows = db.prepare(`
          SELECT datetime, open, high, low, close, volume
          FROM ${table}
          WHERE code = ?
          ORDER BY datetime DESC
          LIMIT ?
        `).all(code, Math.max(limit, 1)) as any;
      } finally {
        db.close();
      }
      if (!rows || rows.length === 0) return [];
      return rows.reverse().map(r => ({
        date: r.datetime.length > 16 ? r.datetime.slice(0, 19) : r.datetime + ':00',
        open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
      }));
    } catch (err) {
      console.warn(`[DataFetcher] queryLocalMinute error for ${code} p=${period}:`, err);
      return [];
    }
  }

  /**
   * 用「重叠交易日」的日末收盘价反推复权因子：factor = 本地qfq末价 / 新浪原始末价
   * 取最近若干重叠日的中位数，且要求各日比值相互一致（偏离 >1% 视为不一致 → 返回 null）
   */
  private impliedAdjustFactor(local: KLineData[], sina: KLineData[]): number | null {
    const lastPerDay = (arr: KLineData[]) => {
      const m = new Map<string, KLineData>();
      for (const d of arr) {
        const day = d.date.slice(0, 10);
        const prev = m.get(day);
        if (!prev || d.date > prev.date) m.set(day, d);
      }
      return m;
    };
    const lmap = lastPerDay(local);
    const smap = lastPerDay(sina);
    const ratios: number[] = [];
    for (const [, l] of lmap) {
      const s = smap.get(l.date.slice(0, 10));
      if (s && s.close > 0 && l.close > 0) ratios.push(l.close / s.close);
    }
    if (ratios.length === 0) return null;
    const recent = ratios.slice(-5).sort((a, b) => a - b);
    const med = recent[Math.floor(recent.length / 2)];
    const spread = (recent[recent.length - 1] - recent[0]) / (med || 1);
    if (!(med > 0.02 && med < 50) || spread > 0.01) return null;
    return med;
  }

  /** 新浪分钟线原始价（未复权）—— 由 fetchKLineByPeriod 调用（period < 240） */
  private async fetchSinaMinute(code: string, market: 'SH' | 'SZ' | 'BJ', days: number, period: number): Promise<KLineData[]> {
    try {
      const prefix = market === 'SH' ? 'sh' : market === 'BJ' ? 'bj' : 'sz';
      const symbol = prefix + code;
      const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
      const params = new URLSearchParams({
        symbol,
        scale: String(period),
        ma: 'no',
        datalen: String(Math.min(days, 1000)),
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const res = await fetch(`${url}?${params}`, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://finance.sina.com.cn',
          },
        });
        const text = await res.text();
        if (!text || text === 'null' || text.startsWith('<')) {
          console.warn(`[DataFetcher] fetchSinaMinute: invalid response for ${symbol} period=${period}`);
          return [];
        }
        const rows = JSON.parse(text);
        if (!Array.isArray(rows) || rows.length === 0) return [];

        const data = rows.map((row: any) => ({
          // 日内周期(5/15/30/60)保留时分秒，便于区分盘中各个bar；日线(240)仅保留日期
          date: (period < 240 && String(row.day || '').includes(' '))
            ? String(row.day || '').slice(0, 19)
            : String(row.day || '').slice(0, 10),
          open: parseFloat(row.open) || 0,
          high: parseFloat(row.high) || 0,
          low: parseFloat(row.low) || 0,
          close: parseFloat(row.close) || 0,
          volume: parseInt(row.volume, 10) || 0,
        })).filter(d => d.date && d.close > 0);

        return data;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.warn(`[DataFetcher] fetchSinaMinute error for ${code} period ${period}:`, err);
      return [];
    }
  }

  /**
   * 获取指数日K收盘序列（专用于大盘 regime 判定）。
   * 不能用 fetchKLine —— 它会先查 stock_daily 本地库，把指数代码(如 000001)当成同名股票(平安银行)取到错误价格。
   * 这里直接从腾讯指数K线接口拉在线数据（前缀 sh/sz 按指数代码归属市场），只取 close。
   */
  async fetchIndexKLine(code: string, market: 'SH' | 'SZ' | 'BJ', days: number = 60): Promise<{
    data: Array<{ date: string; close: number }>;
    meta: KLineMeta;
  }> {
    const warnings: string[] = [];
    const sources: KLineMeta['sources'] = [];
    const endDate = new Date();
    const todayStr = endDate.toISOString().slice(0, 10);

    try {
      const symbol = market === 'SH' ? 'sh' + code : market === 'BJ' ? 'bj' + code : 'sz' + code;
      const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${symbol},day,,,${days + 30},qfq`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const text = await res.text();
        if (!text || text.startsWith('<')) {
          warnings.push(`HTML response from Tencent for index ${symbol}`);
          return { data: [], meta: { total: 0, requested_days: days, date_range: { from: '', to: '' }, sources, warnings } };
        }
        const j = JSON.parse(text);
        const idxData = j?.data?.[symbol] || {};
        const dayData: any[][] = idxData.qfqday || idxData.day || [];
        if (!Array.isArray(dayData) || dayData.length === 0) {
          warnings.push(`No index K-line data for ${symbol}`);
          return { data: [], meta: { total: 0, requested_days: days, date_range: { from: '', to: '' }, sources, warnings } };
        }
        const data = dayData.map((row: any[]) => ({
          date: String(row[0]),
          close: parseFloat(row[2]) || 0,
        })).filter(d => d.date && d.close > 0);
        sources.push({
          source: 'tencent_index_online',
          count: data.length,
          range: `${data[0]?.date || ''} to ${data[data.length - 1]?.date || ''}`,
        });
        return {
          data,
          meta: {
            total: data.length,
            requested_days: days,
            date_range: { from: data[0]?.date || '', to: data[data.length - 1]?.date || '' },
            sources,
            warnings,
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      warnings.push(`fetchIndexKLine error for ${code}: ${err instanceof Error ? err.message : String(err)}`);
      console.warn(`[DataFetcher] fetchIndexKLine error for ${code}:`, err);
      return { data: [], meta: { total: 0, requested_days: days, date_range: { from: '', to: '' }, sources, warnings } };
    }
  }

  /**
   * 获取个股行情：使用循环 buffer 缓存（最多 20 只，10s TTL）
   * 返回结构包含 cache 字段，AI 可通过它判断数据是否来自缓存
   */
  async fetchQuotes(codes: string[], options?: { skipCache?: boolean }): Promise<{
    quotes: Record<string, StockSnapshot>;
    source: 'cache' | 'network' | 'mixed';
    cached_count: number;
    fresh_count: number;
  }> {
    const result: Record<string, StockSnapshot> = {};
    if (!codes.length) return { quotes: result, source: 'network', cached_count: 0, fresh_count: 0 };

    let cachedCount = 0;
    let freshCount = 0;

    // 1. 先查缓存
    const uncached: string[] = [];
    for (const code of codes) {
      if (options?.skipCache) {
        uncached.push(code);
        continue;
      }
      const key = this.codeToCacheKey(code);
      const cached = this.quotesCache.get(key);
      if (cached && (Date.now() - cached.timestamp) < DataFetcher.CACHE_TTL) {
        result[code] = cached.data;
        cachedCount++;
        // 移到末尾（最近使用）
        this.touchCacheKey(key);
      } else {
        uncached.push(code);
      }
    }

    // 2. 缓存未命中的从网络拉取
    if (uncached.length > 0) {
      await this.fetchQuotesFromNetwork(uncached, result);
      freshCount = uncached.length;

      // 缓存新拉取的数据
      for (const code of uncached) {
        if (result[code]) {
          this.setQuoteCache(code, result[code]);
        }
      }
    }

    const source = cachedCount > 0 && freshCount > 0 ? 'mixed'
      : freshCount > 0 ? 'network' : 'cache';

    return { quotes: result, source, cached_count: cachedCount, fresh_count: freshCount };
  }

  /** 清空循环缓存 */
  clearCache(): void {
    this.quotesCache.clear();
    this.cacheOrder = [];
  }

  // ===== Private: Refresh from Tencent API =====

  /** 从腾讯 API 拉取全市场数据 */
  private async refreshFromNetwork(markets: ('SH' | 'SZ' | 'BJ')[]): Promise<StockData[]> {
    console.log('[DataFetcher] Fetching all stocks from Tencent API...');
    const startTime = Date.now();

    // 1. 获取股票代码列表
    const allCodes = await this.getStockList();
    if (!allCodes.length) {
      console.error('[DataFetcher] No stock list available');
      return [];
    }

    // 2. 过滤市场
    const filtered = allCodes.filter(s => markets.includes(s.market));
    console.log(`[DataFetcher] Total: ${filtered.length} stocks (${markets.join('/')})`);

    // 3. 批量从腾讯拉取
    const allStocks: StockData[] = [];
    const seenCodes = new Set<string>();

    for (let i = 0; i < filtered.length; i += TENCENT_BATCH_SIZE) {
      const batch = filtered.slice(i, i + TENCENT_BATCH_SIZE);
      if (i > 0) await new Promise(r => setTimeout(r, TENCENT_DELAY_MS));

      const items = batch.map(s => {
        if (s.market === 'SH') return 'sh' + s.code;
        if (s.market === 'BJ') return 'bj' + s.code;
        return 'sz' + s.code;
      }).join(',');

      try {
        await withRetry(async () => {
          const res = await fetch(`http://qt.gtimg.cn/q=${items}`, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          const rawBuf = await res.arrayBuffer();
          const text = iconv.decode(Buffer.from(rawBuf), 'gbk');
          const lines = text.split(';');

          for (const line of lines) {
            if (!line.includes('~')) continue;
            const stock = this.parseTencentStockData(line, batch);
            if (stock && !seenCodes.has(stock.code)) {
              seenCodes.add(stock.code);
              allStocks.push(stock);
            }
          }
        }, 3, 1000, `Tencent batch ${i}`);
      } catch (err) {
        console.error(`[DataFetcher] Tencent batch ${i} failed after 3 retries:`, err);
      }
    }

    console.log(`[DataFetcher] Parsed ${allStocks.length} stocks from Tencent API`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[DataFetcher] Done in ${elapsed}s`);
    return allStocks;
  }

  // ===== Cyclic Buffer Cache Helpers =====

  /** 生成缓存 key */
  private codeToCacheKey(code: string): string {
    const market = this.detectMarketByCode(code);
    return `${market}:${code}`;
  }

  /** 将 key 移到 cacheOrder 末尾（LRU） */
  private touchCacheKey(key: string): void {
    const idx = this.cacheOrder.indexOf(key);
    if (idx !== -1) {
      this.cacheOrder.splice(idx, 1);
      this.cacheOrder.push(key);
    }
  }

  /** 写入个股缓存（循环 buffer 淘汰） */
  private setQuoteCache(code: string, data: StockSnapshot): void {
    const key = this.codeToCacheKey(code);
    // 删除已有记录（更新位置）
    const existingIdx = this.cacheOrder.indexOf(key);
    if (existingIdx !== -1) {
      this.cacheOrder.splice(existingIdx, 1);
    }
    // 淘汰最旧的
    while (this.cacheOrder.length >= DataFetcher.CACHE_MAX) {
      const oldest = this.cacheOrder.shift()!;
      this.quotesCache.delete(oldest);
    }
    this.quotesCache.set(key, { data, timestamp: Date.now() });
    this.cacheOrder.push(key);
  }

  /** 从网络批量拉取个股行情 */
  private async fetchQuotesFromNetwork(codes: string[], result: Record<string, StockSnapshot>): Promise<void> {
    for (let i = 0; i < codes.length; i += TENCENT_BATCH_SIZE) {
      const batch = codes.slice(i, i + TENCENT_BATCH_SIZE);
      if (i > 0) await new Promise(r => setTimeout(r, TENCENT_DELAY_MS));

      const items = batch.map(c => this.codeToTencentSymbol(c)).join(',');
      try {
        await withRetry(async () => {
          const res = await fetch(`http://qt.gtimg.cn/q=${items}`, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          const rawBuf = await res.arrayBuffer();
          const text = iconv.decode(Buffer.from(rawBuf), 'gbk');
          const lines = text.split(';');

          for (const line of lines) {
            if (!line.includes('~')) continue;
            const snap = this.parseTencentSnapshot(line);
            if (snap && snap.code) {
              result[snap.code] = snap;
            }
          }
        }, 3, 1000, `Quotes batch ${i}`);
      } catch (err) {
        console.error(`[DataFetcher] fetchQuotes batch at offset ${i} failed after 3 retries:`, err);
      }
    }
  }

  // ===== Tencent Data Parsing =====

  /**
   * 解析一行腾讯行情数据为 StockData
   * @param line 类似: v_sh600000="1~浦发银行~600000~8.73~..."
   * @param batchInfo 该批次股票信息（用于获取 stock_list 中的 name/market 兜底）
   */
  private parseTencentStockData(line: string, batchInfo: StockListItem[]): StockData | null {
    const parts = line.split('~');
    if (parts.length < 50) return null;

    const code = parts[2]?.trim();
    if (!code) return null;

    // 用代码前缀判断市场
    const market = this.detectMarketByCode(code);
    if (!market) return null;

    // 名称：优先用 Tencent 的，兜底用 stock_list 的
    const name = parts[1]?.trim() || this.findNameInBatch(code, batchInfo) || '';

    const price = parseFloat(parts[3]);
    if (isNaN(price) || price <= 0) return null; // 停牌或无效数据

    return {
      code,
      name,
      market,
      price,
      changePercent: this.safeParseFloat(parts[32]) ?? 0,
      volume: this.safeParseFloat(parts[6]) ?? 0,
      turnover: (this.safeParseFloat(parts[37]) ?? 0) * 10000, // 万元 → 元
      open: this.safeParseFloat(parts[5]) ?? undefined,
      high: this.safeParseFloat(parts[33]) ?? undefined,
      low: this.safeParseFloat(parts[34]) ?? undefined,
      turnoverRate: this.safeParseFloat(parts[38]) ?? undefined,
      pe: this.safeParseFloat(parts[39]) ?? undefined,
      pb: this.safeParseFloat(parts[46]) ?? undefined,
      marketCap: (this.safeParseFloat(parts[45]) ?? 0) * 1e8 || undefined, // 亿 → 元
      circulatingMarketCap: (this.safeParseFloat(parts[44]) ?? 0) * 1e8 || undefined,
      volumeRatio: this.safeParseFloat(parts[49]) ?? undefined,
    };
  }

  /**
   * 解析一行腾讯行情数据为 StockSnapshot（用于 fetchQuotes）
   */
  private parseTencentSnapshot(line: string): StockSnapshot | null {
    const parts = line.split('~');
    if (parts.length < 50) return null;

    const code = parts[2]?.trim();
    if (!code) return null;

    const name = parts[1]?.trim() || '';
    const price = parseFloat(parts[3]);
    if (isNaN(price) || price <= 0) return null;

    return {
      code,
      name,
      price,
      changePercent: this.safeParseFloat(parts[32]) ?? 0,
      volume: this.safeParseFloat(parts[6]) ?? 0,
      turnover: (this.safeParseFloat(parts[37]) ?? 0) * 10000,
      open: this.safeParseFloat(parts[5]) ?? undefined,
      high: this.safeParseFloat(parts[33]) ?? undefined,
      low: this.safeParseFloat(parts[34]) ?? undefined,
      prevClose: this.safeParseFloat(parts[4]) ?? undefined,
      volumeRatio: this.safeParseFloat(parts[49]) ?? undefined,
      turnoverRate: this.safeParseFloat(parts[38]) ?? undefined,
      amplitude: this.safeParseFloat(parts[43]) ?? undefined,
      marketCap: (this.safeParseFloat(parts[45]) ?? 0) * 1e8 || undefined,
      circulatingMarketCap: (this.safeParseFloat(parts[44]) ?? 0) * 1e8 || undefined,
    };
  }

  // ===== Helpers =====

  /** 安全解析浮点数 */
  private safeParseFloat(val: string | undefined): number | null {
    if (val === undefined || val === '' || val === '-') return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  /** 计算两个日期之间的天数 */
  private daysBetween(date1: string, date2: string): number {
    const d1 = new Date(date1).getTime();
    const d2 = new Date(date2).getTime();
    return Math.round(Math.abs(d2 - d1) / (24 * 60 * 60 * 1000));
  }

  /** 根据代码前缀判断市场 */
  private detectMarketByCode(code: string): 'SH' | 'SZ' | 'BJ' | null {
    // BJ: 92xxxx, 8xxxxx, 4xxxxx
    if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return 'BJ';
    // SH: 6xxxxx, 9xxxxx (but NOT 92xxxx — handled above)
    if (code.startsWith('6') || code.startsWith('9')) return 'SH';
    // SZ: 0xxxxx, 3xxxxx
    if (code.startsWith('0') || code.startsWith('3')) return 'SZ';
    return null;
  }

  /** 在批次信息中查找股票名称 */
  private findNameInBatch(code: string, batch: StockListItem[]): string | undefined {
    return batch.find(s => s.code === code)?.name;
  }

  /** 代码 → 腾讯符号 */
  private codeToTencentSymbol(code: string): string {
    // BJ: 92xxxx, 8xxxxx, 4xxxxx
    if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return 'bj' + code;
    // SH: 6xxxxx, 9xxxxx
    if (code.startsWith('6') || code.startsWith('9')) return 'sh' + code;
    return 'sz' + code;
  }

  // ===== Stock List =====

  /** 从 stock_list.json 获取股票代码列表 */
  private async getStockList(): Promise<StockListItem[]> {
    if (this.stockListPromise) return this.stockListPromise;

    this.stockListPromise = this.loadStockListFromDisk();
    const result = await this.stockListPromise;
    return result;
  }

  private async loadStockListFromDisk(): Promise<StockListItem[]> {
    try {
      if (fs.existsSync(STOCK_LIST_FILE)) {
        const raw = fs.readFileSync(STOCK_LIST_FILE, 'utf-8');
        const data = JSON.parse(raw) as StockListItem[];
        console.log(`[DataFetcher] Loaded ${data.length} stock codes from stock_list.json`);
        return data;
      }
    } catch (err) {
      console.warn('[DataFetcher] Failed to load stock_list.json:', err);
    }
    return [];
  }
}

// ===== Types =====

export interface StockSnapshot {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  volume: number;
  turnover: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  volumeRatio?: number;
  turnoverRate?: number;
  amplitude?: number;
  marketCap?: number;
  circulatingMarketCap?: number;
}
