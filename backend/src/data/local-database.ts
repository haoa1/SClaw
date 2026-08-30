/**
 * Local SQLite Database — 本地数据仓库
 *
 * Stores historical stock data for backtesting.
 * Schema designed for fast queries by date and stock code.
 *
 * Tables:
 *   - stock_info:       股票基本信息 (code, name, market)
 *   - stock_daily:      日K线数据 (核心表，code+date 复合主键)
 *   - trading_calendar: 交易日历
 *   - data_sync_log:    数据同步日志
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

// ===== Types =====

export interface StockInfo {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
}

export interface DailyKLine {
  code: string;
  date: string;        // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;      // 成交量（股）
  amount: number;      // 成交额（元）
  changePct: number;   // 涨跌幅 %
  turnoverRate: number; // 换手率 %
}

export interface KLineQuery {
  code?: string;
  codes?: string[];
  startDate: string;
  endDate: string;
}

export interface SyncLogEntry {
  id?: number;
  source: 'tushare';
  date: string;           // YYYY-MM-DD
  stockCount: number;
  status: 'success' | 'partial' | 'failed';
  message?: string;
  syncedAt: string;
}

export interface TradingCalendarEntry {
  date: string;
  isTradingDay: boolean;
}

// ===== Database Class =====

export class LocalDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbDir?: string) {
    const dir = dbDir || path.resolve(__dirname, '../../data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.dbPath = path.join(dir, 'stock_history.db');
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.initializeSchema();
    console.log(`[LocalDatabase] Opened: ${this.dbPath}`);
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  // ===== Schema =====

  private initializeSchema(): void {
    this.db.exec(`
      -- 股票基本信息
      CREATE TABLE IF NOT EXISTS stock_info (
        code    TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        market  TEXT NOT NULL CHECK(market IN ('SH', 'SZ', 'BJ'))
      );

      -- 日K线数据
      CREATE TABLE IF NOT EXISTS stock_daily (
        code          TEXT NOT NULL,
        date          TEXT NOT NULL,  -- 'YYYY-MM-DD'
        open          REAL NOT NULL DEFAULT 0,
        high          REAL NOT NULL DEFAULT 0,
        low           REAL NOT NULL DEFAULT 0,
        close         REAL NOT NULL DEFAULT 0,
        volume        INTEGER NOT NULL DEFAULT 0,
        amount        REAL NOT NULL DEFAULT 0,
        change_pct    REAL DEFAULT 0,
        turnover_rate REAL DEFAULT 0,
        PRIMARY KEY (code, date)
      );

      -- 日K线数据索引
      CREATE INDEX IF NOT EXISTS idx_stock_daily_date ON stock_daily(date);
      CREATE INDEX IF NOT EXISTS idx_stock_daily_code_date ON stock_daily(code, date);

      -- 交易日历
      CREATE TABLE IF NOT EXISTS trading_calendar (
        date           TEXT PRIMARY KEY,  -- 'YYYY-MM-DD'
        is_trading_day INTEGER NOT NULL DEFAULT 1
      );

      -- 数据同步日志
      CREATE TABLE IF NOT EXISTS data_sync_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source       TEXT NOT NULL,
        date         TEXT NOT NULL,
        stock_count  INTEGER DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'success',
        message      TEXT,
        synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 市场指数数据（用于基准对比）
      CREATE TABLE IF NOT EXISTS index_daily (
        code  TEXT NOT NULL,  -- '000300.SH' = 沪深300
        date  TEXT NOT NULL,
        close REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (code, date)
      );
    `);
  }

  // ===== Stock Info =====

  /** 批量插入/更新股票基本信息 */
  upsertStockInfos(stocks: StockInfo[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO stock_info (code, name, market)
      VALUES (?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const s of stocks) {
        stmt.run(s.code, s.name, s.market);
      }
    });
    tx();
  }

  /** 获取所有股票信息 */
  getAllStockInfos(): StockInfo[] {
    return this.db.prepare('SELECT code, name, market FROM stock_info ORDER BY code').all() as StockInfo[];
  }

  /** 获取单只股票信息 */
  getStockInfo(code: string): StockInfo | undefined {
    return this.db.prepare('SELECT code, name, market FROM stock_info WHERE code = ?').get(code) as StockInfo | undefined;
  }

  /** 获取股票数量 */
  getStockCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM stock_info').get() as any;
    return row.count;
  }

  // ===== Daily K-Line =====

  /** 批量插入日K线数据（使用事务） */
  insertDailyKLines(items: DailyKLine[]): void {
    if (items.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO stock_daily (code, date, open, high, low, close, volume, amount, change_pct, turnover_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.code, item.date,
          item.open, item.high, item.low, item.close,
          item.volume, item.amount,
          item.changePct, item.turnoverRate
        );
      }
    });
    tx();
  }

  /** 批量插入（原始数组格式，用于迁移脚本） */
  insertDailyKLinesRaw(rows: Array<{
    code: string; date: string;
    open: number; high: number; low: number; close: number;
    volume: number; amount: number;
    changePct: number; turnoverRate: number;
  }>): void {
    this.insertDailyKLines(rows);
  }

  /** 查询指定日期范围内的K线数据 */
  queryKLines(query: KLineQuery): DailyKLine[] {
    const params: any[] = [];
    let whereClause = '';

    if (query.code) {
      whereClause = 'AND sd.code = ?';
      params.push(query.code);
    } else if (query.codes && query.codes.length > 0) {
      whereClause = `AND sd.code IN (${query.codes.map(() => '?').join(',')})`;
      params.push(...query.codes);
    }

    params.push(query.startDate, query.endDate);

    return this.db.prepare(`
      SELECT sd.code, sd.date, sd.open, sd.high, sd.low, sd.close,
             sd.volume, sd.amount, sd.change_pct as changePct, sd.turnover_rate as turnoverRate
      FROM stock_daily sd
      WHERE sd.date >= ? AND sd.date <= ? ${whereClause}
      ORDER BY sd.code, sd.date
    `).all(...params.reverse()) as DailyKLine[];
  }

  /** 获取某只股票的完整K线序列 */
  getStockKLines(code: string, startDate?: string, endDate?: string): DailyKLine[] {
    const params: any[] = [code];
    let dateFilter = '';

    if (startDate) {
      dateFilter += ' AND sd.date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND sd.date <= ?';
      params.push(endDate);
    }

    return this.db.prepare(`
      SELECT sd.code, sd.date, sd.open, sd.high, sd.low, sd.close,
             sd.volume, sd.amount, sd.change_pct as changePct, sd.turnover_rate as turnoverRate
      FROM stock_daily sd
      WHERE sd.code = ? ${dateFilter}
      ORDER BY sd.date
    `).all(...params) as DailyKLine[];
  }

  /**
   * 获取指定日期所有股票的行情快照（最接近该日期的数据）
   * 用于回测中的再平衡日
   */
  getSnapshotAtDate(targetDate: string): DailyKLine[] {
    return this.db.prepare(`
      SELECT code, date, open, high, low, close,
             volume, amount, change_pct as changePct, turnover_rate as turnoverRate
      FROM stock_daily
      WHERE date = (
        SELECT MAX(date) FROM stock_daily WHERE date <= ?
      )
    `).all(targetDate) as DailyKLine[];
  }

  /**
   * 获取指定日期所有股票的行情快照（精确匹配，更快）
   */
  getExactSnapshot(date: string): DailyKLine[] {
    return this.db.prepare(`
      SELECT code, date, open, high, low, close,
             volume, amount, change_pct as changePct, turnover_rate as turnoverRate
      FROM stock_daily
      WHERE date = ?
    `).all(date) as DailyKLine[];
  }

  /** 检查某日期是否有数据 */
  hasDateData(date: string): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM stock_daily WHERE date = ?').get(date) as any;
    return row.cnt > 0;
  }

  /** 获取数据覆盖的日期范围 */
  getDateRange(): { minDate: string; maxDate: string; totalDays: number } {
    const row = this.db.prepare(`
      SELECT MIN(date) as minDate, MAX(date) as maxDate, COUNT(DISTINCT date) as totalDays
      FROM stock_daily
    `).get() as any;
    return row || { minDate: '', maxDate: '', totalDays: 0 };
  }

  /** 获取数据覆盖的股票数量 */
  getStocksWithDataCount(date?: string): number {
    if (date) {
      const row = this.db.prepare('SELECT COUNT(DISTINCT code) as cnt FROM stock_daily WHERE date = ?').get(date) as any;
      return row.cnt;
    }
    const row = this.db.prepare('SELECT COUNT(DISTINCT code) as cnt FROM stock_daily').get() as any;
    return row.cnt;
  }

  // ===== Trading Calendar =====

  /** 批量插入交易日历 */
  insertTradingDays(dates: string[]): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO trading_calendar (date, is_trading_day) VALUES (?, 1)');
    const tx = this.db.transaction(() => {
      for (const d of dates) {
        stmt.run(d);
      }
    });
    tx();
  }

  /** 获取两个日期之间的所有交易日 */
  getTradingDays(startDate: string, endDate: string): string[] {
    const rows = this.db.prepare(`
      SELECT date FROM trading_calendar
      WHERE date >= ? AND date <= ? AND is_trading_day = 1
      ORDER BY date
    `).all(startDate, endDate) as Array<{ date: string }>;
    return rows.map(r => r.date);
  }

  /** 判断某天是否为交易日 */
  isTradingDay(date: string): boolean {
    const row = this.db.prepare('SELECT is_trading_day FROM trading_calendar WHERE date = ?').get(date) as any;
    return row?.is_trading_day === 1;
  }

  // ===== Sync Log =====

  /** 记录同步日志 */
  logSync(entry: Omit<SyncLogEntry, 'id' | 'syncedAt'>): void {
    this.db.prepare(`
      INSERT INTO data_sync_log (source, date, stock_count, status, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.source, entry.date, entry.stockCount, entry.status, entry.message || null);
  }

  /** 获取同步日志 */
  getSyncLog(limit: number = 20): SyncLogEntry[] {
    return this.db.prepare(`
      SELECT id, source, date, stock_count as stockCount, status, message, synced_at as syncedAt
      FROM data_sync_log
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as SyncLogEntry[];
  }

  /** 检查某日期是否已同步过 */
  isDateSynced(date: string, source: string): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM data_sync_log
      WHERE date = ? AND source = ? AND status = 'success'
    `).get(date, source) as any;
    return row.cnt > 0;
  }

  /** 检查某日期是否为 0 股的成功记录（最近30天内，需要重试补齐） */
  isZeroStockDate(date: string, source: string = 'tushare'): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM data_sync_log
      WHERE date = ? AND source = ? AND status = 'success' AND stock_count = 0
        AND date > date('now', '-30 days')
    `).get(date, source) as any;
    return row.cnt > 0;
  }

  // ===== Index Data (for benchmark) =====

  /** 插入指数日线数据 */
  insertIndexDaily(code: string, date: string, close: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO index_daily (code, date, close) VALUES (?, ?, ?)
    `).run(code, date, close);
  }

  /** 批量插入指数数据 */
  insertIndexDailyBatch(items: Array<{ code: string; date: string; close: number }>): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO index_daily (code, date, close) VALUES (?, ?, ?)');
    const tx = this.db.transaction(() => {
      for (const item of items) {
        stmt.run(item.code, item.date, item.close);
      }
    });
    tx();
  }

  /** 获取指数数据 */
  getIndexKLines(code: string, startDate: string, endDate: string): Array<{ date: string; close: number }> {
    return this.db.prepare(`
      SELECT date, close FROM index_daily
      WHERE code = ? AND date >= ? AND date <= ?
      ORDER BY date
    `).all(code, startDate, endDate) as Array<{ date: string; close: number }>;
  }

  // ===== Raw Query (for DataManager advanced queries) =====

  /** 执行原始 SQL 查询（仅限 DataManager 内部使用） */
  query<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** 执行原始 SQL 并返回单行 */
  queryOne<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  // ===== Utility =====

  /** 获取数据库统计信息 */
  getStats(): { stocks: number; dailyRecords: number; dateRange: string; indexCount: number; dbSizeMB: number } {
    const stockCount = this.getStockCount();
    const dailyCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM stock_daily').get() as any).cnt;
    const dateRange = this.getDateRange();
    const indexCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM index_daily').get() as any).cnt;
    const stats = fs.statSync(this.dbPath);
    return {
      stocks: stockCount,
      dailyRecords: dailyCount,
      dateRange: dateRange.totalDays > 0 ? `${dateRange.minDate} ~ ${dateRange.maxDate} (${dateRange.totalDays} days)` : 'empty',
      indexCount,
      dbSizeMB: Math.round((stats.size / 1024 / 1024) * 100) / 100,
    };
  }

  /** 清空所有数据 */
  clearAll(): void {
    this.db.exec(`
      DELETE FROM stock_daily;
      DELETE FROM stock_info;
      DELETE FROM trading_calendar;
      DELETE FROM data_sync_log;
      DELETE FROM index_daily;
    `);
    this.db.exec('VACUUM');
    console.log('[LocalDatabase] All data cleared');
  }

  /** 清空K线数据（保留股票信息） */
  clearDailyData(): void {
    this.db.exec('DELETE FROM stock_daily');
    this.db.exec('VACUUM');
    console.log('[LocalDatabase] Daily K-line data cleared');
  }
}
