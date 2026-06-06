import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'debug-plugin',
  name: '调试插件',
  version: '1.0.0',
  description: '调试数据字段',
  strategies: [
    {
      id: 'debug-data',
      name: '数据探测',
      description: '数据探测',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        let count = 0;
        for (const stock of data) {
          if (count >= 5) break;
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
