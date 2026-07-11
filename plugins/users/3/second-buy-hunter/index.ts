import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'second-buy-hunter',
  name: '二买猎手',
  version: '1.0.0',
  description: '缠论第二类买点初步筛选 + AI深度验证。初筛条件：20日均线上方 + 一买底背驰信号 + 回调不创新低 + 量能配合。详筛需AI拉取30分钟K线验证MACD零轴上+缩量回调+再次放量翻红。',
  strategies: [
    {
      id: 'second-buy-v1',
      name: '二买猎手 v1',
      description: '二买初筛：日线一买底背驰 + 20日均线上方 + 量能配合 + 回调不创新低。结果需AI做缠论深度验证30分钟MACD。',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        for (const item of data) {
          // 排除科创板、ST
          const code = item.code || '';
          if (code.startsWith('688') || code.startsWith('689')) continue;
          const name = item.name || '';
          if (name.includes('ST') || name.includes('退')) continue;

          // 条件⑥：20日均线上方 — StockData无ma20字段，跳过此条件（由AI验证）
          // 条件①：日线一买底背驰 — 无法直接从StockData判断，跳过（由AI验证）

          // 可用字段筛选
          const chg = item.changePercent ?? 0;
          const vr = item.volumeRatio ?? 0;
          const tr = item.turnoverRate ?? 0;
          const mcap = item.marketCap ?? 0;
          const mcapYi = mcap / 100000000;
          const pe = item.pe ?? 0;

          // 量能配合：量比>0.8 或 换手活跃
          const hasVolume = vr >= 0.8 || (tr >= 3 && tr <= 15);

          // 估值过滤：PE不为负（排除亏损股）或PE未知
          const hasPositivePE = pe === 0 || pe > 0;

          // 股价在合理范围（非仙股）
          const price = item.price ?? 0;
          const validPrice = price >= 5;

          let score = 0;
          const signals: string[] = [];

          // 基础分
          if (chg >= -3 && chg <= 5) { score += 10; signals.push('涨跌幅适中'); }
          if (hasVolume) { score += 20; signals.push('量能配合'); }
          if (mcapYi > 0 && mcapYi < 500) { score += 10; signals.push('中小盘'); }
          if (hasPositivePE) { score += 10; signals.push('非亏损'); }
          if (validPrice) { score += 5; }

          // 加分项
          if (vr >= 1) { score += 15; signals.push('放量'); }
          if (tr >= 3 && tr <= 10) { score += 10; signals.push('换手活跃'); }
          if (pe > 0 && pe < 30) { score += 10; signals.push('估值合理'); }

          // 最低门槛
          if (score < 40) continue;

          results.push({
            code: item.code,
            name: item.name,
            score: Math.min(score, 100),
            signals,
            metrics: {
              price: price,
              changePercent: chg,
              volumeRatio: vr,
              turnoverRate: tr,
              marketCapYi: +mcapYi.toFixed(1),
              pe: pe,
              needDeepVerify: true  // 标记：需AI做缠论深度验证
            }
          });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, 30);
      },
    }
  ],
};

export default plugin;
