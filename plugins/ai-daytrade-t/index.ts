import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-daytrade-t',
  name: 'AI做T精选',
  version: '1.0.0',
  description: '专为做T（日内交易）设计的精选策略，综合振幅、换手率、涨幅、价格等因素',
  strategies: [
    {
      id: 'daytrade-t-pick',
      name: '做T精选',
      description: '综合振幅、换手、涨幅、价格，选出最适合做T的股票',
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
              "max": 1000
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results=[]; for(const s of data){ let score=0; const signals=[]; const metrics={}; 
        const amp = s.high&&s.low&&s.price ? ((s.high-s.low)/s.price*100) : 0;
        const to = s.turnoverRate||s.turnover||0;
        const cp = s.changePercent||s.changePct||0;
        const pr = s.price||0;
        const minAmp = params.minAmplitude||3;
        const minTo = params.minTurnover||3;
        const maxPr = params.maxPrice||50;
        
        // 振幅评分
        if(amp>=minAmp){ let ampScore = Math.min(35, amp*5); score+=ampScore; signals.push('振幅活跃'+amp.toFixed(1)+'%'); metrics.amplitude=parseFloat(amp.toFixed(2)); }
        // 换手率评分
        if(to>=minTo){ let toScore = Math.min(30, to*4); score+=toScore; signals.push('换手充足'+to.toFixed(1)+'%'); metrics.turnoverRate=parseFloat(to.toFixed(2)); }
        // 价格评分（适中的价格好操作）
        if(pr>0&&pr<=maxPr){ let pScore = pr<=20 ? 20 : (pr<=maxPr?15:0); score+=pScore; signals.push('价格适中¥'+pr.toFixed(2)); metrics.price=pr; }
        // 涨幅评分（微涨更好，不追高）
        if(cp>0&&cp<5){ score+=15; signals.push('温和上涨'+cp.toFixed(1)+'%'); } else if(cp>=5&&cp<9.5){ score+=10; signals.push('强势但不涨停'); } 
        metrics.changePercent=parseFloat(cp.toFixed(2));
        
        if(score>30){ results.push({code:s.code,name:s.name,score:Math.min(100,score),signals,metrics}); } }
        results.sort((a,b)=>b.score-a.score); return results.slice(0,20);
      },
    }
  ],
};

export default plugin;
