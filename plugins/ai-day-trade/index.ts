import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-day-trade',
  name: 'AI做T精选策略',
  version: '1.0.0',
  description: '专门筛选适合日内做T的股票：振幅大、换手活跃、价格适中、流动性好',
  strategies: [
    {
      id: 'day-trade-pick',
      name: '做T精选',
      description: '精选适合日内做T的股票 - 振幅大、换手活跃、价格适中',
      category: 'day-trade',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results=[]; for(const s of data){ let score=0; const signals=[]; const metrics={}; const changePct=s.changePercent||0; const to=s.turnover||0; const amp=s.high&&s.low&&s.close?((s.high-s.low)/s.close*100):0; const price=s.price||0; if(amp>3){score+=25; signals.push('振幅活跃');} else if(amp>2){score+=15; signals.push('振幅适中');} metrics.amplitude=parseFloat(amp.toFixed(2)); if(to>3){score+=25; signals.push('换手活跃');} else if(to>2){score+=15; signals.push('换手适中');} metrics.turnover=to; if(price>5&&price<50){score+=15; signals.push('价格适中');} else if(price>=50&&price<100){score+=10; signals.push('价格偏高');} else if(price<=5&&price>0){score+=10; signals.push('低价股');} metrics.price=price; if(changePct>-2&&changePct<5){score+=20; signals.push('波动空间充足');} else if(changePct>=-5&&changePct<=-2){score+=15; signals.push('下跌有反弹空间');} metrics.changePercent=changePct; if(score>0){results.push({code:s.code,name:s.name,score,metrics,signals});} } results.sort((a,b)=>b.score-a.score); return results.slice(0,20);
      },
    }
  ],
};

export default plugin;
