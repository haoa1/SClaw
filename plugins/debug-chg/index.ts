import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'debug-chg',
  name: '调试涨幅',
  version: '1.0.0',
  description: '仅筛选涨幅3~5%',
  strategies: [
    {
      id: 'chg-only',
      name: '仅涨幅3~5%',
      description: '仅涨幅3~5%',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        for (const item of data) {
          const chg = item.changePercent ?? 0;
          if (chg >= 3 && chg <= 5) {
            results.push({
              code: item.code,
              name: item.name,
              score: 80,
              signals: ['涨幅' + chg.toFixed(1) + '%'],
              metrics: { changePercent: chg }
            });
          }
        }
        return results;
      },
    }
  ],
};

export default plugin;
