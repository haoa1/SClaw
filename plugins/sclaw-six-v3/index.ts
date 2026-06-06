import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'sclaw-six-v3',
  name: 'SClaw六维V3',
  version: '1.0.0',
  description: '涨幅3~5% + 换手5~10% + 市值50~300亿',
  strategies: [
    {
      id: 'six-filters-v3',
      name: '六维精选V3',
      description: '涨幅3~5% + 换手5~10% + 市值50~300亿',
      category: 'short-term',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        for (const item of data) {
          const chg = item.changePercent ?? 0;
          if (chg < 3 || chg > 5) continue;
          const tr = item.turnoverRate ?? 0;
          if (tr < 5 || tr > 10) continue;
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
