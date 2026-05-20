import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-daytrade-v1',
  name: 'AI做T精选',
  version: '1.0.0',
  description: '专为做T交易设计，筛选振幅大、换手活跃、流动性好的股票',
  strategies: [
    {
      id: 'daytrade-pick',
      name: '做T精选',
      description: '综合振幅、换手、流动性评分，精选适合做T的股票',
      category: 'day-trade',
      params: [
          {
              "key": "minAmplitude",
              "label": "最小振幅(%)",
              "type": "number",
              "default": 3,
              "min": 0,
              "max": 20
          },
          {
              "key": "minTurnover",
              "label": "最小换手率",
              "type": "number",
              "default": 3,
              "min": 0,
              "max": 50
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results=[]; for(const s of data){ let score=0; const signals=[]; const metrics={}; const amp=s.high&&s.low&&s.close?((s.high-s.low)/s.close*100):0; const to=s.turnover||s.turnoverRate||0; if(amp>=(params.minAmplitude||3)){score+=30; signals.push('振幅充足'); metrics.amplitude=parseFloat(amp.toFixed(2));} if(to>=(params.minTurnover||3)){score+=25; signals.push('换手活跃'); metrics.turnover=parseFloat(to.toFixed(2));} const changePct=s.changePercent||0; if(amp>=2&&changePct>0){score+=15; signals.push('有波动空间');} if(s.price>0&&s.price<50){score+=15; signals.push('价位适中'); metrics.price=s.price;} if(to>2&&amp>1.5){score+=15; signals.push('量价配合');} if(score>0){results.push({code:s.code,name:s.name,score,metrics,signals});} } results.sort((a,b)=>b.score-a.score); return results.slice(0,20);
      },
    }
  ],
};

export default plugin;
