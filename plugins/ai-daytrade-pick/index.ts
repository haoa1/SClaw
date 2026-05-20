import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-daytrade-pick',
  name: 'AI做T精选',
  version: '1.0.0',
  description: '专注筛选适合日内做T交易的股票：高振幅、高换手、成交量活跃，提供足够的波动空间和流动性',
  strategies: [
    {
      id: 'daytrade-pick',
      name: '做T精选',
      description: '综合振幅、换手、成交量等因子，精选适合做T交易的标的',
      category: 'day-trade',
      params: [
          {
              "key": "minAmplitude",
              "label": "最小振幅(%)",
              "type": "number",
              "default": 3,
              "min": 1,
              "max": 10
          },
          {
              "key": "minTurnover",
              "label": "最小换手率",
              "type": "number",
              "default": 3,
              "min": 1,
              "max": 20
          },
          {
              "key": "maxPrice",
              "label": "最高股价(元)",
              "type": "number",
              "default": 50,
              "min": 5,
              "max": 200
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results=[]; for(const s of data){ const amp=s.high&&s.low&&s.close?((s.high-s.low)/s.close*100):0; const to=s.turnover||0; const chg=s.changePercent||0; if(amp<(params.minAmplitude||3)) continue; if(to<(params.minTurnover||3)) continue; if(s.price>(params.maxPrice||50)) continue; let score=0; const signals=[]; const metrics={}; if(amp>=5){score+=25; signals.push('振幅大');}else if(amp>=3){score+=20; signals.push('振幅适中');} metrics.amplitude=parseFloat(amp.toFixed(2)); if(to>=8){score+=25; signals.push('换手极高');}else if(to>=5){score+=20; signals.push('换手活跃');}else if(to>=3){score+=15; signals.push('换手适中');} metrics.turnover=to; if(chg>0&&chg<5){score+=20; signals.push('温和上涨');}else if(chg>=5&&chg<9){score+=15; signals.push('涨幅偏大');}else if(chg<0){score+=10; signals.push('回调可低吸');} metrics.changePercent=chg; if(s.volume&&s.volume>100000){score+=15; signals.push('量能充足');} metrics.price=s.price; results.push({code:s.code,name:s.name,score,metrics,signals}); } results.sort((a,b)=>b.score-a.score); return results.slice(0,15);
      },
    }
  ],
};

export default plugin;
