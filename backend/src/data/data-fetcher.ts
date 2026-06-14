import * as fs from 'fs';
import * as path from 'path';
import { StockData, KLineData } from '../types';

/**
 * East Money (东方财富) 实时行情 API
 * 
 * 批量查询所有A股:
 *   https://push2.eastmoney.com/api/qt/clist/get
 *   ?pn=1&pz=100&po=1&np=1
 *   &fields=f2,f3,f4,f5,f6,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f37,f115
 *   &fid=f3
 *   &fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048
 * 
 * fs 参数含义:
 *   m:0+t:6       = 沪市A股
 *   m:0+t:80      = 沪市B股(忽略)
 *   m:1+t:2       = 深市A股主板
 *   m:1+t:23      = 创业板
 *   m:0+t:81+s:2048 = 北交所
 * 
 * 字段说明:
 *   f2  = 最新价 (需 ÷100)
 *   f3  = 涨跌幅% (需 ÷100)
 *   f4  = 涨跌额 (需 ÷100)
 *   f5  = 成交量(手)
 *   f6  = 成交额(元)
 *   f8  = 换手率% (需 ÷100)
 *   f9  = 量比 (需 ÷100)
 *   f10 = 振幅% (需 ÷100)
 *   f12 = 股票代码
 *   f14 = 股票名称
 *   f15 = 最高价 (需 ÷100)
 *   f16 = 最低价 (需 ÷100)
 *   f17 = 今开 (需 ÷100)
 *   f18 = 昨收 (需 ÷100)
 *   f20 = 总市值(元)
 *   f21 = 流通市值(元)
 *   f37 = 静态市盈率 (已是小数)
 *   f115 = 市盈率TTM (需 ÷100)
 */
const EASTMONEY_CLIST_API = 'https://push2.eastmoney.com/api/qt/clist/get';

// 全市场 A 股筛选条件
const EASTMONEY_FS_ALL_A = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
// 需要的字段
const EASTMONEY_FIELDS = 'f2,f3,f4,f5,f6,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f37,f115';

// 单票实时行情 API (备用)
const EASTMONEY_ULIST_API = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

// 缓存文件路径
const CACHE_FILE = path.resolve(__dirname, '../../data/stock_cache.json');

export class DataFetcher {
  private memoryCache: { stocks: StockData[] | null; timestamp: number } = { stocks: null, timestamp: 0 };
  private readonly MEMORY_TTL = 300_000; // 5 min in-memory
  private refreshPromise: Promise<void> | null = null; // guard against concurrent refresh

  // ===== Public API =====

  /** 获取全市场数据：从内存 → 磁盘 → 网络刷新（后台） */
  async fetchAllStocks(markets: ('SH' | 'SZ' | 'BJ')[] = ['SH', 'SZ', 'BJ']): Promise<StockData[]> {
    // 1. 内存缓存（即时）
    if (this.memoryCache.stocks && (Date.now() - this.memoryCache.timestamp) < this.MEMORY_TTL) {
      return this.memoryCache.stocks;
    }

    // 2. 磁盘缓存（首次启动快速恢复）
    if (!this.memoryCache.stocks) {
      const loaded = this.loadFromDisk();
      if (loaded) {
        this.memoryCache = { stocks: loaded, timestamp: Date.now() };
      }
    }

    // 有缓存就先返回（无论是否过期），后台刷新
    if (this.memoryCache.stocks) {
      this.refreshInBackground(markets);
      return this.memoryCache.stocks;
    }

    // 3. 首次启动，没有缓存 → 同步等待网络拉取
    await this.refreshFromNetwork(markets);
    return this.memoryCache.stocks || [];
  }

  /** 获取个股K线数据 */
  async fetchKLine(code: string, market: 'SH' | 'SZ', days: number = 120): Promise<KLineData[]> {
    // 新浪 K 线 API（备用，仍可用）
    const symbol = market === 'SH' ? `sh${code}` : `sz${code}`;
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/OHLC.getKLineData?symbol=${symbol}&datalen=${days}&scale=60`;

    try {
      const res = await fetch(url);
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
    } catch (err) {
      console.error(`[DataFetcher] Failed to fetch KLine for ${code}:`, err);
      return [];
    }
  }

  /**
   * Fetch real-time quotes for specific stocks (盯盘用).
   * Uses East Money ulist API: https://push2.eastmoney.com/api/qt/ulist.np/get
   * Batches by 50 stocks per request to avoid URL length limits.
   */
  async fetchQuotes(codes: string[]): Promise<Record<string, StockSnapshot>> {
    const result: Record<string, StockSnapshot> = {};
    if (!codes.length) return result;

    // Build secids: "0.000001" for SZ, "1.600000" for SH, "0.830750" for BJ
    // East Money format: market_code: 0=SZ, 1=SH, 2=BJ
    const secids = codes.map(code => {
      if (code.startsWith('6') || code.startsWith('9')) return `1.${code}`;
      if (code.startsWith('8') || code.startsWith('4')) return `2.${code}`;
      return `0.${code}`; // default SZ
    });

    const fields = 'f2,f3,f4,f5,f6,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f37,f115';
    const BATCH_SIZE = 50;

    for (let i = 0; i < secids.length; i += BATCH_SIZE) {
      const batch = secids.slice(i, i + BATCH_SIZE);
      const url = `${EASTMONEY_ULIST_API}?fields=${fields}&fltt=2&secids=${batch.join(',')}`;

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://quote.eastmoney.com/',
          },
          signal: AbortSignal.timeout(10000),
        });
        const json: any = await res.json();
        if (json.rc !== 0 || !json.data?.diff) continue;

        for (const item of json.data.diff as EastMoneyItem[]) {
          const code = item.f12;
          if (!code) continue;
          result[code] = {
            code,
            name: item.f14 || '',
            price: this.div100(item.f2),
            changePercent: this.div100(item.f3),
            volume: item.f5 || 0,
            turnover: item.f6 || 0,
            open: this.div100(item.f17),
            high: this.div100(item.f15),
            low: this.div100(item.f16),
            prevClose: this.div100(item.f18),
            volumeRatio: item.f9 != null ? this.div100(item.f9) : undefined,
            turnoverRate: item.f8 != null ? this.div100(item.f8) : undefined,
            amplitude: item.f10 != null ? this.div100(item.f10) : undefined,
            marketCap: item.f20,
            circulatingMarketCap: item.f21,
          };
        }
      } catch (err) {
        console.warn(`[DataFetcher] fetchQuotes batch failed:`, err);
      }
    }

    return result;
  }

  clearCache(): void {
    this.memoryCache = { stocks: null, timestamp: 0 };
    try { if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE); } catch {}
  }

  // ===== Private: Refresh from East Money =====

  /** 后台刷新，不会阻塞调用方 */
  private refreshInBackground(markets: ('SH' | 'SZ' | 'BJ')[]): void {
    if (this.refreshPromise) return; // 已经在刷新
    this.refreshPromise = this.refreshFromNetwork(markets).finally(() => {
      this.refreshPromise = null;
    });
  }

  /** 从东方财富网络拉取全市场数据 — 并行抓取所有页面 */
  private async refreshFromNetwork(markets: ('SH' | 'SZ' | 'BJ')[]): Promise<void> {
    console.log('[DataFetcher] Fetching all stocks from East Money (parallel)...');
    const startTime = Date.now();

    // Step 1: 获取第一页，获取 total 总数
    const firstPage = await this.fetchEastMoneyPage(1);
    if (!firstPage) {
      console.error('[DataFetcher] Failed to fetch first page from East Money');
      this.memoryCache = { stocks: this.memoryCache.stocks || [], timestamp: Date.now() };
      return;
    }

    const total = firstPage.total;
    const PAGE_SIZE = 100;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    console.log(`[DataFetcher] East Money total: ${total} stocks, ${totalPages} pages`);

    // Step 2: 并行抓取剩余页面（但控制并发，避免触发限流）
    const pageResults: EastMoneyPageData[] = [firstPage];

    const remainingPages: number[] = [];
    for (let pn = 2; pn <= totalPages; pn++) {
      remainingPages.push(pn);
    }

    // 分批并行：每次最多 10 个并发请求
    const CONCURRENCY = 10;
    for (let i = 0; i < remainingPages.length; i += CONCURRENCY) {
      const batch = remainingPages.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(pn => this.fetchEastMoneyPage(pn).catch(err => {
          console.warn(`[DataFetcher] Page ${pn} failed:`, err);
          return null;
        }))
      );
      for (const r of batchResults) {
        if (r) pageResults.push(r);
      }
      // 每批之间加 200ms 延迟，避免触发限流
      if (i + CONCURRENCY < remainingPages.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Step 3: 解析结果，去重，构建 StockData
    const seenCodes = new Set<string>();
    const allStocks: StockData[] = [];

    for (const pageData of pageResults) {
      for (const item of pageData.items) {
        const code = item.f12;
        if (!code || seenCodes.has(code)) continue;
        seenCodes.add(code);

        const market = this.detectMarket(code);
        if (!market || !markets.includes(market)) continue;

        allStocks.push(this.parseEastMoneyItem(item, market));
      }
    }

    this.memoryCache = { stocks: allStocks, timestamp: Date.now() };
    this.saveToDisk(allStocks);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[DataFetcher] Total: ${allStocks.length} stocks (fetched in ${elapsed}s)`);
  }

  /** 获取东方财富一页数据 */
  private async fetchEastMoneyPage(pn: number): Promise<EastMoneyPageData | null> {
    const url = `${EASTMONEY_CLIST_API}?pn=${pn}&pz=100&po=1&np=1&fields=${EASTMONEY_FIELDS}&fid=f3&fs=${EASTMONEY_FS_ALL_A}`;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(15000),
      });

      const json: any = await res.json();

      if (json.rc !== 0 || !json.data) {
        console.warn(`[DataFetcher] East Money page ${pn} returned error:`, json.rt || 'unknown');
        return null;
      }

      return {
        total: json.data.total as number,
        items: (json.data.diff || []) as EastMoneyItem[],
      };
    } catch (err) {
      console.warn(`[DataFetcher] East Money page ${pn} fetch failed:`, err);
      return null;
    }
  }

  /** 将东方财富数据项解析为 StockData */
  private parseEastMoneyItem(item: EastMoneyItem, market: 'SH' | 'SZ' | 'BJ'): StockData {
    const price = this.div100(item.f2);
    const prevClose = this.div100(item.f18);

    return {
      code: item.f12,
      name: item.f14 || '',
      market,
      price: price,
      changePercent: this.div100(item.f3),
      volume: item.f5 || 0,
      turnover: item.f6 || 0,
      open: item.f17 != null ? this.div100(item.f17) : undefined,
      high: item.f15 != null ? this.div100(item.f15) : undefined,
      low: item.f16 != null ? this.div100(item.f16) : undefined,
      turnoverRate: item.f8 != null ? this.div100(item.f8) : undefined,
      // 基本面
      pe: item.f115 != null ? this.div100(item.f115) : undefined,
      pb: undefined, // East Money clist 不直接提供 PB
      marketCap: item.f20 || undefined,
      circulatingMarketCap: item.f21 || undefined,
      volumeRatio: item.f9 != null ? this.div100(item.f9) : undefined,
    };
  }

  // ===== Helpers =====

  /** 除以 100（东方财富价格/百分比字段通常放大100倍） */
  private div100(val: number | undefined | null): number {
    if (val == null) return 0;
    return val / 100;
  }

  /** 根据代码前缀判断市场 */
  private detectMarket(code: string): 'SH' | 'SZ' | 'BJ' | null {
    if (code.startsWith('6') || code.startsWith('9')) return 'SH';
    if (code.startsWith('0') || code.startsWith('3')) return 'SZ';
    if (code.startsWith('8') || code.startsWith('4')) return 'BJ';
    return null;
  }

  // ===== Disk Cache =====

  /** 从磁盘加载缓存 */
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

  /** 保存到磁盘 */
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

interface EastMoneyPageData {
  total: number;
  items: EastMoneyItem[];
}

interface EastMoneyItem {
  f2?: number;  // 最新价 (需÷100)
  f3?: number;  // 涨跌幅% (需÷100)
  f4?: number;  // 涨跌额 (需÷100)
  f5?: number;  // 成交量(手)
  f6?: number;  // 成交额(元)
  f8?: number;  // 换手率% (需÷100)
  f9?: number;  // 量比 (需÷100)
  f10?: number; // 振幅% (需÷100)
  f12: string;  // 股票代码
  f14?: string; // 股票名称
  f15?: number; // 最高价 (需÷100)
  f16?: number; // 最低价 (需÷100)
  f17?: number; // 今开 (需÷100)
  f18?: number; // 昨收 (需÷100)
  f20?: number; // 总市值(元)
  f21?: number; // 流通市值(元)
  f37?: number; // 静态市盈率 (已是小数)
  f115?: number;// 市盈率TTM (需÷100)
}

// ===== Watch Engine Types =====

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
