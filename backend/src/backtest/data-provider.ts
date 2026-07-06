/**
 * BacktestDataProvider — abstraction layer between BacktestEngine and data sources.
 *
 * Provides unified interface for:
 *   - Stock info and K-line data (SQLite first, DataFetcher fallback)
 *   - Trading calendar
 *   - Benchmark index data (沪深300/上证指数/创业板指/深证成指)
 *   - Market snapshots for rebalancing
 */

import { LocalDatabase, DailyKLine, StockInfo } from "../data/local-database";
import { DataFetcher } from "../data/data-fetcher";

// ===== Types =====

export interface BacktestKLine {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  changePct: number;
  turnoverRate: number;
}

export interface BenchmarkPoint {
  date: string;
  close: number;
}

export interface MarketSnapshot {
  date: string;
  stocks: BacktestKLine[];
}

export interface BacktestDataProvider {
  /** Get stock info by code */
  getStockInfo(code: string): StockInfo | null;

  /** Batch get K-line data for one or more stocks */
  getKLineBatch(
    codes: string[],
    startDate: string,
    endDate: string
  ): Promise<Map<string, BacktestKLine[]>>;

  /** Get trading calendar between dates */
  getTradingCalendar(startDate: string, endDate: string): Promise<string[]>;

  /** Get benchmark index data */
  getBenchmarkData(
    code: string,
    startDate: string,
    endDate: string
  ): Promise<BenchmarkPoint[]>;

  /** Get a snapshot of all stocks at a given date (for rebalancing) */
  getMarketSnapshot(date: string): Promise<BacktestKLine[]>;

  /** Get stock list */
  getStockList(): StockInfo[];
}

// ===== Default implementation =====

export class LocalDBDataProvider implements BacktestDataProvider {
  private db: LocalDatabase;
  private dataFetcher: DataFetcher;

  constructor(db: LocalDatabase, dataFetcher: DataFetcher) {
    this.db = db;
    this.dataFetcher = dataFetcher;
  }

  getStockInfo(code: string): StockInfo | null {
    return this.db.getStockInfo(code) || null;
  }

  async getKLineBatch(
    codes: string[],
    startDate: string,
    endDate: string
  ): Promise<Map<string, BacktestKLine[]>> {
    const result = new Map<string, BacktestKLine[]>();

    // Try SQLite first
    const all = this.db.queryKLines({ codes, startDate, endDate });

    // Group by code
    for (const row of all) {
      if (!result.has(row.code)) {
        result.set(row.code, []);
      }
      result.get(row.code)!.push({
        code: row.code,
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        amount: row.amount,
        changePct: row.changePct,
        turnoverRate: row.turnoverRate,
      });
    }

    // Fallback: fetch from network for missing stocks
    for (const code of codes) {
      if (!result.has(code)) {
        console.warn(`[DataProvider] ${code} not in SQLite, trying DataFetcher...`);
        // Try fetching from network (only for SH/SZ stocks)
        const market = code.startsWith("6") ? "SH" as const : "SZ" as const;
        try {
          // Estimate days needed from date range
          const start = new Date(startDate);
          const end = new Date(endDate);
          const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
          const klineResult = await this.dataFetcher.fetchKLine(code, market, Math.max(days, 120));
          const kline = klineResult.data;
          if (kline && kline.length > 0) {
            result.set(
              code,
              kline.map((k) => ({
                code,
                date: k.date,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume,
                amount: 0,
                changePct: 0,
                turnoverRate: 0,
              }))
            );
          }
        } catch (err) {
          console.error(`[DataProvider] Failed to fetch ${code} from network:`, err);
        }
      }
    }

    return result;
  }

  async getTradingCalendar(
    startDate: string,
    endDate: string
  ): Promise<string[]> {
    // Try SQLite first
    const dbDays = this.db.getTradingDays(startDate, endDate);
    if (dbDays.length > 0) return dbDays;

    // Fallback: generate all weekdays (simplified)
    const days: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    const current = new Date(start);

    while (current <= end) {
      const dayOfWeek = current.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        days.push(current.toISOString().slice(0, 10));
      }
      current.setDate(current.getDate() + 1);
    }

    return days;
  }

  async getBenchmarkData(
    code: string,
    startDate: string,
    endDate: string
  ): Promise<BenchmarkPoint[]> {
    // Try SQLite index_daily table first
    const indexData = this.db.getIndexKLines(code, startDate, endDate);
    if (indexData.length > 0) {
      return indexData;
    }

    // Fallback: return empty array — engine will handle null benchmark
    console.warn(`[DataProvider] No benchmark data for ${code}, benchmark disabled`);
    return [];
  }

  async getMarketSnapshot(date: string): Promise<BacktestKLine[]> {
    const rows = this.db.getExactSnapshot(date);
    if (rows.length > 0) {
      return rows.map((r) => ({
        code: r.code,
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        amount: r.amount,
        changePct: r.changePct,
        turnoverRate: r.turnoverRate,
      }));
    }

    // Try nearest date
    const nearest = this.db.getSnapshotAtDate(date);
    return nearest.map((r) => ({
      code: r.code,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      amount: r.amount,
      changePct: r.changePct,
      turnoverRate: r.turnoverRate,
    }));
  }

  getStockList(): StockInfo[] {
    return this.db.getAllStockInfos();
  }
}

/** No-op implementation for testing */
export class NullDataProvider implements BacktestDataProvider {
  getStockInfo(_code: string): StockInfo | null {
    return null;
  }

  async getKLineBatch(_codes: string[], _start: string, _end: string): Promise<Map<string, BacktestKLine[]>> {
    return new Map();
  }

  async getTradingCalendar(_start: string, _end: string): Promise<string[]> {
    return [];
  }

  async getBenchmarkData(_code: string, _start: string, _end: string): Promise<BenchmarkPoint[]> {
    return [];
  }

  async getMarketSnapshot(_date: string): Promise<BacktestKLine[]> {
    return [];
  }

  getStockList(): StockInfo[] {
    return [];
  }
}
