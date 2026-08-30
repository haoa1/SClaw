import { Router, Request, Response } from 'express';
import { PluginManager } from '../plugin-system/plugin-manager';
import { StrategyEngine } from '../strategies/strategy-engine';
import { DataFetcher } from '../data/data-fetcher';
import { ScreenRequest, PluginInfo, StrategyInfo, ScreenResponse } from '../types';
import { enrichWithHistory } from '../tools/strategy-validator';
import { analyzeStock, quickSummary } from '../chan/service';

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
        // 从请求中提取过滤参数（dt-filter / chip-structure 等自定义策略）
        const dtCfg = strategies.find(s =>
          s.pluginId === 'sclaw-dt-filter' || s.strategyId === 'dt-filter'
        );
        const chipCfg = strategies.find(s =>
          s.pluginId === 'chip-structure' || s.strategyId === 'chip-structure-best' || s.pluginId === 'chip-score' || s.strategyId === 'chip-score-main'
        );
        const p = { ...(dtCfg?.params || {}), ...(chipCfg?.params || {}) };
        const minChg = p.minChange ?? (chipCfg ? 0 : 3);
        const maxChg = p.maxChange ?? (chipCfg ? 5 : 5);
        const minVolRatio = p.minVolumeRatio ?? (chipCfg ? 0.8 : 1);
        const minTr = p.minTurnover ?? (chipCfg ? 2 : 5);
        const maxTr = p.maxTurnover ?? (chipCfg ? 15 : 10);
        const minMcapYi = p.minMcap ?? (chipCfg ? 0 : 50);
        const maxMcapYi = p.maxMcap ?? (chipCfg ? 10000 : 300);

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

      // === 缠论策略：自动预取K线数据 ===
      const hasChanStrategy = request.strategies.some(s =>
        s.pluginId === 'chan-buy-points' ||
        s.strategyId === 'chan-first-buy' ||
        s.strategyId === 'chan-second-buy' ||
        s.pluginId === 'chan-theory-screener' ||
        s.pluginId === 'chip-structure' || s.pluginId === 'chip-score'
      );
      const needs30min = request.strategies.some(s =>
        s.strategyId === 'chan-second-buy'
      );

      if (hasChanStrategy && candidates.length > 0) {
        const t0 = Date.now();
        console.log(`[API Screen] Chan theory detected, fetching K-line for ${candidates.length} candidates...`);

        // Helper: detect market
        const detectMkt = (code: string) =>
          (code.startsWith('6') || code.startsWith('9')) ? 'SH' as const : 'SZ' as const;

        // Step 1: 批量拉日K线（SQLite快，高并发20）
        const CONCURRENCY = 20;
        for (let i = 0; i < candidates.length; i += CONCURRENCY) {
          await Promise.all(candidates.slice(i, i + CONCURRENCY).map(async (stock: any) => {
            const mkt = detectMkt(stock.code);
            try {
              const { data: daily } = await dataFetcher.fetchKLine(stock.code, mkt, 120);
              stock.kline = daily;
            } catch { stock.kline = []; }
          }));
        }

        // Step 2: 30分K线（网络调用，独立分批）
        if (needs30min) {
          console.log(`[API Screen] Fetching 30min K-line for ${candidates.length} candidates...`);
          const CONCURRENCY_30 = 10;
          for (let i = 0; i < candidates.length; i += CONCURRENCY_30) {
            await Promise.all(candidates.slice(i, i + CONCURRENCY_30).map(async (stock: any) => {
              try {
                const { data: m30 } = await dataFetcher.fetchKLineByPeriod(stock.code, detectMkt(stock.code), 200, 30);
                stock.kline30min = m30;
              } catch { stock.kline30min = []; }
            }));
          }
        }
        // Sync to all stocks
        const klineMap = new Map(candidates.map(s => [s.code, { kline: s.kline, kline30min: s.kline30min }]));
        for (const stock of allStocks) {
          const kl = klineMap.get(stock.code);
          if (kl) {
            stock.kline = kl.kline;
            stock.kline30min = kl.kline30min;
          } else {
            stock.kline = [];
            stock.kline30min = [];
          }
        }
        console.log(`[API Screen] K-line attached: ${candidates.length} candidates, needs30min=${needs30min}`);
      } else if (hasChanStrategy) {
        for (const stock of allStocks) {
          stock.kline = [];
          stock.kline30min = [];
        }
      }

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

  /** 获取个股K线数据（支持日线/分钟线） */
  router.get('/api/stock/:code/kline', async (req: Request, res: Response) => {
    const { code } = req.params;
    // 市场自动检测
    const rawMarket = (req.query.market as string || '').toUpperCase();
    let market: 'SH' | 'SZ' | 'BJ';
    if (['SH', 'SZ', 'BJ'].includes(rawMarket)) {
      market = rawMarket as 'SH' | 'SZ' | 'BJ';
    } else {
      if (code.startsWith('6') || code.startsWith('9')) market = 'SH';
      else if (code.startsWith('8')) market = 'BJ';
      else market = 'SZ';
    }
    const days = parseInt(req.query.days as string) || 120;
    const period = parseInt(req.query.period as string) || 240;
    const VALID_PERIODS = [240, 60, 30, 15, 5];
    if (!VALID_PERIODS.includes(period)) {
      res.status(400).json({ error: `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}` });
      return;
    }

    const periodLabel = period === 240 ? '日线' : period === 60 ? '60分钟' : period === 30 ? '30分钟' : period === 15 ? '15分钟' : period === 5 ? '5分钟' : `${period}分钟`;

    try {
      if (period === 240) {
        const { data, meta } = await dataFetcher.fetchKLine(code, market, days);
        res.json({ code, market, period, periodLabel, data, meta });
      } else {
        const result = await dataFetcher.fetchKLineByPeriod(code, market, days, period);
        res.json({ code, market, period, periodLabel, data: result.data });
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to fetch ${periodLabel} data`, detail: String(err) });
    }
  });

  /** 缠论分析 API */
  /** GET /api/chan/:code?level=daily|m30|m60&limit=300 — 完整缠论标注 */
  router.get('/api/chan/:code', (req: Request, res: Response) => {
    const { code } = req.params;
    const level = (req.query.level as string || 'daily') as 'daily' | 'm30' | 'm60';
    const limit = parseInt(req.query.limit as string) || 300;
    if (!['daily', 'm30', 'm60'].includes(level)) {
      res.status(400).json({ error: `Invalid level. Must be one of: daily, m30, m60` });
      return;
    }
    try {
      const analysis = analyzeStock(code, level, limit);
      res.json(analysis);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /api/chan/summary/:code?level=daily|m30|m60 — 简易摘要（批量扫描用） */
  router.get('/api/chan/summary/:code', (req: Request, res: Response) => {
    const { code } = req.params;
    const level = (req.query.level as string || 'daily') as 'daily' | 'm30' | 'm60';
    if (!['daily', 'm30', 'm60'].includes(level)) {
      res.status(400).json({ error: `Invalid level. Must be one of: daily, m30, m60` });
      return;
    }
    res.json(quickSummary(code, level));
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
