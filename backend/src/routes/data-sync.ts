/**
 * Data Sync Routes — expose DataManager operations via HTTP API
 *
 * Provides:
 *   POST /api/data/sync          — Full sync (migrate + fetch gaps)
 *   POST /api/data/sync/names    — Sync stock names from stock_basic
 *   POST /api/data/sync/benchmark — Sync benchmark indexes
 *   GET  /api/data/status        — Data coverage status
 */

import { Router } from 'express';
import { DataManager } from '../data/data-manager';
import { LocalDatabase } from '../data/local-database';

export function createDataSyncRoutes(
  localDb: LocalDatabase,
  dataDir: string,
  tushareToken: string
): Router {
  const router = Router();

  // ===== POST /api/data/sync =====
  router.post('/sync', async (_req, res) => {
    try {
      const manager = new DataManager(localDb, { tushareToken, dataDir });
      const result = await manager.syncAll();
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== POST /api/data/sync/names =====
  router.post('/sync/names', async (_req, res) => {
    try {
      const manager = new DataManager(localDb, { tushareToken, dataDir });
      const count = await manager.syncStockNames();
      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== POST /api/data/sync/benchmark =====
  router.post('/sync/benchmark', async (_req, res) => {
    try {
      const manager = new DataManager(localDb, { tushareToken, dataDir });
      await manager.syncBenchmarkIndexes();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== GET /api/data/status =====
  router.get('/status', async (_req, res) => {
    try {
      const manager = new DataManager(localDb, { tushareToken, dataDir });
      const coverage = await manager.getDateCoverage();
      const dateRange = localDb.getDateRange();
      const stockCount = localDb.query<{ cnt: number }>('SELECT COUNT(DISTINCT code) as cnt FROM stock_daily');
      res.json({
        success: true,
        coverage,
        dateRange,
        totalStocks: stockCount[0]?.cnt || 0,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
