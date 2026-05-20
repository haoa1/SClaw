/**
 * Backtest API Routes
 *
 * POST /api/backtest/run    — Run a full backtest (synchronous)
 * POST /api/backtest/cache  — Clear backtest cache
 */

import { Router, Request, Response } from 'express';
import { StrategyEngine } from '../strategies/strategy-engine';
import { BacktestEngine } from '../backtest/backtest-engine';
import { BacktestDataProvider } from '../backtest/data-provider';
import { BacktestConfig } from '../types';

export function createBacktestRoutes(
  strategyEngine: StrategyEngine,
  dataProvider: BacktestDataProvider,
): Router {
  const router = Router();

  /**
   * Run a backtest synchronously.
   * POST body: BacktestConfig
   */
  router.post('/api/backtest/run', async (req: Request, res: Response) => {
    try {
      const config = req.body as BacktestConfig;

      // Validate required fields
      if (!config.startDate || !config.endDate) {
        return res.status(400).json({ error: 'startDate and endDate are required' });
      }
      if (!config.strategies || config.strategies.length === 0) {
        return res.status(400).json({ error: 'At least one strategy is required' });
      }
      if (!config.initialCapital || config.initialCapital <= 0) {
        return res.status(400).json({ error: 'initialCapital must be > 0' });
      }
      if (!config.maxPositions || config.maxPositions <= 0) {
        return res.status(400).json({ error: 'maxPositions must be > 0' });
      }

      console.log(`[Backtest API] Starting backtest: ${config.startDate} → ${config.endDate}`);
      console.log(`[Backtest API] Strategies: ${config.strategies.map(s => `${s.pluginId}/${s.strategyId}`).join(', ')}`);

      const engine = new BacktestEngine(strategyEngine, dataProvider);
      const result = await engine.run(config);

      console.log(`[Backtest API] Complete: ${result.summary.totalReturn}% return, ${result.summary.totalTrades} trades`);

      res.json({
        success: true,
        result,
      });
    } catch (err: any) {
      console.error('[Backtest API] Error:', err);
      res.status(500).json({ error: err.message || 'Backtest failed' });
    }
  });

  /**
   * Get a default backtest configuration template.
   */
  router.get('/api/backtest/config', (_req: Request, res: Response) => {
    const defaultConfig: Partial<BacktestConfig> = {
      startDate: '2024-01-01',
      endDate: '2025-12-31',
      strategies: [],
      rebalanceFrequency: 'monthly',
      initialCapital: 100000,
      maxPositions: 10,
      commission: 0.0003,
    };
    res.json(defaultConfig);
  });

  return router;
}
