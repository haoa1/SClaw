/**
 * Data Sync — 从腾讯在线 API 获取真实 K 线数据并写入 SQLite
 *
 * 原则：
 *   - 只存真实数据（不存 mock/fake 数据）
 *   - 使用 withRetry 机制，自动重试
 *   - 批量写入，事务保证原子性
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { LocalDatabase, DailyKLine } from './local-database';
import { withRetry } from './data-fetcher';

const STOCK_LIST_PATH = path.resolve(__dirname, '../../data/stock_list.json');
const AKSHARE_SCRIPT = path.resolve(__dirname, '../../scripts/fetch_bj_via_akshare.py');
const CONCURRENCY = 5;
const DAYS_TO_FETCH = 500;
const DELAY_MS = 100;

interface StockListItem {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
}

interface KLineData {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

function loadStockList(): StockListItem[] {
  if (!fs.existsSync(STOCK_LIST_PATH)) {
    console.error(`[DataSync] Stock list not found: ${STOCK_LIST_PATH}`);
    return [];
  }
  return JSON.parse(fs.readFileSync(STOCK_LIST_PATH, 'utf-8')) as StockListItem[];
}

async function fetchFromTencent(code: string, market: 'SH' | 'SZ' | 'BJ', days: number): Promise<KLineData[]> {
  const symbol = market === 'SH' ? 'sh' + code
    : market === 'BJ' ? 'bj' + code
    : 'sz' + code;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await res.text();
      if (!text || text.startsWith('<')) {
        console.warn(`[DataSync] HTML response for ${code}, skipping`);
        return [];
      }
      const j = JSON.parse(text);
      const stockData = j?.data?.[symbol] || {};
      const dayData: any[][] = stockData.qfqday || stockData.day || [];
      if (!Array.isArray(dayData) || dayData.length === 0) return [];
      return dayData
        .map((row: any[]) => ({
          date: String(row[0]),
          open: parseFloat(row[1]) || 0,
          close: parseFloat(row[2]) || 0,
          high: parseFloat(row[3]) || 0,
          low: parseFloat(row[4]) || 0,
          volume: parseFloat(row[5]) || 0,
        }))
        .filter(d => d.date && d.close > 0);
    } finally {
      clearTimeout(timeout);
    }
  }, 3, 2000, `Tencent ${code}`);
}

/**
 * 通过 akshare (stock_zh_a_daily, 新浪源) 获取BJ股票K线数据
 * 腾讯 API 不提供 BJ 历史 K 线，必须用此方式
 */
async function fetchFromAkshare(code: string, days: number): Promise<KLineData[]> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
  const endStr = endDate.toISOString().slice(0, 10).replace(/-/g, '');

  return withRetry(async () => {
    const cmd = `python3 "${AKSHARE_SCRIPT}" ${code} ${startStr} ${endStr} qfq`;
    const stdout = execSync(cmd, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }).toString().trim();

    const parsed = JSON.parse(stdout);
    if (parsed.error) {
      console.warn(`[DataSync] akshare error for ${code}: ${parsed.error}`);
      return [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return [];

    return parsed as KLineData[];
  }, 2, 3000, `Akshare ${code}`);
}

function toDailyKLines(code: string, data: KLineData[]): DailyKLine[] {
  const results: DailyKLine[] = [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const prevClose = i > 0 ? data[i - 1].close : d.open;
    const changePct = prevClose > 0
      ? parseFloat((((d.close - prevClose) / prevClose) * 100).toFixed(2))
      : 0;
    results.push({
      code, date: d.date, open: d.open, high: d.high, low: d.low,
      close: d.close, volume: d.volume,
      amount: 0, changePct, turnoverRate: 0,
    });
  }
  return results;
}

async function syncSingleStock(db: LocalDatabase, stock: StockListItem, days: number): Promise<number> {
  try {
    let rawData: KLineData[];
    if (stock.market === 'BJ') {
      // BJ 股票：腾讯 API 没有历史 K 线，必须用 akshare（新浪源）
      rawData = await fetchFromAkshare(stock.code, days);
    } else {
      rawData = await fetchFromTencent(stock.code, stock.market, days);
    }
    if (rawData.length === 0) return 0;
    const klines = toDailyKLines(stock.code, rawData);
    db.insertDailyKLines(klines);
    return klines.length;
  } catch (err) {
    return 0;
  }
}

function getSyncedCodes(db: LocalDatabase): Set<string> {
  const rows = db.query<{ code: string }>('SELECT DISTINCT code FROM stock_daily');
  return new Set(rows.map(r => r.code));
}

/**
 * 增量同步：只同步尚未在数据库中的股票
 */
export async function syncRemainingStocks(
  days: number = DAYS_TO_FETCH,
  onProgress?: (done: number, total: number) => void
): Promise<{ total: number; success: number; written: number }> {
  const allStocks = loadStockList();
  if (allStocks.length === 0) return { total: 0, success: 0, written: 0 };

  const db = new LocalDatabase();
  const syncedCodes = getSyncedCodes(db);
  const pending = allStocks.filter(s => !syncedCodes.has(s.code));

  console.log(`[DataSync] Already synced: ${syncedCodes.size}/${allStocks.length}, pending: ${pending.length}`);

  let written = 0;
  let success = 0;
  let done = 0;

  // Batch in groups of CONCURRENCY
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(s => syncSingleStock(db, s, days))
    );
    for (const n of results) {
      if (n > 0) success++;
      written += n;
    }
    done += batch.length;
    if (onProgress) onProgress(done, pending.length);
  }

  db.close();
  console.log(`[DataSync] Done: +${success} stocks, +${written} rows (total: ${syncedCodes.size + success}/${allStocks.length})`);
  return { total: pending.length, success, written };
}

/**
 * 全量同步（重建模式）：清空后全部重新拉取
 */
export async function syncAllStocks(
  days: number = DAYS_TO_FETCH,
  onProgress?: (done: number, total: number) => void
): Promise<{ total: number; success: number; written: number }> {
  const stocks = loadStockList();
  if (stocks.length === 0) return { total: 0, success: 0, written: 0 };

  console.log(`[DataSync] Full sync: ${stocks.length} stocks, ${days} days each`);
  const db = new LocalDatabase();
  let written = 0;
  let success = 0;

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(s => syncSingleStock(db, s, days))
    );
    for (const n of results) {
      if (n > 0) success++;
      written += n;
    }
    if (onProgress) onProgress(Math.min(i + CONCURRENCY, stocks.length), stocks.length);
  }

  db.close();
  console.log(`[DataSync] Done: ${success}/${stocks.length} stocks, ${written} rows`);
  return { total: stocks.length, success, written };
}

// ===== CLI =====
if (require.main === module) {
  const cmd = process.argv[2];

  if (cmd === 'rebuild') {
    console.log('[DataSync] REBUILD mode...');
    const db = new LocalDatabase();
    db.clearDailyData();
    db.close();
    syncAllStocks().then(r => {
      console.log(`\n=== Rebuild: ${r.written} rows, ${r.success}/${r.total} stocks ===`);
      process.exit(0);
    });
  } else if (cmd === 'continue') {
    syncRemainingStocks().then(r => {
      console.log(`\n=== Continue: +${r.written} rows, +${r.success}/${r.total} stocks ===`);
      process.exit(0);
    });
  } else if (cmd === 'test') {
    const db = new LocalDatabase();
    const cnt = (db.query('SELECT COUNT(DISTINCT code) as c FROM stock_daily')[0] as any).c;
    console.log(`Current DB: ${cnt} stocks synced`);
    db.close();
  } else if (cmd === 'bj-test') {
    const code = process.argv[3] || '920000';
    const days = parseInt(process.argv[4]) || 200;
    console.log(`[DataSync] BJ test: ${code}, ${days} days via akshare...`);
    (async () => {
      const db = new LocalDatabase();
      const data = await fetchFromAkshare(code, days);
      console.log(`Returned ${data.length} rows`);
      if (data.length > 0) {
        console.log('First:', data[0]);
        console.log('Last:', data[data.length - 1]);
        const klines = toDailyKLines(code, data);
        db.insertDailyKLines(klines);
        console.log(`Inserted ${klines.length} rows for ${code}`);
      }
      db.close();
      process.exit(0);
    })();
  } else {
    console.log(`
Usage: node dist/data/data-sync.js <command>

  rebuild   清空后全量同步（SH/SZ用腾讯，BJ用akshare）
  continue  增量同步尚未入库的股票
  test      查看当前进度
  bj-test   测试单只BJ股票同步
`);
  }
}
