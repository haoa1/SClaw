import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'debug-all',
  name: '全量探测',
  version: '1.0.0',
  description: '检查数据范围',
  strategies: [
    {
      id: 'debug-all',
      name: '全量探测',
      description: '检查所有股票的数据范围',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        let maxChg = -100;
        let minChg = 100;
        let maxTr = 0;
        let maxMc = 0;
        for (const item of data) {
          const chg = item.changePercent ?? 0;
          if (chg > maxChg) maxChg = chg;
          if (chg < minChg) minChg = chg;
          const tr = item.turnoverRate ?? 0;
          if (tr > maxTr) maxTr = tr;
          const mc = item.marketCap ?? 0;
          if (mc > maxMc) maxMc = mc;
        }
        // 返回一只代表性股票看看数据
        if (data.length > 0) {
          const first = data[0];
          results.push({
            code: first.code,
            name: first.name,
            score: 100,
            signals: ['范围: chg' + minChg.toFixed(1) + '~' + maxChg.toFixed(1), 'maxTr:' + maxTr.toFixed(2), 'maxMc:' + (maxMc/100000000).toFixed(0) + '亿'],
            metrics: { minChg, maxChg, maxTr, maxMc }
          });
        }
        return results;
      },
    }
  ],
};

export default plugin;
