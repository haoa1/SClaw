import { StockScreenerPlugin, StockData, FilterResult, ScreenRequest } from '../types';

export class StrategyEngine {
  private plugins: () => StockScreenerPlugin[];

  constructor(pluginGetter: () => StockScreenerPlugin[]) {
    this.plugins = pluginGetter;
  }

  /** 执行选股 */
  async execute(
    allStocks: StockData[],
    request: ScreenRequest
  ): Promise<{ results: FilterResult[]; pluginResults: Map<string, FilterResult[]> }> {
    const startTime = Date.now();
    const pluginResults = new Map<string, FilterResult[]>();
    const combineMode = request.combineMode || 'score'; // 'score' | 'union'

    // 收集每条策略的结果
    const allResults: { strategyId: string; items: FilterResult[] }[] = [];

    for (const item of request.strategies) {
      const plugin = this.plugins().find(p => p.id === item.pluginId);
      if (!plugin) {
        console.warn(`[StrategyEngine] Plugin not found: ${item.pluginId}`);
        continue;
      }

      const strategy = plugin.strategies.find(s => s.id === item.strategyId);
      if (!strategy) {
        console.warn(`[StrategyEngine] Strategy not found: ${item.pluginId}/${item.strategyId}`);
        continue;
      }

      try {
        const strategyResults = strategy.execute(allStocks, item.params);
        allResults.push({ strategyId: `${item.pluginId}/${item.strategyId}`, items: strategyResults });
        pluginResults.set(`${item.pluginId}/${item.strategyId}`, strategyResults);
        console.log(
          `[StrategyEngine] ${item.pluginId}/${item.strategyId}: ${strategyResults.length}/${allStocks.length} matched`
        );
      } catch (err) {
        console.error(`[StrategyEngine] Error executing ${item.pluginId}/${item.strategyId}:`, err);
      }
    }

    // 合并结果
    let results: FilterResult[];
    if (request.strategies.length <= 1 || combineMode === 'union') {
      // 单个策略或 union 模式：直接拼接
      results = allResults.flatMap(r => r.items);
    } else {
      // score 模式：按股票去重统计，只保留命中至少 3 条策略的股票
      const totalStrategies = request.strategies.length;
      const minStrategies = Math.min(totalStrategies, Math.max(3, Math.round(totalStrategies * 0.4)));

      const combined = new Map<string, { result: FilterResult; scoreSum: number; hitCount: number }>();
      for (const { items } of allResults) {
        for (const item of items) {
          const key = `${item.code}_${item.name}`;
          if (combined.has(key)) {
            const existing = combined.get(key)!;
            existing.scoreSum += item.score;
            existing.hitCount++;
            item.signals.forEach(s => {
              if (!existing.result.signals.includes(s)) existing.result.signals.push(s);
            });
            Object.assign(existing.result.metrics, item.metrics);
          } else {
            combined.set(key, { result: { ...item }, scoreSum: item.score, hitCount: 1 });
          }
        }
      }

      // 过滤：只保留命中 >= minStrategies 条策略的股票
      results = Array.from(combined.entries())
        .filter(([_, v]) => v.hitCount >= minStrategies)
        .map(([_, { result, scoreSum, hitCount }]) => ({
          ...result,
          score: Math.min(100, Math.round(hitCount * 16 + (hitCount >= 4 ? 10 : 0))), // 命中>3条额外加分
          signals: [...result.signals, `命中${hitCount}/${totalStrategies}条策略`],
        }))
        .sort((a, b) => b.score - a.score);
    }

    const executionTime = Date.now() - startTime;
    console.log(`[StrategyEngine] Done in ${executionTime}ms, ${results.length} total matches (mode: ${combineMode})`);

    return { results, pluginResults };
  }

  /** 获取所有可用的策略信息 */
  getAvailableStrategies(): Array<{
    pluginId: string;
    pluginName: string;
    strategyId: string;
    strategyName: string;
    description: string;
    category: string;
    params: any[];
  }> {
    const list: any[] = [];
    for (const plugin of this.plugins()) {
      for (const strategy of plugin.strategies) {
        list.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          strategyId: strategy.id,
          strategyName: strategy.name,
          description: strategy.description,
          category: strategy.category,
          params: strategy.params,
        });
      }
    }
    return list;
  }
}
