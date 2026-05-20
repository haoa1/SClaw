import { Router, Request, Response } from 'express';
import { PluginManager } from '../plugin-system/plugin-manager';
import { StrategyEngine } from '../strategies/strategy-engine';
import { DataFetcher } from '../data/data-fetcher';
import { ScreenRequest, PluginInfo, StrategyInfo, ScreenResponse } from '../types';

export function createRoutes(
  pluginManager: PluginManager,
  strategyEngine: StrategyEngine,
  dataFetcher: DataFetcher
): Router {
  const router = Router();

  // ========== 插件管理 API ==========

  /** 获取所有插件列表 */
  router.get('/api/plugins', (_req: Request, res: Response) => {
    const plugins = pluginManager.getAll();
    const result: PluginInfo[] = plugins.map(p => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      strategyCount: p.strategies.length,
      enabled: true,
      strategies: p.strategies.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        pluginId: p.id,
        params: s.params,
        enabled: true,
      })),
    }));
    res.json({ plugins: result });
  });

  /** 获取所有可用策略 */
  router.get('/api/strategies', (_req: Request, res: Response) => {
    const strategies = strategyEngine.getAvailableStrategies();
    res.json({ strategies });
  });

  // ========== 选股执行 API ==========

  /** 执行选股 */
  router.post('/api/screen', async (req: Request, res: Response) => {
    try {
      const request = req.body as ScreenRequest;

      if (!request.strategies || request.strategies.length === 0) {
        res.status(400).json({ error: 'At least one strategy is required' });
        return;
      }

      // Auto-resolve pluginId: if a strategy's pluginId doesn't match any loaded plugin,
      // search all plugins for a strategy with that ID and use its actual pluginId
      const allPlugins = pluginManager.getAll();
      for (const item of request.strategies) {
        const pluginExists = allPlugins.some(p => p.id === item.pluginId);
        if (!pluginExists) {
          // Try to find the correct plugin by searching for this strategy ID in all plugins
          for (const plugin of allPlugins) {
            const strategy = plugin.strategies.find(s => s.id === item.strategyId || s.id === item.pluginId);
            if (strategy) {
              console.log(`[API Screen] Auto-resolved: ${item.pluginId}/${item.strategyId} -> ${plugin.id}/${strategy.id}`);
              item.pluginId = plugin.id;
              item.strategyId = strategy.id;
              break;
            }
          }
        }
      }

      // 获取全市场数据
      const allStocks = await dataFetcher.fetchAllStocks(request.market);

      // 执行策略
      const { results } = await strategyEngine.execute(allStocks, request);

      const response: ScreenResponse = {
        results,
        stats: {
          totalStocks: allStocks.length,
          matchedStocks: results.length,
          executionTime: 0, // 在 StrategyEngine 里已经内部计时
        },
      };

      res.json(response);
    } catch (err) {
      console.error('[API] Screen error:', err);
      res.status(500).json({ error: 'Screen execution failed', detail: String(err) });
    }
  });

  // ========== 数据管理 API ==========

  /** 刷新数据缓存 */
  router.post('/api/data/refresh', async (_req: Request, res: Response) => {
    dataFetcher.clearCache();
    try {
      const stocks = await dataFetcher.fetchAllStocks();
      res.json({ message: 'Data refreshed', count: stocks.length });
    } catch (err) {
      res.status(500).json({ error: 'Data refresh failed', detail: String(err) });
    }
  });

  /** 获取个股K线数据 */
  router.get('/api/stock/:code/kline', async (req: Request, res: Response) => {
    const { code } = req.params;
    const market = (req.query.market as 'SH' | 'SZ') || 'SH';
    const days = parseInt(req.query.days as string) || 120;

    try {
      const kline = await dataFetcher.fetchKLine(code, market, days);
      res.json({ code, market, data: kline });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch K-line data', detail: String(err) });
    }
  });

  /** 健康检查 */
  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      pluginCount: pluginManager.getAll().length,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
