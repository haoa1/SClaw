import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'chip-score',
  name: '筹码健康度评分模型',
  version: '1.0.0',
  description: '基于6维筹码健康度模型的全市场打分：顶底比30% + 资金/净买近似20% + 买压15% + 顶背驰15% + 获利盘10% + 缠论中枢10%，叠加超涨(-10)与高位(-8)惩罚项。从120日K线构建筹码分布，识别底部筹码锁定+买压强劲+资金流入的健康结构。',
  strategies: [
    {
      id: 'chip-score-main',
      name: '筹码健康度评分',
      description: '顶底比<1(底部筹码厚)+买压强+获利适中+无顶背驰+缠论中枢托底，输出0-100评分',
      category: 'special',
      params: [
          {
              "key": "limit",
              "label": "返回数量",
              "type": "number",
              "default": 30,
              "min": 5,
              "max": 100
          },
          {
              "key": "minScore",
              "label": "最低评分",
              "type": "number",
              "default": 50,
              "min": 0,
              "max": 90
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results = [];
        const lim = params.limit ?? 30;
        const minScore = params.minScore ?? 50;
        for (const s of data) {
          if (!s || !s.kline || s.kline.length < 60) continue;
          const k = s.kline;
          const price = s.price || k[k.length - 1].close;
          if (!price || price <= 0) continue;
          let sumCV = 0, sumV = 0;
          for (const bar of k) { sumCV += bar.close * bar.volume; sumV += bar.volume; }
          const vwap120 = sumV > 0 ? sumCV / sumV : 0;
          let sumCV20 = 0, sumV20 = 0;
          const k20 = k.slice(-20);
          for (const bar of k20) { sumCV20 += bar.close * bar.volume; sumV20 += bar.volume; }
          const vwap20 = sumV20 > 0 ? sumCV20 / sumV20 : 0;
          let minP = Infinity, maxP = -Infinity;
          for (const bar of k) { if (bar.low < minP) minP = bar.low; if (bar.high > maxP) maxP = bar.high; }
          if (!isFinite(minP) || !isFinite(maxP) || maxP <= minP) continue;
          const bins = 50, step = (maxP - minP) / bins;
          const chips = new Array(bins).fill(0);
          for (const bar of k) { let idx = Math.floor((bar.close - minP) / step); if (idx < 0) idx = 0; if (idx >= bins) idx = bins - 1; chips[idx] += bar.volume; }
          const total = chips.reduce((a, b) => a + b, 0);
          if (total <= 0) continue;
          const curIdx = Math.floor((price - minP) / step); if (curIdx < 0) curIdx = 0; if (curIdx >= bins) curIdx = bins - 1;
          let below = 0; for (let i = 0; i <= curIdx; i++) below += chips[i];
          const above = total - below;
          const topBottomRatio = below > 0 ? above / below : 99;
          const profitRatio = below / total;
          const rangePos = maxP > minP ? (price - minP) / (maxP - minP) : 0.5;
          const ma20 = k20.reduce((a, b) => a + b.close, 0) / k20.length;
          const ma20Dev = ma20 > 0 ? price / ma20 - 1 : 0;
          let min60 = Infinity; for (const bar of k.slice(-60)) if (bar.low < min60) min60 = bar.low;
          const doubleUp = min60 > 0 && price / min60 >= 2;
          const kRec = k.slice(-20);
          let buyV = 0, totV = 0; for (const bar of kRec) { totV += bar.volume; if (bar.close > bar.open) buyV += bar.volume; }
          const buyPress = totV > 0 ? buyV / totV : 0.5;
          let zsCount = 0;
          const win1 = k.slice(-60); if (win1.length >= 60) { let lo = Infinity, hi = -Infinity; for (const bar of win1) { if (bar.low < lo) lo = bar.low; if (bar.high > hi) hi = bar.high; } const amp = hi > lo ? (hi - lo) / lo : 0; if (amp < 0.25) zsCount += 1; }
          const win2 = k.slice(-120, -60); if (win2.length >= 60) { let lo2 = Infinity, hi2 = -Infinity; for (const bar of win2) { if (bar.low < lo2) lo2 = bar.low; if (bar.high > hi2) hi2 = bar.high; } const amp2 = hi2 > lo2 ? (hi2 - lo2) / lo2 : 0; if (amp2 < 0.25) zsCount += 1; }
          const win3 = k.slice(-180, -120); if (win3.length >= 60) { let lo3 = Infinity, hi3 = -Infinity; for (const bar of win3) { if (bar.low < lo3) lo3 = bar.low; if (bar.high > hi3) hi3 = bar.high; } const amp3 = hi3 > lo3 ? (hi3 - lo3) / lo3 : 0; if (amp3 < 0.25) zsCount += 1; }
          const k5 = k.slice(-5); const v5 = k5.reduce((a, b) => a + b.volume, 0) / 5;
          const vPrev = k.slice(-25, -5); const vp = vPrev.reduce((a, b) => a + b.volume, 0) / 20;
          let topDiv = 0; if (vp > 0 && v5 < vp * 0.8 && ma20Dev > 0.05) topDiv = 1;
          const recentRatio = vwap20 > 0 ? price / vwap20 - 1 : 0;
          let score = 0; const signals = [];
          if (topBottomRatio < 0.3) { score += 30; signals.push('顶底比' + topBottomRatio.toFixed(2) + '底部极厚'); } else if (topBottomRatio < 0.5) { score += 25; signals.push('顶底比' + topBottomRatio.toFixed(2) + '底部占优'); } else if (topBottomRatio < 0.8) { score += 18; signals.push('顶底比' + topBottomRatio.toFixed(2) + '尚可'); } else if (topBottomRatio < 1.2) { score += 10; signals.push('顶底比' + topBottomRatio.toFixed(2)); } else { score += 0; signals.push('顶底比' + topBottomRatio.toFixed(2) + '顶部偏重'); }
          if (profitRatio >= 0.05 && profitRatio <= 0.25) { score += 10; signals.push('获利盘' + (profitRatio * 100).toFixed(1) + '%适中'); } else if (profitRatio < 0.05) { score += 6; signals.push('获利盘' + (profitRatio * 100).toFixed(1) + '%极轻'); } else if (profitRatio <= 0.4) { score += 5; } else { score += 0; signals.push('获利盘' + (profitRatio * 100).toFixed(1) + '%偏重'); }
          if (buyPress >= 0.6) { score += 15; signals.push('买压' + (buyPress * 100).toFixed(0) + '%强'); } else if (buyPress >= 0.5) { score += 10; } else if (buyPress >= 0.4) { score += 5; } else { score += 2; }
          if (zsCount >= 3) { score += 10; signals.push(zsCount + '个中枢托底'); } else if (zsCount == 2) { score += 7; signals.push(zsCount + '个中枢'); } else if (zsCount == 1) { score += 5; signals.push('1个中枢'); } else { score += 2; }
          if (topDiv === 0) { score += 15; } else { score += 0; signals.push('顶背驰预警'); }
          if (recentRatio > 0.02 && recentRatio < 0.2) { score += 20; signals.push('资金转强(高于20日成本' + (recentRatio * 100).toFixed(1) + '%)'); } else if (recentRatio >= -0.02 && recentRatio <= 0.02) { score += 12; signals.push('20日成本附近'); } else if (recentRatio > 0.2) { score += 8; signals.push('短线超涨' + (recentRatio * 100).toFixed(0) + '%'); } else { score += 5; signals.push('弱于20日成本'); }
          if (ma20Dev > 0.3 || doubleUp) { score -= 10; signals.push('超涨惩罚-10'); }
          if (rangePos > 0.7) { score -= 8; signals.push('高位惩罚-8'); }
          score = Math.max(0, Math.min(100, score));
          const metrics = { topBottomRatio: Math.round(topBottomRatio * 100) / 100, profitRatio: Math.round(profitRatio * 1000) / 10, buyPress: Math.round(buyPress * 1000) / 10, zsCount, topDiv, ma20Dev: Math.round(ma20Dev * 1000) / 10, rangePos: Math.round(rangePos * 100) / 100, recentRatio: Math.round(recentRatio * 1000) / 10 };
          if (score >= minScore) results.push({ code: s.code, name: s.name, score: Math.round(score), signals, metrics });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, lim);
      },
    }
  ],
};

export default plugin;
