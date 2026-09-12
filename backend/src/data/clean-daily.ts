/**
 * CleanDailyDatabase — 前复权日线只读访问层
 *
 * 数据源: data/clean_daily.db :: daily (code,date,open,high,low,close,volume,amount,turn)
 *   由 scripts/fetch_daily_clean.py 生成，全量前复权(qfq)，amount/turn 齐全。
 *
 * 口径说明:
 *   - 价格 = 前复权 (qfq)，与 bt_avoid_toxic / 毒性排除否决器 / chan service 一致
 *   - 原始 stock_history.db::stock_daily 是未复权且 amount/turnover 全空，
 *     任何基于 amount/turnover 的过滤在原始库上都是静默失效的 —— 故此处只读 clean 库
 *   - changePct 由相邻交易日收盘价现算（clean 库无 change_pct 列），
 *     查询时自动多取 30 个自然日的 lookback 用于首个 bar 的涨跌幅计算，返回前裁掉
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { DailyKLine, KLineQuery } from './local-database';

/** clean_daily.db 候选路径（按优先级） */
export const CLEAN_DAILY_CANDIDATES: string[] = [
  path.resolve(__dirname, '../../data/clean_daily.db'),
  path.resolve(process.cwd(), 'data/clean_daily.db'),
  '/root/sclaw/backend/data/clean_daily.db',
];

export function findCleanDailyDb(): string | null {
  for (const p of CLEAN_DAILY_CANDIDATES) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 1_000_000) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 'YYYY-MM-DD' 偏移 n 个自然日 */
function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** changePct = (close / prevClose - 1) * 100，保留 4 位 */
function pct(close: number, prevClose: number | null | undefined): number {
  if (!prevClose || prevClose <= 0 || !close) return 0;
  return Math.round((close / prevClose - 1) * 10000) / 100;
}

export class CleanDailyDatabase {
  private db: Database.Database | null = null;
  private _path: string | null = null;

  constructor(dbPath?: string) {
    const p = dbPath || findCleanDailyDb();
    if (!p) {
      console.warn('[CleanDaily] clean_daily.db 未找到，前复权日线不可用');
      return;
    }
    try {
      this.db = new Database(p, { readonly: true, fileMustExist: true });
      this._path = p;
      console.log(`[CleanDaily] Opened (readonly, qfq): ${p}`);
    } catch (err) {
      console.error(`[CleanDaily] 打开失败: ${p}`, err);
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  get path(): string | null {
    return this._path;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }

  /** 批量查询前复权日线（含 changePct 计算） */
  queryKLines(query: KLineQuery): DailyKLine[] {
    if (!this.db) return [];
    const { startDate, endDate } = query;
    const lookbackStart = shiftDate(startDate, -30);

    const params: any[] = [lookbackStart, endDate];
    let codeClause = '';
    if (query.code) {
      codeClause = 'AND code = ?';
      params.push(query.code);
    } else if (query.codes && query.codes.length > 0) {
      codeClause = `AND code IN (${query.codes.map(() => '?').join(',')})`;
      params.push(...query.codes);
    }

    const rows = this.db
      .prepare(
        `SELECT code, date, open, high, low, close, volume, amount, turn
         FROM daily
         WHERE date >= ? AND date <= ? ${codeClause}
         ORDER BY code, date`
      )
      .all(...params) as Array<{
      code: string;
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      amount: number;
      turn: number;
    }>;

    const out: DailyKLine[] = [];
    let lastCode = '';
    let prevClose: number | null = null;
    for (const r of rows) {
      if (r.code !== lastCode) {
        lastCode = r.code;
        prevClose = null;
      }
      const changePct = pct(r.close, prevClose);
      prevClose = r.close;
      if (r.date < startDate) continue; // 裁掉 lookback
      out.push({
        code: r.code,
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume || 0,
        amount: r.amount || 0,
        changePct,
        turnoverRate: r.turn || 0,
      });
    }
    return out;
  }

  /** 单个股票的前复权日线序列 */
  getStockKLines(code: string, startDate?: string, endDate?: string): DailyKLine[] {
    return this.queryKLines({
      code,
      startDate: startDate || '1990-01-01',
      endDate: endDate || new Date().toISOString().slice(0, 10),
    });
  }

  /** 指定日期的全市场快照（精确匹配，changePct 由 SQL 关联上一交易日算出） */
  getExactSnapshot(date: string): DailyKLine[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT d.code, d.date, d.open, d.high, d.low, d.close, d.volume, d.amount, d.turn,
                (SELECT p.close FROM daily p
                  WHERE p.code = d.code AND p.date < d.date
                  ORDER BY p.date DESC LIMIT 1) AS prevClose
         FROM daily d
         WHERE d.date = ?`
      )
      .all(date) as Array<any>;
    return rows.map((r) => ({
      code: r.code,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume || 0,
      amount: r.amount || 0,
      changePct: pct(r.close, r.prevClose),
      turnoverRate: r.turn || 0,
    }));
  }

  /** 不晚于 targetDate 的最近交易日快照 */
  getSnapshotAtDate(targetDate: string): DailyKLine[] {
    if (!this.db) return [];
    const row = this.db
      .prepare('SELECT MAX(date) AS d FROM daily WHERE date <= ?')
      .get(targetDate) as { d: string | null } | undefined;
    if (!row?.d) return [];
    return this.getExactSnapshot(row.d);
  }

  /** 交易日列表（用 clean 库出现过的日期近似，避免依赖空的 trading_calendar） */
  getTradingDays(startDate: string, endDate: string): string[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT DISTINCT date FROM daily WHERE date >= ? AND date <= ? ORDER BY date')
      .all(startDate, endDate) as Array<{ date: string }>;
    return rows.map((r) => r.date);
  }

  getDateRange(): { minDate: string; maxDate: string; totalDays: number } {
    if (!this.db) return { minDate: '', maxDate: '', totalDays: 0 };
    const row = this.db
      .prepare('SELECT MIN(date) AS minDate, MAX(date) AS maxDate, COUNT(DISTINCT date) AS totalDays FROM daily')
      .get() as any;
    return row || { minDate: '', maxDate: '', totalDays: 0 };
  }
}
