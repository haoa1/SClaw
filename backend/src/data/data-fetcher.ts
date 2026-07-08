import * as fs from 'fs';
import * as path from 'path';
import iconv from 'iconv-lite';
import { StockData, KLineData, KLineMeta } from '../types';

// ===== Local Database (direct SQLite for K-line) =====
const DB_PATH = path.resolve(__dirname, '../../data/stock_history.db');
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
  async fetchAllStocks(markets: ('SH' | 'SZ' | 'BJ')[] = ['SH', 'SZ', 'BJ']): Promise<StockData[]> {
    // 请求去重：同一时间多个并发请求共享一次网络拉取
    if (this.fetchAllPromise) {
      return await this.fetchAllPromise;
    }
    this.fetchAllPromise = this.refreshFromNetwork(markets);
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

      const dbRows = this.queryLocalKLine(code, startStr, todayStr);
      allData = dbRows.map(r => ({
        date: r.date, open: r.open, close: r.close,
        high: r.high, low: r.low, volume: r.volume,
      }));

      if (dbRows.length > 0) {
        sources.push({
          source: 'sqlite_local',
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
          
          // Online data takes priority over local SQLite.
          // Merge: start with online data, then add SQLite-only dates that online didn't cover.
          const onlineDates = new Set(onlineData.map(d => d.date));
          const sqliteOnly = allData.filter(d => !onlineDates.has(d.date));
          
          allData = [...onlineData, ...sqliteOnly];
          console.log(`[DataFetcher] fetchKLine: using ${onlineData.length} ${onlineSource} + ${sqliteOnly.length} SQLite-only entries for ${code}`);
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

  /** 从本地 SQLite 查 K线数据 */
  private queryLocalKLine(code: string, startDate: string, endDate: string): Array<{
    date: string; open: number; high: number; low: number; close: number; volume: number;
  }> {
    try {
      if (!fs.existsSync(DB_PATH)) {
        console.warn(`[DataFetcher] DB not found: ${DB_PATH}`);
        return [];
      }
      // Use better-sqlite3 for sync query (it's fast for indexed queries)
      const Database = require('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const rows = db.prepare(`
          SELECT date, open, high, low, close, volume
          FROM stock_daily
          WHERE code = ? AND date >= ? AND date <= ?
          ORDER BY date
        `).all(code, startDate, endDate) as Array<{
          date: string; open: number; high: number; low: number; close: number; volume: number;
        }>;
        return rows;
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[DataFetcher] queryLocalKLine error for ${code}:`, err);
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
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;
      
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
