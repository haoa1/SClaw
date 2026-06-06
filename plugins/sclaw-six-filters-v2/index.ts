import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'sclaw-six-filters-v2',
  name: 'SClaw六维精选V2',
  version: '1.0.0',
  description: '综合3个条件的短线精选策略：涨幅3~5% + 换手5~10% + 市值50~300亿',
  strategies: [
    {
      id: 'six-filters-v2',
      name: '六维精选V2',
      description: '六维精选V2',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        for (const item of data) {
          // 条件1: 当日涨幅3%~5%
          const chg = item.changePercent ?? 0;
          if (chg < 3 || chg > 5) continue;

          // 条件2: 换手率5%~10%
          const tr = item.turnoverRate ?? 0;
          if (tr < 5 || tr > 10) continue;

          // 条件3: 总市值50~300亿 (marketCap单位是元,转为亿)
          const mcap = item.marketCap ?? 0;
          const mcapYi = mcap / 100000000;
          if (mcapYi < 50 || mcapYi > 300) continue;

          results.push({
            code: item.code,
            name: item.name,
            score: 80,
            signals: ['涨幅' + chg.toFixed(1) + '%', '换手' + tr.toFixed(1) + '%', '市值' + mcapYi.toFixed(0) + '亿'],
            metrics: { changePercent: chg, turnoverRate: tr, marketCapYi: mcapYi }
          });
        }
        return results;
      },
    }
  ],
};

export default plugin;
