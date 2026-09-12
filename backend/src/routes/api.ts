import { Router, Request, Response } from 'express';
import { PluginManager } from '../plugin-system/plugin-manager';
import { StrategyEngine } from '../strategies/strategy-engine';
import { DataFetcher } from '../data/data-fetcher';
import { ScreenRequest, PluginInfo, StrategyInfo, ScreenResponse } from '../types';
import { enrichWithHistory } from '../tools/strategy-validator';
import { analyzeStock, quickSummary } from '../chan/service';
import { fetchRegimeData, determineRegime } from '../tools/regime';

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
        // chip 类策略历史默认更宽（0/5, 0.8, 2/15, 0/10000亿），保持原语义
        const chipDefaults = {
          minChange: 0, maxChange: 5, minVolumeRatio: 0.8,
          minTurnover: 2, maxTurnover: 15, minMcap: 0, maxMcap: 10000,
        };
        return applyConds1to4(stocks, chipCfg ? { ...chipDefaults, ...p } : p);
      }

      /**
       * 条件1-4 通用实现（涨跌幅 / 量比 / 换手 / 市值，市值单位=亿）。
       * 供「全局预过滤」与「策略腿画像」共用 —— 不同策略可以进不同的候选池。
       */
      function applyConds1to4(stocks: any[], p: any): any[] {
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

      // ===== 第1步：按「策略腿」各建各的候选池（不同策略进不同候选池）=====
      // 背景：缠论一买 = 底背离，发生在「下跌末端」，天然要求标的是在跌/微涨。
      // 而全局 preFilter 默认 涨幅 3~5% → 只有「今天在涨」的票才进池 →
      // 它们日线 MACD hist 必为正 → 与买点引擎「日线共振 + 绿柱」闸门数学互斥，
      // 缠论腿因此结构性 100% 全灭（候选池缺陷 §9）。
      // 修法：腿级画像（决定谁进池）+ 腿级 K 线预取目标（决定谁被喂数据）。
      const LEG_TARGET_PROFILES: Record<string, any> = {
        // 左侧一买：下跌/微涨末端，量比不设高门槛（缩量底更常见），剔除仙股与巨无霸
        'chan-first-buy': {
          minChange: -6, maxChange: 1, minVolumeRatio: 0.4,
          minTurnover: 1, maxTurnover: 25, minMcap: 15, maxMcap: 600, limit: 120,
        },
        'chan-second-buy': {
          minChange: -4, maxChange: 3, minVolumeRatio: 0.4,
          minTurnover: 1, maxTurnover: 25, minMcap: 15, maxMcap: 600, limit: 120,
        },
        'chan-macd-regime': {
          minChange: -6, maxChange: 1, minVolumeRatio: 0.4,
          minTurnover: 1, maxTurnover: 25, minMcap: 15, maxMcap: 600, limit: 120,
        },
        'chan-macd-lite': {
          minChange: -6, maxChange: 1, minVolumeRatio: 0.4,
          minTurnover: 1, maxTurnover: 25, minMcap: 15, maxMcap: 600, limit: 120,
        },
      };
      const legPools: Record<string, { pool: number; used: number }> = {};
      const legSets: any[][] = [];
      for (const st of request.strategies) {
        const key = st.strategyId || st.pluginId;
        const prof = (st.params && st.params.targetFilter)
          || LEG_TARGET_PROFILES[key] || LEG_TARGET_PROFILES[st.pluginId];
        if (!prof) continue;  // 未声明画像 → 不参与腿级建池（走全局兜底）
        let pool = applyConds1to4(allStocks, prof);
        const rawSize = pool.length;
        const cap = prof.limit ?? 0;
        if (cap > 0 && pool.length > cap) {
          // 超限：按成交额降序取前 N（流动性优先，天然滤掉仙股）
          pool = pool.slice()
            .sort((a, b) => ((b.amount ?? b.turnover ?? b.volume ?? 0) - (a.amount ?? a.turnover ?? a.volume ?? 0)))
            .slice(0, cap);
        }
        legPools[key] = { pool: rawSize, used: pool.length };
        legSets.push(pool);
      }

      // 显式携带全局过滤参数的策略（dt-filter / chip-*）→ 保留其全局过滤意图
      const hasGlobalFilterIntent = request.strategies.some(s =>
        s.pluginId === 'sclaw-dt-filter' || s.strategyId === 'dt-filter' ||
        s.pluginId === 'chip-structure' || s.strategyId === 'chip-structure-best' ||
        s.pluginId === 'chip-score' || s.strategyId === 'chip-score-main'
      );

      const globalCandidates = preFilterConds1to4(allStocks, request.strategies);
      const poolParts = hasGlobalFilterIntent ? [...legSets, globalCandidates] : legSets;
      // 没有任何腿声明画像 且 无全局过滤意图 → 完全回落旧行为
      const candidates = poolParts.length === 0
        ? globalCandidates
        : Array.from(new Map(poolParts.flat().map(s => [s.code, s])).values());
      if (Object.keys(legPools).length > 0) {
        console.log(`[API Screen] Leg pools: ${JSON.stringify(legPools)} → union ${candidates.length} candidates`);
      }

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
        s.pluginId === 'chip-structure' || s.pluginId === 'chip-score' ||
        s.pluginId === 'chan-macd-regime' || s.pluginId === 'chan-macd-lite' ||
        s.strategyId === 'chan-macd-regime' || s.strategyId === 'chan-macd-lite'
      );
      const needs30min = request.strategies.some(s =>
        s.strategyId === 'chan-second-buy'
      );
      const hasDabanStrategy = request.strategies.some(s =>
        s.pluginId === 'daban-limit-up' || s.strategyId === 'daban-board-recognition'
      );

      // 预取目标：缠论→候选股；打板→当日涨停股（preFilter 3~5% 会漏掉涨停股，需单独圈出）
      // 涨停阈值与插件 daban-limit-up 对齐：创业/科创 19.5、北交所 29.5、ST 4.8、主板 9.8
      const limitUpThreshold = (stock: any): number => {
        const code = stock.code || '';
        const name = stock.name || '';
        if (/^(300|301|302|688|689)/.test(code)) return 19.5;
        if (/^(8|92)/.test(code)) return 29.5;
        if (/ST/i.test(name)) return 4.8;
        return 9.8;
      };
      const dabanTargets = hasDabanStrategy
        ? allStocks.filter((s: any) => (s.changePercent ?? 0) >= limitUpThreshold(s))
        : [];
      // 缠论+打板同时启用时取并集（去重），避免 chan 候选被降级
      // P3-12: 预取目标数设上限，避免极端行情涨停股过多导致分钟级阻塞
      const klineTargets = hasDabanStrategy && hasChanStrategy
        ? Array.from(new Map([...candidates, ...dabanTargets].map(s => [s.code, s])).values())
        : (hasDabanStrategy ? dabanTargets : candidates);
      const klineTargetsCapped = klineTargets.slice(0, 200);

      if ((hasChanStrategy || hasDabanStrategy) && klineTargetsCapped.length > 0) {
        const t0 = Date.now();
        console.log(`[API Screen] K-line strategy detected, fetching K-line for ${klineTargetsCapped.length} targets...`);

        // Helper: detect market（优先用数据源已填的 market 字段，兼容北交所 BJ）
        const detectMkt = (stock: any): 'SH' | 'SZ' | 'BJ' => {
          const mkt = stock.market;
          if (mkt === 'SH' || mkt === 'SZ' || mkt === 'BJ') return mkt;
          const code = stock.code || '';
          if (/^(92)/.test(code)) return 'BJ';   // 北交所新号段（先于 9 开头判断）
          if (code.startsWith('6') || code.startsWith('9')) return 'SH';
          if (/^(8|4)/.test(code)) return 'BJ';
          return 'SZ';
        };

        // 用已拉取的日K计算20日内涨停基因（打板目标不在 candidates，enrich 不会覆盖）
        const hasLimitUpIn20Days = (kl: any[], stock: any): boolean => {
          if (!Array.isArray(kl) || kl.length < 2) return false;
          // 跳过最后一根（当日涨停bar），只看此前20根已收盘bar，避免「近期活跃」恒生效
          const end = kl.length - 2;
          const start = Math.max(1, end - 20);
          const t = limitUpThreshold(stock);
          for (let i = start; i <= end; i++) {
            const prev = kl[i - 1]?.close ?? 0;
            if (prev <= 0) continue;
            const pc = ((kl[i].close - prev) / prev) * 100;
            if (pc >= t - 0.1) return true;
          }
          return false;
        };

        // Step 1: 批量拉日K线（SQLite快，高并发20）
        const CONCURRENCY = 20;
        for (let i = 0; i < klineTargetsCapped.length; i += CONCURRENCY) {
          await Promise.all(klineTargetsCapped.slice(i, i + CONCURRENCY).map(async (stock: any) => {
            const mkt = detectMkt(stock);
            try {
              const { data: daily } = await dataFetcher.fetchKLine(stock.code, mkt, 120);
              stock.kline = daily;
              // 打板目标不在 candidates，enrichWithHistory 不会覆盖 → 用日K自行计算20日涨停基因
              if (hasDabanStrategy) stock.limitUpIn20Days = hasLimitUpIn20Days(daily, stock);
            } catch { stock.kline = []; }
          }));
        }

        // Step 2: 30分K线（网络调用，独立分批）
        if (needs30min) {
          console.log(`[API Screen] Fetching 30min K-line for ${klineTargetsCapped.length} candidates...`);
          const CONCURRENCY_30 = 10;
          for (let i = 0; i < klineTargetsCapped.length; i += CONCURRENCY_30) {
            await Promise.all(klineTargetsCapped.slice(i, i + CONCURRENCY_30).map(async (stock: any) => {
              try {
                const { data: m30 } = await dataFetcher.fetchKLineByPeriod(stock.code, detectMkt(stock), 200, 30);
                stock.kline30min = m30;
              } catch { stock.kline30min = []; }
            }));
          }
        }
        // Sync to all stocks
        const klineMap = new Map(klineTargetsCapped.map(s => [s.code, { kline: s.kline, kline30min: s.kline30min }]));
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
        // 同步打板目标的20日涨停基因回全量数据
        const limitUpMap = new Map(klineTargetsCapped.map(s => [s.code, s.limitUpIn20Days ?? false]));
        for (const stock of allStocks) {
          if (limitUpMap.has(stock.code)) stock.limitUpIn20Days = limitUpMap.get(stock.code);
        }
        console.log(`[API Screen] K-line attached: ${klineTargetsCapped.length} targets, needs30min=${needs30min}`);
      } else if (hasChanStrategy || hasDabanStrategy) {
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

  // ========== 大盘 regime API ==========

  /**
   * POST /api/market-regime — 判定大盘 regime（牛/震荡/熊/冰点）并给出依据。
   *
   * 这是 market_regime MCP tool 的 REST 镜像（复用同一 fetchRegimeData 逻辑），
   * 供 scout.py / 外部脚本经 HTTP 读取大盘环境（scout_regime 曾误调此路由→404）。
   * Body (可选): { index_code?: string, days?: number }
   */
  router.post('/api/market-regime', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { index_code?: string; indexCode?: string; days?: number; at?: string };
      const indexCode = (body.index_code || body.indexCode || '000001').trim();
      const days = typeof body.days === 'number' && body.days > 0 ? body.days : 60;
      // at 可选：按指定时刻做「时段归一」复算（缺省=服务器当前时间），便于回放/验证
      const at = body.at ? new Date(body.at) : new Date();
      const now = isNaN(at.getTime()) ? new Date() : at;
      const { regime: result, snapshot } = await fetchRegimeData(dataFetcher, indexCode, days, now);
      // 档位映射（与 MCP tool 的 tierLabel 一致）
      const tierMap: Record<string, number> = { '牛': 1, '震荡': 2, '熊': 3, '冰点': 3 };
      res.json({
        regime: result.regime,
        tier: tierMap[result.regime] ?? null,
        metrics: result.metrics,
        basis: result.basis,
        snapshot: {
          advanceCount: snapshot.advanceCount,
          declineCount: snapshot.declineCount,
          limitUpCount: snapshot.limitUpCount,
          limitDownCount: snapshot.limitDownCount,
          totalTurnover: snapshot.totalTurnover,
          universeCount: snapshot.universeCount,
          isFullMarket: snapshot.isFullMarket,
          turnoverNote: snapshot.turnoverNote,
        },
      });
    } catch (err) {
      console.error('[API] market-regime error:', err);
      res.status(500).json({ error: 'Market regime failed', detail: String(err) });
    }
  });

  return router;
}
