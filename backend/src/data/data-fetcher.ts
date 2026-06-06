import * as fs from 'fs';
import * as path from 'path';
import { StockData, KLineData } from '../types';

const SINA_API = {
  stockList: 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
};

// 东方财富 API — 用于补充新浪不提供的字段（如量比 f37）
const EM_API = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const EM_FIELDS = "f12,f37,f71"; // code, 量比, 均价

// 持久化缓存路径
const CACHE_FILE = path.resolve(__dirname, '../../data/stock_cache.json');

interface SinaStockItem {
  symbol: string;       // 如 "sh600000"
  code: string;         // 如 "600000"
  name: string;         // 股票名称
  trade: string;        // 当前价
  pricechange: string;  // 涨跌额
  changepercent: string;// 涨跌幅(%值)
  volume: string;       // 成交量
  amount: string;       // 成交额
  per: string;          // 市盈率 PE
  pb: string;           // 市净率 PB
  mktcap: string;       // 总市值
  nmc: string;          // 流通市值
  open: string;         // 今开
  high: string;         // 最高
  low: string;          // 最低
  turnoverratio: string;// 换手率
}

export class DataFetcher {
  private memoryCache: { stocks: StockData[] | null; timestamp: number } = { stocks: null, timestamp: 0 };
  private readonly MEMORY_TTL = 300_000; // 5 min in-memory
  private refreshPromise: Promise<void> | null = null;  // guard against concurrent refresh

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

  /** 后台刷新，不会阻塞调用方 */
  private refreshInBackground(markets: ('SH' | 'SZ' | 'BJ')[]): void {
    if (this.refreshPromise) return; // 已经在刷新
    this.refreshPromise = this.refreshFromNetwork(markets).finally(() => {
      this.refreshPromise = null;
    });
  }

  /** 从网络拉取全市场数据 — 并行抓取所有页面 */
  private async refreshFromNetwork(markets: ('SH' | 'SZ' | 'BJ')[]): Promise<void> {
    console.log('[DataFetcher] Fetching all stocks from Sina (parallel)...');
    const startTime = Date.now();
    const MAX_PAGES = 60; // 安全上界，5200/100 = 52

    // 启动所有页面并行请求
    const pagePromises: Promise<SinaStockItem[] | null>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${SINA_API.stockList}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=init`;
      pagePromises.push(
        fetch(url)
          .then(res => res.json() as Promise<SinaStockItem[]>)
          .catch(err => {
            console.warn(`[DataFetcher] Page ${page} failed:`, err);
            return null;
          })
      );
    }

    // 等所有页面返回
    const pageResults = await Promise.all(pagePromises);

    // 解析结果，过滤重复
    const seenCodes = new Set<string>();
    const allStocks: StockData[] = [];
    for (let page = 0; page < pageResults.length; page++) {
      const items = pageResults[page];
      if (!items || items.length === 0) continue;
      for (const item of items) {
        if (seenCodes.has(item.code)) continue;
        seenCodes.add(item.code);
        const market = this.parseMarket(item.symbol);
        if (!market || !markets.includes(market)) continue;
        if (!this.isValidACode(item.code, market)) continue;
        allStocks.push({
          code: item.code,
          name: item.name || '',
          market,
          price: parseFloat(item.trade) || 0,
          changePercent: parseFloat(item.changepercent) || 0,
          volume: parseFloat(item.volume) || 0,
          turnover: parseFloat(item.amount) || 0,
          open: item.open ? parseFloat(item.open) : undefined,
          high: item.high ? parseFloat(item.high) : undefined,
          low: item.low ? parseFloat(item.low) : undefined,
          turnoverRate: item.turnoverratio ? parseFloat(item.turnoverratio) : undefined,
          pe: item.per ? parseFloat(item.per) : undefined,
          pb: item.pb ? parseFloat(item.pb) : undefined,
          marketCap: item.mktcap ? parseFloat(item.mktcap) * 10000 : undefined,
        });
      }
    }

    // Step 2: Supplement with EastMoney fields (volumeRatio f37, avgPrice f71)
    await this.supplementEMFields(allStocks);

    this.memoryCache = { stocks: allStocks, timestamp: Date.now() };
    this.saveToDisk(allStocks);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[DataFetcher] Total: ${allStocks.length} stocks (fetched in ${elapsed}s)`);
  }

  /**
   * Supplement stock data with EastMoney-only fields (volumeRatio, avgPrice).
   * Sina API doesn't provide 量比 (f37) or 均价 (f71).
   */
  private async supplementEMFields(stocks: StockData[]): Promise<void> {
    const CHUNK_SIZE = 800;
    const codeIndex = new Map<string, StockData>();
    for (const s of stocks) codeIndex.set(s.code, s);

    const codes = stocks.map(s => s.code);
    const chunks: string[][] = [];
    for (let i = 0; i < codes.length; i += CHUNK_SIZE) {
      chunks.push(codes.slice(i, i + CHUNK_SIZE));
    }

    const emPromises = chunks.map(async (chunk) => {
      const secids = chunk.map(c => {
        const prefix = (c.startsWith('6') || c.startsWith('9')) ? '1.' : '0.';
        return prefix + c;
      }).join(',');

      try {
        const url = `${EM_API}?fltt=2&fields=${EM_FIELDS}&secids=${secids}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }
        });
        const json = await res.json() as any;
        const items: any[] = json?.data?.diff || [];
        for (const item of items) {
          const code = String(item.f12 || '');
          const stock = codeIndex.get(code);
          if (!stock) continue;
          if (item.f37 != null) (stock as any).volumeRatio = parseFloat(item.f37);
          if (item.f71 != null && item.f71 > 0) (stock as any).priceAboveVwap = stock.price > parseFloat(item.f71);
        }
      } catch (err) {
        console.warn(`[DataFetcher] EM supplement chunk failed (${chunk.length} codes):`, err);
      }
    });

    await Promise.all(emPromises);
    const filled = stocks.filter(s => (s as any).volumeRatio != null).length;
    console.log(`[DataFetcher] EM supplement: ${filled}/${stocks.length} stocks have volumeRatio`);
  }

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

  /** 解析新浪 symbol 格式如 "sh600000" -> "SH" */
  private parseMarket(symbol: string): 'SH' | 'SZ' | 'BJ' | null {
    if (symbol.startsWith('sh')) return 'SH';
    if (symbol.startsWith('sz')) return 'SZ';
    if (symbol.startsWith('bj')) return 'BJ';
    return null;
  }

  private isValidACode(code: string, market: 'SH' | 'SZ' | 'BJ'): boolean {
    if (market === 'SH') return code.startsWith('6');
    if (market === 'SZ') return code.startsWith('0') || code.startsWith('3');
    if (market === 'BJ') return code.startsWith('8');
    return false;
  }

  /** 获取个股K线数据（暂用新浪） */
  async fetchKLine(code: string, market: 'SH' | 'SZ', days: number = 120): Promise<KLineData[]> {
    // 新浪 K 线 API（备用）
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

  clearCache(): void {
    this.memoryCache = { stocks: null, timestamp: 0 };
    try { if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE); } catch {}
  }
}
