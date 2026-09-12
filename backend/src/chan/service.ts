/**
 * 缠论分析服务 — 从 SQLite 读取 K 线数据并运行缠论引擎
 */
import path from 'path';
import fs from 'fs';
import { analyzeChan, computeMACD } from './engine';
import { ChanAnalysis, KLine } from './types';

// 多路径探测：生产数据目录优先（backend/data 下有一个 4KB 空占位库）
const DB_CANDIDATES = [
  '/root/sclaw/data/stock_history.db',                      // 生产数据目录（1.9GB 真实库）
  '/root/sclaw/backend/data/stock_history.db',               // 旧空占位库
  path.resolve(__dirname, '../../data/stock_history.db'),   // 开发目录
  path.resolve(__dirname, '../../../data/stock_history.db'),
];
function pickDb(): string {
  for (const p of DB_CANDIDATES) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) return p; // 只选 >1MB 的真实库
    } catch { /* ignore */ }
  }
  return '/root/sclaw/data/stock_history.db';
}
const DB_PATH = pickDb();

/**
 * 前复权干净库（2026-09-12 口径统一）——读取优先，原始库仅作回退
 * 与回测 / 毒性排除 / data-fetcher 同一口径，避免"日线前复权 × 30m 未复权"的跨口径拼接
 */
const CLEAN_DBS: Record<string, string[]> = {
  daily: [
    '/root/sclaw/backend/data/clean_daily.db',
    path.resolve(__dirname, '../../data/clean_daily.db'),
  ],
  m30: [
    '/root/sclaw/backend/data/clean_m30.db',
    path.resolve(__dirname, '../../data/clean_m30.db'),
  ],
  m60: [
    '/root/sclaw/backend/data/clean_m60.db',
    path.resolve(__dirname, '../../data/clean_m60.db'),
  ],
};
const CLEAN_TABLES: Record<string, string> = { daily: 'daily', m30: 'm30', m60: 'm60' };

/** 干净库 K 线读取（前复权）；取不到返回 null 以便回退原始库 */
function queryCleanKLine(level: 'daily' | 'm30' | 'm60', code: string, limit: number): KLine[] | null {
  const table = CLEAN_TABLES[level];
  const timeCol = level === 'daily' ? 'date' : 'datetime';
  for (const p of CLEAN_DBS[level] || []) {
    try {
      if (!fs.existsSync(p) || fs.statSync(p).size < 1024 * 1024) continue; // 未建好/空库 → 跳过
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const db = new Database(p, { readonly: true, timeout: 3000 });
      try {
        const rows = db.prepare(
          `SELECT ${timeCol} AS date, open, high, low, close, volume
           FROM ${table}
           WHERE code = ?
           ORDER BY ${timeCol} DESC
           LIMIT ?`,
        ).all(code, limit) as DbKLine[];
        if (rows.length > 0) {
          return rows.reverse().map(r => ({
            date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
          }));
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[ChanService] clean ${level} read failed (${p}):`, (err as any)?.message || err);
    }
  }
  return null;
}

interface DbKLine {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 查询 K 线（本地 SQLite） */
function queryKLine(
  table: 'stock_daily' | 'stock_kline_30m' | 'stock_kline_60m',
  code: string,
  limit: number,
): KLine[] {
  try {
    if (!fs.existsSync(DB_PATH)) {
      console.warn(`[ChanService] DB not found: ${DB_PATH}`);
      return [];
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    try {
      // 分钟表列名为 datetime（与日线 date 不同）
      const timeCol = table === 'stock_daily' ? 'date' : 'datetime';
      const rows = db.prepare(
        `SELECT ${timeCol} AS date, open, high, low, close, volume
         FROM ${table}
         WHERE code = ?
         ORDER BY ${timeCol} DESC
         LIMIT ?`,
      ).all(code, limit) as DbKLine[];
      // 反转成时间正序
      return rows.reverse().map(r => ({
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }));
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[ChanService] queryKLine error for ${code} in ${table}:`, err);
    return [];
  }
}

/** 获取股票名称 */
export function getStockName(code: string): string | null {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare(
        'SELECT name FROM stock_info WHERE code = ?',
      ).get(code) as { name?: string } | undefined;
      return row?.name ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * 运行缠论分析
 * @param code 股票代码，如 "600000"
 * @param level daily | m30 | m60
 * @param limit K线数量（默认 300）
 */
export function analyzeStock(
  code: string,
  level: 'daily' | 'm30' | 'm60' = 'daily',
  limit = 300,
): ChanAnalysis {
  // 口径统一：优先读前复权干净库；不到（未建好/无该股）才回退原始库并在信号上打标
  const table = level === 'daily' ? 'stock_daily' : level === 'm30' ? 'stock_kline_30m' : 'stock_kline_60m';
  let klines = queryCleanKLine(level, code, limit);
  let caliber = 'qfq';
  if (!klines || klines.length < 30) {
    const raw = queryKLine(table, code, limit);
    if (!klines || raw.length > klines.length) { klines = raw; caliber = 'raw-fallback'; }
  }
  if (!klines || klines.length < 30) {
    throw new Error(`K线数据不足 (${klines ? klines.length : 0}/${limit})，可能代码不存在或数据未同步: ${code} @ ${level}`);
  }
  const analysis = analyzeChan(klines, code, level);
  // 附加股票名称 + 数据口径（供上游判断是否跨口径）
  (analysis as any).name = getStockName(code) || code;
  (analysis as any).caliber = caliber;
  return analysis;
}

/** 简易输出：只返回 summary（用于批量扫描） */
export function quickSummary(
  code: string,
  level: 'daily' | 'm30' | 'm60' = 'daily',
  limit = 200,
): any {
  try {
    const a = analyzeStock(code, level, limit);
    return {
      code,
      name: (a as any).name || code,
      level,
      caliber: (a as any).caliber,
      trend: a.trend,
      buyPoints: a.summary.buyPoints,
      sellPoints: a.summary.sellPoints,
      biCount: a.summary.biCount,
      zhongshuCount: a.summary.zhongshuCount,
      lastPrice: a.lastPrice,
      lastDate: a.lastDate,
      signals: a.summary.signals,
    };
  } catch (err: any) {
    return { code, error: err.message };
  }
}

export { computeMACD };
