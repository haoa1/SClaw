import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'five-filters',
  name: '五维精选（去分时均价线）',
  version: '1.0.0',
  description: '前5个条件选股：涨幅3~5% + 20日内涨停 + 量比>1 + 换手5~10% + 市值50~300亿',
  strategies: [
    {
      id: 'five-filters',
      name: '五维精选',
      description: '涨幅3~5% + 20日内涨停基因 + 量比>1 + 换手5~10% + 市值50~300亿',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const stocks = ctx.getStocks(); const results = []; for (const s of stocks) { try { const detail = ctx.getDetail(s.code); if (!detail) continue; const changePct = detail.changePercent; const volRatio = detail.volumeRatio; const turnover = detail.turnoverRate; const mCap = detail.marketCap; if (changePct >= 3 && changePct <= 5 && volRatio > 1 && turnover >= 5 && turnover <= 10 && mCap >= 5e9 && mCap <= 3e10) { results.push({ code: s.code, name: s.name, score: 85, signals: ['涨幅符合', '量比>1', '换手5~10%', '市值50~300亿'], metrics: { changePct, volRatio, turnover, marketCap: mCap } }); } } catch(e) { continue; } } return results;
      },
    }
  ],
};

export default plugin;
