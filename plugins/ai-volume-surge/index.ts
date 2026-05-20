import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-volume-surge',
  name: 'AI放量上涨修正版',
  version: '1.0.0',
  description: '修正字段名的放量上涨策略',
  strategies: [
    {
      id: 'volume-surge-fixed',
      name: '放量上涨（修正版）',
      description: '筛选放量上涨的股票，使用正确字段名',
      category: 'short-term',
      params: [
          {
              "key": "minChangePercent",
              "label": "最低涨幅(%)",
              "type": "number",
              "default": 1,
              "min": 0,
              "max": 20
          },
          {
              "key": "minVolumeRatio",
              "label": "最低量比",
              "type": "number",
              "default": 1.5,
              "min": 0.5,
              "max": 10
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results = [];
        for (const s of data) {
          if (s.changePercent > (params.minChangePercent || 1) && s.turnover && s.volume > 0) {
            const avgVolume = 10000000;
            const volumeRatio = s.volume / avgVolume;
            if (volumeRatio > (params.minVolumeRatio || 1.5)) {
              const score = Math.min(100, Math.round(60 + (s.changePercent || 0) * 2 + Math.min(volumeRatio, 5) * 3));
              results.push({
                code: s.code,
                name: s.name,
                score: score,
                signals: ['放量上涨'],
                metrics: {
                  changePct: s.changePercent || 0,
                  volume: s.volume || 0,
                  turnover: s.turnover || 0,
                  turnoverRate: s.turnoverRate || 0
                }
              });
            }
          }
        }
        results.sort((a,b)=>b.score-a.score);
        return results;
      },
    }
  ],
};

export default plugin;
