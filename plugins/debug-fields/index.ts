import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'debug-fields',
  name: '调试字段',
  version: '1.0.0',
  description: '查看数据字段',
  strategies: [
    {
      id: 'debug-fields',
      name: '调试字段探测',
      description: '探测数据字段名',
      category: 'short-term',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results = [];
        let count = 0;
        for (const stock of data) {
          if (count >= 3) break;
          const keys = Object.keys(stock).join(', ');
          results.push({
            code: stock.code || 'unknown',
            name: stock.name || 'unknown',
            score: 100,
            signals: [keys],
            metrics: {}
          });
          count++;
        }
        return results;
      },
    }
  ],
};

export default plugin;
