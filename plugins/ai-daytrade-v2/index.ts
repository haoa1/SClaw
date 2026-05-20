import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-daytrade-v2',
  name: 'AI做T精选V2',
  version: '1.0.0',
  description: '专为日内做T交易设计的精选策略，综合振幅、换手率、涨幅等多因子评分',
  strategies: [
    {
      id: 'daytrade-pick',
      name: '做T精选',
      description: '综合振幅、换手、涨幅评分，选出适合日内做T的活跃股票',
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
          },
          {
              "key": "maxPrice",
              "label": "最高价格(元)",
              "type": "number",
              "default": 50,
              "min": 0,
              "max": 500
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results=[]; for(const s of data){ const amp=s.high&&s.low&&s.close?((s.high-s.low)/s.close*100):0; const to=s.turnover||0; const chg=Math.abs(s.changePercent||0); if(amp<(params.minAmplitude||3))continue; if(to<(params.minTurnover||3))continue; if((s.price||999)>(params.maxPrice||50))continue; let score=0; const signals=[]; const metrics={}; metrics.amplitude=parseFloat(amp.toFixed(2)); metrics.turnover=to; metrics.changePercent=s.changePercent||0; if(amp>=5){score+=25; signals.push('振幅大');}else if(amp>=3){score+=15; signals.push('有振幅');} if(to>=8){score+=25; signals.push('换手极高');}else if(to>=5){score+=20; signals.push('换手活跃');}else if(to>=3){score+=10; signals.push('换手适中');} if(chg>0&&chg<3){score+=20; signals.push('温和上涨');}else if(chg>=3&&chg<7){score+=20; signals.push('涨幅适中');}else if(chg>=7&&chg<9.5){score+=15; signals.push('强势');} if(s.price&&s.price>0&&s.price<20){score+=15; signals.push('低价易操作');}else if(s.price&&s.price>=20&&s.price<50){score+=10; signals.push('价格适中');} if(score>0){results.push({code:s.code,name:s.name,score,metrics,signals});} } results.sort((a,b)=>b.score-a.score); return results.slice(0,20);
      },
    }
  ],
};

export default plugin;
