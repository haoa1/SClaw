import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-short-term',
  name: 'AI短线精选',
  version: '1.0.0',
  description: '综合多个短线因子的精选策略：放量 + 换手活跃 + 涨幅健康 + 跳空高开，综合评分选前10',
  strategies: [
    {
      id: 'short-term-pick',
      name: '短线精选',
      description: '综合放量、换手、涨幅、跳空等多因子评分，精选短线优质标的',
      category: 'short-term',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results=[]; for(const s of data){ let score=0; const signals=[]; const metrics={}; if(s.changePct>0&&s.turnover>1.5){score+=20; signals.push('放量上涨'); metrics.turnover=s.turnover; metrics.changePct=s.changePct;} if(s.turnover>=3){score+=20; signals.push('换手活跃');} if(s.open>0&&s.price>0){ const gap=(s.price-s.open)/s.open*100; if(gap>0.5){score+=20; signals.push('跳空高开'); metrics.gap=parseFloat(gap.toFixed(2));}} if(s.changePct>2){score+=20; signals.push('涨幅健康');} if(s.changePct>0&&s.changePct<9.5){score+=20; signals.push('非涨停稳健');} if(score>0){results.push({code:s.code,name:s.name,score,metrics,signals});} } results.sort((a,b)=>b.score-a.score); return results.slice(0,10);
      },
    }
  ],
};

export default plugin;
