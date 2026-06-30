import * as fs from 'fs';
import * as path from 'path';
import iconv from 'iconv-lite';
import { StockData, KLineData } from '../types';

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

// 缓存文件路径
const CACHE_FILE = path.resolve(__dirname, '../../data/stock_cache.json');
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
  private memoryCache: { stocks: StockData[] | null; timestamp: number } = { stocks: null, timestamp: 0 };
  private readonly MEMORY_TTL = 300_000; // 5 min in-memory
  private refreshPromise: Promise<void> | null = null;
  private stockListPromise: Promise<StockListItem[]> | null = null;

  // ===== Public API =====

  /** 获取全市场数据：从内存 → 磁盘 → 网络刷新（后台） */
  async fetchAllStocks(markets: ('SH' | 'SZ' | 'BJ')[] = ['SH', 'SZ', 'BJ']): Promise<StockData[]> {
    // 1. 内存缓存
    if (this.memoryCache.stocks && (Date.now() - this.memoryCache.timestamp) < this.MEMORY_TTL) {
      return this.memoryCache.stocks;
    }

    // 2. 磁盘缓存
    if (!this.memoryCache.stocks) {
      const loaded = this.loadFromDisk();
      if (loaded) {
        this.memoryCache = { stocks: loaded, timestamp: Date.now() };
      }
    }

    // 有缓存就先返回，后台刷新
    if (this.memoryCache.stocks) {
      this.refreshInBackground(markets);
      return this.memoryCache.stocks;
    }

    // 3. 首次启动，同步等待网络拉取
    await this.refreshFromNetwork(markets);
    return this.memoryCache.stocks || [];
  }

  /** 获取个股K线数据（新浪API，带重试） */
  async fetchKLine(code: string, market: 'SH' | 'SZ', days: number = 120): Promise<KLineData[]> {
    const symbol = market === 'SH' ? `sh${code}` : `sz${code}`;
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/OHLC.getKLineData?symbol=${symbol}&datalen=${days}&scale=60`;

    try {
      return await withRetry(async () => {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const data = await res.json() as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
        if (!data || !Array.isArray(data)) return [];
        return data.map(item => ({
          date: item.date,
          open: item.open,
          close: item.close,
          high: item.high,
          low: item.low,
          volume: item.volume,
        }));
      }, 3, 1000, `KLine ${code}`);
    } catch (err) {
      console.error(`[DataFetcher] Failed to fetch KLine for ${code} after 3 retries:`, err);
      throw new Error(`获取 ${code} K线数据失败（重试3次后）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 获取指定股票的实时快照（盯盘用） */
  async fetchQuotes(codes: string[]): Promise<Record<string, StockSnapshot>> {
    const result: Record<string, StockSnapshot> = {};
    if (!codes.length) return result;

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
        // 不抛错，继续处理下一批
      }
    }

    return result;
  }

  clearCache(): void {
    this.memoryCache = { stocks: null, timestamp: 0 };
    try { if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE); } catch {}
  }

  // ===== Private: Refresh from Tencent API =====

  private refreshInBackground(markets: ('SH' | 'SZ' | 'BJ')[]): void {
    if (this.refreshPromise) return;
    this.refreshPromise = this.refreshFromNetwork(markets).finally(() => {
      this.refreshPromise = null;
    });
  }

  /** 从腾讯 API 拉取全市场数据 */
  private async refreshFromNetwork(markets: ('SH' | 'SZ' | 'BJ')[]): Promise<void> {
    console.log('[DataFetcher] Fetching all stocks from Tencent API...');
    const startTime = Date.now();

    // 1. 获取股票代码列表
    const allCodes = await this.getStockList();
    if (!allCodes.length) {
      console.error('[DataFetcher] No stock list available, using disk cache if present');
      this.memoryCache = { stocks: this.memoryCache.stocks || [], timestamp: Date.now() };
      return;
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
        // 不抛错，继续处理下一批
      }
    }

    console.log(`[DataFetcher] Parsed ${allStocks.length} stocks from Tencent API`);

    // 4. 更新内存缓存 + 写入磁盘
    this.memoryCache = { stocks: allStocks, timestamp: Date.now() };
    this.saveToDisk(allStocks);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[DataFetcher] Done in ${elapsed}s`);
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

  /** 根据代码前缀判断市场 */
  private detectMarketByCode(code: string): 'SH' | 'SZ' | 'BJ' | null {
    if (code.startsWith('6') || code.startsWith('9')) return 'SH';
    if (code.startsWith('0') || code.startsWith('3')) return 'SZ';
    if (code.startsWith('8') || code.startsWith('4')) return 'BJ';
    return null;
  }

  /** 在批次信息中查找股票名称 */
  private findNameInBatch(code: string, batch: StockListItem[]): string | undefined {
    return batch.find(s => s.code === code)?.name;
  }

  /** 代码 → 腾讯符号 */
  private codeToTencentSymbol(code: string): string {
    if (code.startsWith('6') || code.startsWith('9')) return 'sh' + code;
    if (code.startsWith('8') || code.startsWith('4')) return 'bj' + code;
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

  // ===== Disk Cache =====

  private loadFromDisk(): StockData[] | null {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        console.log(`[DataFetcher] Loaded ${data.length} stocks from disk cache`);
        return data;
      }
    } catch (err) {
      console.warn('[DataFetcher] Disk cache load failed:', err);
    }
    return null;
  }

  private saveToDisk(stocks: StockData[]): void {
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(stocks), 'utf-8');
      console.log(`[DataFetcher] Saved ${stocks.length} stocks to disk cache`);
    } catch (err) {
      console.warn('[DataFetcher] Disk cache save failed:', err);
    }
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
