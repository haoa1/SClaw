import { Router, Request, Response } from 'express';
import { PluginManager } from '../plugin-system/plugin-manager';
import { StrategyEngine } from '../strategies/strategy-engine';
import { DataFetcher } from '../data/data-fetcher';
import { ScreenRequest, PluginInfo, StrategyInfo, ScreenResponse } from '../types';
import { enrichWithHistory } from '../tools/strategy-validator';

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

      // ===== 两阶段数据增强：先前4条件预过滤，再对少量候选股补充涨停数据 =====

      /** 用策略参数做预过滤（条件1-4：涨跌幅、量比、换手、市值） */
      function preFilterConds1to4(stocks: any[], strategies: ScreenRequest['strategies']): any[] {
        // 从请求中提取 dt-filter 的参数
        const dtCfg = strategies.find(s =>
          s.pluginId === 'sclaw-dt-filter' || s.strategyId === 'dt-filter'
        );
        const p = dtCfg?.params || {};
        const minChg = p.minChange ?? 3;
        const maxChg = p.maxChange ?? 5;
        const minVolRatio = p.minVolumeRatio ?? 1;
        const minTr = p.minTurnover ?? 5;
        const maxTr = p.maxTurnover ?? 10;
        const minMcapYi = p.minMcap ?? 50;
        const maxMcapYi = p.maxMcap ?? 300;

        return stocks.filter(stock => {
          const chg = stock.changePercent ?? 0;
          if (chg < minChg || chg > maxChg) return false;
          let vr = stock.volumeRatio ?? 0;
          if (vr < 0.1 || vr > 1000) {
            vr = (stock.volume && stock.avgVolume) ? stock.volume / stock.avgVolume : 0;
          }
          if (vr < minVolRatio) return false;
          let tr = stock.turnoverRate ?? 0;
          if (tr > 100) tr = tr / 100;
          if (tr < minTr || tr > maxTr) return false;
          const mcapYi = (stock.marketCap ?? 0) / 100000000;
          if (mcapYi < minMcapYi || mcapYi > maxMcapYi) return false;
          return true;
        });
      }

      // 第1步：前4条件预过滤 → 一般缩到 < 100 只
      const candidates = preFilterConds1to4(allStocks, request.strategies);

      // 第2步：只对候选股做数据增强（涨停基因检测）→ 快！
      if (candidates.length > 0) {
        await enrichWithHistory(candidates);
        // 把增强结果同步回全量数据（不满足前4条件的直接标记 false）
        const enriched = new Map(candidates.map(s => [s.code, s]));
        for (const stock of allStocks) {
          stock.limitUpIn20Days = enriched.get(stock.code)?.limitUpIn20Days ?? false;
        }
      } else {
        for (const stock of allStocks) stock.limitUpIn20Days = false;
      }

      console.log(`[API Screen] Pre-filter: ${allStocks.length} → ${candidates.length} candidates, enriched + merged`);

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
      const { data, meta } = await dataFetcher.fetchKLine(code, market, days);
      res.json({ code, market, data, meta });
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
