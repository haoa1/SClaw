/**
 * Historical data fetcher using East Money API.
 * Fetches daily K-line data for backtesting purposes.
 * Caches aggressively to disk to minimize API calls.
 */

import * as fs from 'fs';
import * as path from 'path';

const EM_KLINE_API = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

const DATA_DIR = path.resolve(__dirname, '../../data/historical');

interface EMKLineItem {
  date: string;         // '2025-01-02'
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;       // turnover amount
  amplitude: number;    // %
  changePct: number;    // change %
  change: number;       // change amount
  turnoverRate: number; // %
}

// secid mapping
function toSecId(code: string, market: 'SH' | 'SZ' | 'BJ'): string {
  if (market === 'SH' || code.startsWith('6') || code.startsWith('9')) return `1.${code}`;
  if (market === 'BJ' || code.startsWith('8')) return `0.${code}`;
  return `0.${code}`;
}

export class HistoricalDataFetcher {
  private cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || DATA_DIR;
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch daily K-line data for a single stock.
   * Returns up to ~1000 days of daily data.
   */
  async fetchDailyKLine(
    code: string,
    market: 'SH' | 'SZ' | 'BJ',
    days: number = 500
  ): Promise<EMKLineItem[]> {
    // Check disk cache first
    const cacheKey = `${market}_${code}`;
    const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);
    
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (cached.length >= days) {
          return cached.slice(-days);
        }
      } catch {}
    }

    // Fetch from API
    const secid = toSecId(code, market);
    const url = `${EM_KLINE_API}?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${Math.max(days, 1000)}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      });
      const json: any = await res.json();

      if (!json.data?.klines) {
        console.warn(`[HistoricalDataFetcher] No data for ${code}: ${json.rc}`);
        return [];
      }

      const items: EMKLineItem[] = json.data.klines.map((kline: string) => {
        const [date, open, close, high, low, volume, amount, amplitude, changePct, change, turnoverRate] = kline.split(',');
        return {
          date,
          open: parseFloat(open),
          close: parseFloat(close),
          high: parseFloat(high),
          low: parseFloat(low),
          volume: parseInt(volume) || 0,
          amount: parseFloat(amount) || 0,
          amplitude: parseFloat(amplitude) || 0,
          changePct: parseFloat(changePct) || 0,
          change: parseFloat(change) || 0,
          turnoverRate: parseFloat(turnoverRate) || 0,
        };
      });

      // Write to cache
      fs.writeFileSync(cachePath, JSON.stringify(items), 'utf-8');
      console.log(`[HistoricalDataFetcher] Cached ${items.length} days for ${code}`);

      return items.slice(-days);
    } catch (err) {
      console.error(`[HistoricalDataFetcher] Error fetching ${code}:`, err);
      return [];
    }
  }

  /**
   * Fetch K-line for multiple stocks in parallel.
   * Returns a Map<code, EMKLineItem[]>
   */
  async fetchBatch(
    stocks: Array<{ code: string; market: 'SH' | 'SZ' | 'BJ' }>,
    days: number = 500,
    concurrency: number = 10
  ): Promise<Map<string, EMKLineItem[]>> {
    const results = new Map<string, EMKLineItem[]>();
    const queue = [...stocks];

    async function worker(this: HistoricalDataFetcher) {
      while (queue.length > 0) {
        const stock = queue.shift()!;
        const data = await this.fetchDailyKLine(stock.code, stock.market, days);
        results.set(stock.code, data);
      }
    }

    const workers = Array(concurrency).fill(null).map(() => worker.call(this));
    await Promise.all(workers);

    return results;
  }

  /**
   * Get the K-line data nearest to a given date (exact or previous trading day).
   */
  findNearestKLines(
    klineMap: Map<string, EMKLineItem[]>,
    targetDate: string
  ): Map<string, EMKLineItem> {
    const results = new Map<string, EMKLineItem>();
    const target = new Date(targetDate);

    for (const [code, items] of klineMap) {
      // Find exact match or nearest previous trading day
      let best: EMKLineItem | null = null;
      for (const item of items) {
        const itemDate = new Date(item.date);
        if (itemDate <= target) {
          if (!best || itemDate > new Date(best.date)) {
            best = item;
          }
        }
      }
      if (best) {
        results.set(code, best);
      }
    }

    return results;
  }

  /**
   * Get the index of a target date in a sorted kline array.
   */
  findDateIndex(items: EMKLineItem[], targetDate: string): number {
    const target = new Date(targetDate);
    for (let i = items.length - 1; i >= 0; i--) {
      if (new Date(items[i].date) <= target) {
        return i;
      }
    }
    return -1;
  }

  clearCache(): void {
    if (fs.existsSync(this.cacheDir)) {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      console.log(`[HistoricalDataFetcher] Cleared ${files.length} cached files`);
    }
  }
}
