import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'simple-volume-surge',
  name: '简易放量上涨',
  version: '1.0.0',
  description: '简易放量上涨选股，使用正确字段名',
  strategies: [
    {
      id: 'simple-volume-surge',
      name: '简易放量上涨',
      description: '筛选涨幅>0且成交额较大的股票',
      category: 'short-term',
      params: [
          {
              "key": "minChange",
              "label": "最低涨幅(%)",
              "type": "number",
              "default": 1,
              "min": 0,
              "max": 20
          },
          {
              "key": "minTurnover",
              "label": "最低成交额(元)",
              "type": "number",
              "default": 50000000,
              "min": 0,
              "max": 10000000000
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results = [];
        for (const s of data) {
          const changePct = typeof s.changePercent === 'number' ? s.changePercent : 0;
          const minC = Number(params.minChange) || 1;
          const minT = Number(params.minTurnover) || 50000000;
          if (changePct > minC && s.turnover > minT) {
            const volRatio = s.volume ? s.turnover / 100000000 : 0;
            const score = Math.min(100, Math.round(60 + changePct * 3 + Math.min(volRatio, 3)));
            results.push({
              code: s.code,
              name: s.name,
              score: score,
              signals: ['放量上涨'],
              metrics: {
                changePercent: changePct,
                volume: s.volume || 0,
                turnover: s.turnover || 0
              }
            });
          }
        }
        results.sort((a,b)=>b.score-a.score);
        return results;
      },
    }
  ],
};

export default plugin;
