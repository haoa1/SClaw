/**
 * Historical data fetcher using Tushare Pro API.
 * Uses per-trading-day query strategy (1 call = all stocks for 1 day)
 * instead of per-stock strategy (5000+ calls).
 * Caches to disk per date.
 */

import * as fs from 'fs';
import * as path from 'path';

const TUSHARE_API = 'http://api.tushare.pro';
// Load Tushare token from environment (set in .env)
const TOKEN = process.env.TUSHARE_TOKEN || '';
if (!TOKEN) {
  console.warn('[TushareHistorical] TUSHARE_TOKEN not set in environment');
}

const DATA_DIR = path.resolve(__dirname, '../../data/tushare-kline');

interface TSKLineItem {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  turnoverRate: number;
  changePct: number;
}

/** Call Tushare Pro API */
async function tushareCall(
  apiName: string,
  params: Record<string, string>
): Promise<any> {
  const res = await fetch(TUSHARE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token: TOKEN, params }),
  });
  const json: any = await res.json();
  if (json.code !== 0) {
    throw new Error(`Tushare error: ${json.msg || json.code}`);
  }
  return json.data;
}

/** Build Tushare ts_code from code + market */
function toTsCode(code: string, market: 'SH' | 'SZ' | 'BJ'): string {
  if (market === 'BJ') return `${code}.BJ`;
  return `${code}.${market}`;
}

export class TushareHistoricalDataFetcher {
  private cacheDir: string;
  // Map<date, Map<ts_code, TSKLineItem>>
  private dateCache: Map<string, Map<string, TSKLineItem>> = new Map();

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || DATA_DIR;
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch K-line data for all stocks on a specific trading day.
   * Uses Tushare `daily` API with trade_date filter.
   * Returns Map<code, TSKLineItem> for that day.
   */
  private async fetchDate(date: string): Promise<Map<string, TSKLineItem>> {
    // Check disk cache
    const cachePath = path.join(this.cacheDir, `${date}.json`);
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const map = new Map<string, TSKLineItem>();
        for (const [k, v] of Object.entries(cached)) {
          map.set(k, v as TSKLineItem);
        }
        return map;
      } catch {}
    }

    // Fetch from Tushare
    const data = await this.fetchWithRetry(date, 3);
    
    // Write to disk cache
    const obj: Record<string, TSKLineItem> = {};
    for (const [k, v] of data) {
      obj[k] = v;
    }
    fs.writeFileSync(cachePath, JSON.stringify(obj), 'utf-8');

    return data;
  }

  /**
   * Fetch with exponential backoff retry.
   */
  private async fetchWithRetry(
    date: string,
    maxRetries: number
  ): Promise<Map<string, TSKLineItem>> {
    let lastErr: Error | null = null;

    // Tushare requires YYYYMMDD format for trade_date
    const tushareDate = date.replace(/-/g, '');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Rate limit hit — wait a full 60s before retry
          console.log(`[TushareHistorical] Retry ${attempt}/${maxRetries} for ${date} (waiting 60s for rate limit)...`);
          await new Promise(r => setTimeout(r, 60000));
        }

        const result = await tushareCall('daily', { trade_date: tushareDate });
        const map = new Map<string, TSKLineItem>();

        if (!result || !result.items) {
          if (result?.has_more !== undefined) {
            // Empty trading day
            return map;
          }
          console.warn(`[TushareHistorical] No data for ${date}`);
          return map;
        }

        // fields: ts_code, trade_date, open, high, low, close, pre_close, change, pct_chg, vol, amount
        const fields = result.fields as string[];
        const fTsCode = fields.indexOf('ts_code');
        const fOpen = fields.indexOf('open');
        const fHigh = fields.indexOf('high');
        const fLow = fields.indexOf('low');
        const fClose = fields.indexOf('close');
        const fVol = fields.indexOf('vol');
        const fAmount = fields.indexOf('amount');
        const fPctChg = fields.indexOf('pct_chg');

        for (const item of result.items) {
          const tsCode: string = item[fTsCode];
          const code = tsCode.split('.')[0]; // "600000.SH" → "600000"
          const pctChg = parseFloat(item[fPctChg]) || 0;
          // Estimate turnover rate from vol vs total shares (rough)
          map.set(code, {
            date,
            open: parseFloat(item[fOpen]) || 0,
            close: parseFloat(item[fClose]) || 0,
            high: parseFloat(item[fHigh]) || 0,
            low: parseFloat(item[fLow]) || 0,
            volume: parseFloat(item[fVol]) || 0,
            amount: parseFloat(item[fAmount]) || 0,
            turnoverRate: 0, // Tushare daily doesn't include turnover rate directly
            changePct: pctChg,
          });
        }

        console.log(`[TushareHistorical] Fetched ${map.size} stocks for ${date}`);
        return map;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.warn(`[TushareHistorical] Attempt ${attempt + 1} failed for ${date}: ${lastErr.message}`);
      }
    }

    console.error(`[TushareHistorical] All ${maxRetries + 1} attempts failed for ${date}`);
    return new Map();
  }

  /**
   * Generate date strings between two dates (YYYY-MM-DD format).
   */
  private *dateRange(startDate: string, endDate: string): Generator<string> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const current = new Date(start);
    while (current <= end) {
      yield current.toISOString().slice(0, 10);
      current.setDate(current.getDate() + 1);
    }
  }

  /**
   * Fetch K-line data for multiple stocks.
   * Uses per-trading-day strategy internally.
   * Returns Map<code, TSKLineItem[]>
   */
  async fetchBatch(
    stocks: Array<{ code: string; market: 'SH' | 'SZ' | 'BJ' }>,
    days: number = 500,
    _concurrency: number = 3,
    startDateOverride?: string,
    endDateOverride?: string
  ): Promise<Map<string, TSKLineItem[]>> {
    const results = new Map<string, TSKLineItem[]>();
    const codeSet = new Set(stocks.map(s => s.code));
    
    // Determine date range
    const endDate = endDateOverride ? new Date(endDateOverride) : new Date();
    const startDate = startDateOverride
      ? new Date(startDateOverride)
      : new Date(endDate.getTime() - (days + 10) * 24 * 60 * 60 * 1000);

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    // Collect all dates in range
    const allDates: string[] = [];
    for (const d of this.dateRange(startStr, endStr)) {
      allDates.push(d);
    }

    // Filter to weekdays only (Mon-Fri)
    const weekdays = allDates.filter(d => {
      const dow = new Date(d).getDay();
      return dow !== 0 && dow !== 6;
    });

    console.log(`[TushareHistorical] Fetching ${weekdays.length} trading days (skipped ${allDates.length - weekdays.length} weekends) for ${stocks.length} stocks...`);

    // Sequential fetch with rate limiting (Tushare: 50 calls/min max)
    // Use 1.5s delay between calls = 40 calls/min (safe margin)
    // Only delay when actually hitting the API (not from disk cache)
    
    // First, pre-load all disk-cached dates into memory
    let cachedCount = 0;
    let apiCount = 0;
    for (const date of weekdays) {
      if (this.dateCache.has(date)) {
        cachedCount++;
        continue;
      }
      const cachePath = path.join(this.cacheDir, `${date}.json`);
      if (fs.existsSync(cachePath) && !this.dateCache.has(date)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          const map = new Map<string, TSKLineItem>();
          for (const [k, v] of Object.entries(cached)) {
            map.set(k, v as TSKLineItem);
          }
          this.dateCache.set(date, map);
          cachedCount++;
          continue;
        } catch {}
      }
      // Not cached locally nor on disk — fetch from API
      const data = await this.fetchDate(date);
      this.dateCache.set(date, data);
      apiCount++;
      // Rate limit delay: 1.5s between API calls
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`[TushareHistorical] Loaded ${cachedCount} cached + ${apiCount} API days`);

    // Build per-stock arrays
    for (const code of codeSet) {
      const items: TSKLineItem[] = [];
      for (const date of allDates) {
        const dayData = this.dateCache.get(date);
        if (dayData?.has(code)) {
          items.push(dayData.get(code)!);
        }
      }
      results.set(code, items);
    }

    console.log(`[TushareHistorical] Built data for ${results.size} stocks`);
    return results;
  }

  /**
   * Get the index of a target date in a sorted kline array.
   */
  findDateIndex(items: TSKLineItem[], targetDate: string): number {
    const target = new Date(targetDate);
    for (let i = items.length - 1; i >= 0; i--) {
      if (new Date(items[i].date) <= target) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Find nearest K-line data for each stock at a target date.
   */
  findNearestKLines(
    klineMap: Map<string, TSKLineItem[]>,
    targetDate: string
  ): Map<string, TSKLineItem> {
    const results = new Map<string, TSKLineItem>();
    const target = new Date(targetDate);

    for (const [code, items] of klineMap) {
      let best: TSKLineItem | null = null;
      for (const item of items) {
        const itemDate = new Date(item.date);
        if (itemDate <= target) {
          if (!best || itemDate > new Date(best.date)) {
            best = item;
          }
        }
      }
      if (best) results.set(code, best);
    }

    return results;
  }

  clearCache(): void {
    this.dateCache.clear();
    if (fs.existsSync(this.cacheDir)) {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
      console.log(`[TushareHistorical] Cleared ${files.length} cached files`);
    }
  }
}
