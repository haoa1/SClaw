import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'chip-structure',
  name: '筹码结构精选',
  version: '1.0.0',
  description: '基于筹码结构的最优选股策略：底部筹码占优(顶底比<1) + 套牢盘轻 + 近期资金转强 + 量能配合 + 温和启动。核心是找"上方抛压小、底部有支撑、资金刚进场"的股票。',
  strategies: [
    {
      id: 'chip-structure-best',
      name: '筹码结构最优',
      description: '顶底比<1(底部筹码多) + 套牢盘轻 + 近期资金转强 + 量能配合 + 换手活跃 + 温和启动',
      category: 'special',
      params: [
          {
              "key": "minTopBottomRatio",
              "label": "顶底比上限",
              "type": "number",
              "default": 1.2,
              "min": 0.5,
              "max": 3
          },
          {
              "key": "maxTrapRatio",
              "label": "套牢比上限(%)",
              "type": "number",
              "default": -5,
              "min": -30,
              "max": 20
          },
          {
              "key": "minVolumeRatio",
              "label": "量比下限",
              "type": "number",
              "default": 0.8,
              "min": 0.1,
              "max": 5
          },
          {
              "key": "minTurnover",
              "label": "换手下限(%)",
              "type": "number",
              "default": 2,
              "min": 0.5,
              "max": 20
          },
          {
              "key": "maxTurnover",
              "label": "换手上限(%)",
              "type": "number",
              "default": 15,
              "min": 5,
              "max": 40
          },
          {
              "key": "minChange",
              "label": "涨幅下限(%)",
              "type": "number",
              "default": 0,
              "min": -5,
              "max": 10
          },
          {
              "key": "maxChange",
              "label": "涨幅上限(%)",
              "type": "number",
              "default": 5,
              "min": 0,
              "max": 20
          },
          {
              "key": "limit",
              "label": "返回数量",
              "type": "number",
              "default": 30,
              "min": 5,
              "max": 100
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results: FilterResult[] = [];
        const minTB = params.minTopBottomRatio ?? 1.2;
        const maxTrap = (params.maxTrapRatio ?? -5) / 100;
        const minVR = params.minVolumeRatio ?? 0.8;
        const minTurn = params.minTurnover ?? 2;
        const maxTurn = params.maxTurnover ?? 15;
        const minChg = params.minChange ?? 0;
        const maxChg = params.maxChange ?? 5;
        const lim = params.limit ?? 30;
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
          const bins = 50;
          const step = (maxP - minP) / bins;
          const chips = new Array(bins).fill(0);
          for (const bar of k) {
            let idx = Math.floor((bar.close - minP) / step);
            if (idx < 0) idx = 0; if (idx >= bins) idx = bins - 1;
            chips[idx] += bar.volume;
          }
          const totalChips = chips.reduce((a, b) => a + b, 0);
          if (totalChips <= 0) continue;
          let curIdx = Math.floor((price - minP) / step);
          if (curIdx < 0) curIdx = 0; if (curIdx >= bins) curIdx = bins - 1;
          let below = 0;
          for (let i = 0; i <= curIdx; i++) below += chips[i];
          const above = totalChips - below;
          const topBottomRatio = below > 0 ? above / below : 99;
          const profitRatio = below / totalChips;
          const trapRatio = vwap120 > 0 ? price / vwap120 - 1 : 0;
          const recentRatio = vwap20 > 0 ? price / vwap20 - 1 : 0;
          let score = 0;
          const signals: string[] = [];
          const metrics: Record<string, number> = {
            topBottomRatio: Math.round(topBottomRatio * 100) / 100,
            trapRatio: Math.round(trapRatio * 1000) / 10,
            recentRatio: Math.round(recentRatio * 1000) / 10,
            profitRatio: Math.round(profitRatio * 1000) / 10,
            vwap120: Math.round(vwap120 * 100) / 100,
            vwap20: Math.round(vwap20 * 100) / 100,
          };
          if (topBottomRatio < 1) { score += 35; signals.push('底部筹码占优(顶底比' + topBottomRatio.toFixed(2) + ')'); }
          else if (topBottomRatio < minTB) { score += 20; signals.push('筹码尚可(顶底比' + topBottomRatio.toFixed(2) + ')'); }
          else continue;
          if (trapRatio > maxTrap && trapRatio < 0.15) { score += 20; signals.push('套牢盘轻(距120日成本' + (trapRatio * 100).toFixed(1) + '%)'); }
          else if (trapRatio > -0.15) { score += 10; signals.push('套牢适中'); }
          else continue;
          if (recentRatio > 0.02 && recentRatio < 0.2) { score += 15; signals.push('近期资金转强(高于20日成本' + (recentRatio * 100).toFixed(1) + '%)'); }
          else if (recentRatio > -0.02 && recentRatio <= 0.02) { score += 8; signals.push('近期成本附近'); }
          const vr = parseFloat(String(s.volumeRatio)) || 0;
          if (vr >= minVR) { score += 10; signals.push('量比' + vr.toFixed(1)); }
          const turn = parseFloat(String(s.turnoverRate)) || 0;
          if (turn >= minTurn && turn <= maxTurn) { score += 10; signals.push('换手' + turn.toFixed(1) + '%'); }
          else if (turn > 0 && turn < minTurn) { score += 3; }
          const chg = parseFloat(String(s.changePercent)) || 0;
          if (chg >= minChg && chg <= maxChg) { score += 10; signals.push('涨幅' + chg.toFixed(1) + '%'); }
          if (score >= 60) results.push({ code: s.code, name: s.name, score: Math.min(100, score), signals, metrics });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, lim);
      },
    }
  ],
};

export default plugin;
