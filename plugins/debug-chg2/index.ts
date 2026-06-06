import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'debug-chg2',
  name: '调试涨幅2',
  version: '1.0.0',
  description: '探测涨幅1~10%',
  strategies: [
    {
      id: 'chg-wide',
      name: '涨幅探测',
      description: '涨幅探测',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        for (const item of data) {
          const chg = item.changePercent ?? 0;
          if (chg >= 1 && chg <= 10) {
            results.push({
              code: item.code,
              name: item.name,
              score: 60,
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
