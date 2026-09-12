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
import { CleanDailyDatabase } from "../data/clean-daily";

// ===== Types =====

/** 常用指数 → 市场映射（000001 此处按上证指数解释，非平安银行） */
const INDEX_MARKET: Record<string, 'SH' | 'SZ'> = {
  '000001': 'SH', // 上证指数
  '000300': 'SH', // 沪深300
  '000905': 'SH', // 中证500
  '000016': 'SH', // 上证50
  '399001': 'SZ', // 深证成指
  '399006': 'SZ', // 创业板指
  '399005': 'SZ', // 中小板指
  '399300': 'SZ', // 沪深300(深市代码)
};

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
  /** 前复权日线库（口径统一层）；不可用时为 null，回退原始未复权库 */
  private cleanDb: CleanDailyDatabase | null;

  constructor(db: LocalDatabase, dataFetcher: DataFetcher, cleanDb?: CleanDailyDatabase) {
    this.db = db;
    this.dataFetcher = dataFetcher;
    this.cleanDb = cleanDb && cleanDb.available ? cleanDb : null;
    console.log(
      this.cleanDb
        ? `[DataProvider] 口径=前复权(qfq)，源=${this.cleanDb.path}`
        : '[DataProvider] 口径=原始未复权(raw stock_daily) —— 回测结论需谨慎'
    );
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

    // 前复权 clean 库优先（口径与 bt_avoid_toxic / 毒性排除否决器 / chan service 一致）
    let all: DailyKLine[] = [];
    if (this.cleanDb) {
      all = this.cleanDb.queryKLines({ codes, startDate, endDate });
      const got = new Set(all.map((r) => r.code));
      const missing = codes.filter((c) => !got.has(c));
      if (missing.length > 0) {
        if (missing.length === codes.length) {
          console.warn(`[DataProvider] clean_daily 无这批标的(${codes.length}只)，整体回退原始库（口径不一致）`);
          all = this.db.queryKLines({ codes, startDate, endDate });
        } else {
          console.warn(
            `[DataProvider] clean_daily 缺 ${missing.length}/${codes.length} 只，缺的走原始未复权库（口径不一致）: ${missing.slice(0, 5).join(',')}`
          );
          all = all.concat(this.db.queryKLines({ codes: missing, startDate, endDate }));
        }
      }
    } else {
      all = this.db.queryKLines({ codes, startDate, endDate });
    }

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
        console.warn(`[DataProvider] ${code} not in SQLite, trying DataFetcher...(腾讯前复权, amount/turn 缺失=0)`);
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
    // 1) 原始库 trading_calendar（当前 0 行，保留兼容）
    const dbDays = this.db.getTradingDays(startDate, endDate);
    if (dbDays.length > 0) return dbDays;

    // 2) clean_daily 出现过的日期（精确交易日，避免工作日近似把节假日算进来）
    if (this.cleanDb) {
      const cleanDays = this.cleanDb.getTradingDays(startDate, endDate);
      if (cleanDays.length > 0) return cleanDays;
    }

    // 3) 兜底: generate all weekdays (simplified)
    console.warn(
      `[DataProvider] ⚠️ 交易日历回退到"工作日近似"（原始库/clean_daily 均无数据）: ${startDate}~${endDate} —— 会把节假日算成交易日，回测结果需谨慎`,
    );
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
    // 1) 本地 index_daily（当前 0 行，保留兼容）
    const indexData = this.db.getIndexKLines(code, startDate, endDate);
    if (indexData.length > 0) {
      return indexData;
    }

    // 2) 在线拉指数（腾讯 前复权，指数点位本身无需复权）
    try {
      const market = INDEX_MARKET[code] || (code.startsWith('3') ? 'SZ' : 'SH');
      const days =
        Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 30;
      const res = await this.dataFetcher.fetchIndexKLine(code, market as 'SH' | 'SZ' | 'BJ', Math.max(days, 120));
      const pts = (res?.data || []).filter((d) => d.date >= startDate && d.date <= endDate);
      if (pts.length > 0) {
        console.warn(
          `[DataProvider] benchmark ${code} 来自腾讯在线(${pts.length}点, ${pts[0].date}~${pts[pts.length - 1].date})`
        );
        return pts;
      }
    } catch (err) {
      console.error(`[DataProvider] benchmark ${code} 在线获取失败:`, err);
    }

    // 3) 兜底: return empty array — engine will handle null benchmark
    console.warn(`[DataProvider] No benchmark data for ${code}, benchmark disabled`);
    return [];
  }

  async getMarketSnapshot(date: string): Promise<BacktestKLine[]> {
    // 前复权 clean 库优先（再平衡日选股必须与回测持仓同口径）
    if (this.cleanDb) {
      let cleanRows = this.cleanDb.getExactSnapshot(date);
      if (cleanRows.length === 0) cleanRows = this.cleanDb.getSnapshotAtDate(date);
      if (cleanRows.length > 0) {
        return cleanRows.map((r) => ({
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
      console.warn(`[DataProvider] clean_daily 在 ${date} 无快照，回退原始库（口径不一致）`);
    }

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
