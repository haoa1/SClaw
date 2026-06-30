import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'mb-select',
  name: '主板精选',
  version: '1.0.0',
  description: '主板短线：涨幅3-5% + 量比>1 + 换手5-10% + 市值<200亿 + 分时强势',
  strategies: [
    {
      id: 'main-board-screener',
      name: '主板尾盘精选',
      description: '主板涨幅3-5%+量比>1+换手5-10%+市值<200亿+分时均价线上',
      category: 'short-term',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        results = []; for (s of stockPool) { if (!s || (s.code||'').startsWith('688') || (s.code||'').startsWith('689') || (s.code||'').startsWith('300') || (s.code||'').startsWith('301')) continue; c = parseFloat(s.changePercent)||0; if (c<3||c>5) continue; v = parseFloat(s.volumeRatio)||0; if (v<=1) continue; t = parseFloat(s.turnoverRate)||0; if (t<5||t>10) continue; m = (parseFloat(s.marketCap)||0)/100000000; if (m>=200) continue; if (s.priceAboveVwap===false||s.priceAboveVwap===0||s.priceAboveVwap===null||s.priceAboveVwap===undefined) continue; signals = []; if (c>=3&&c<=5) signals.push('涨幅适中'); if (v>1) signals.push('量比>1'); if (t>=5&&t<=10) signals.push('换手活跃'); if (m<200) signals.push('小盘'); if (signals.length>=4) { results.push({code:s.code,name:s.name,score:signals.length*20,signals,metrics:{changePercent:c,volumeRatio:v,turnoverRate:t,marketCapYi:m}}) } } results.sort((a,b)=>b.score-a.score); return results.slice(0,20);
      },
    }
  ],
};

export default plugin;
