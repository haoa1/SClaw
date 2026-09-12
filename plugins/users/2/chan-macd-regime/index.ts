import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

// ============================================================
// chan-macd-regime — 缠论底背离 + MACD 共振 + 市场择时
// 对齐自研 Python 回测：ma30_AND_trend (regime_ma30 + trend_tr90) + sig_chan_macd
// 最佳参数: tr90_f20s60 (ann 8.01%, PF 1.644, 4/4 段正向)
// ============================================================

// --- 小工具（纯函数，无外部依赖）---
function sma(arr: number[], p: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    out.push(i >= p - 1 ? sum / p : NaN);
  }
  return out;
}

function ema(arr: number[], p: number): number[] {
  const out: number[] = [];
  const m = 2.0 / (p + 1);
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isNaN(prev)) { prev = v; out.push(v); }
    else { prev = v * m + prev * (1 - m); out.push(prev); }
  }
  return out;
}

function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaF = ema(closes, fast);
  const emaS = ema(closes, slow);
  const dif = closes.map((_, i) => emaF[i] - emaS[i]);
  const dea = ema(dif, signal);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}

// --- 从全池构建等权市场指数（采样，控制成本）---
function buildMarketNav(stocks: StockData[], maxSamples = 200): number[] {
  // 只取有足够 kline 的股票，最多采样 maxSamples 只
  const pool: number[][] = [];
  for (const s of stocks) {
    const kl = s.kline;
    if (!kl || kl.length < 60) continue;
    pool.push(kl.map(k => k.close));
    if (pool.length >= maxSamples) break;
  }
  if (pool.length < 10) return [];

  const len = Math.min(...pool.map(arr => arr.length));
  const nav: number[] = [];
  for (let i = 0; i < len; i++) {
    let sum = 0, cnt = 0;
    for (const arr of pool) {
      const idx = arr.length - len + i;
      if (idx >= 0) { sum += arr[idx]; cnt++; }
    }
    if (cnt > 0) nav.push(sum / cnt);
  }
  return nav;
}

function regimeGate(nav: number[], maP: number, trendP: number): boolean {
  if (nav.length < Math.max(maP, trendP) + 1) return true; // 数据不足时放行
  const ma = sma(nav, maP);
  const tr = sma(nav, trendP);
  const last = nav[nav.length - 1];
  // regime_ma30: last > ma[last]（价在均线上方 = 多头区）AND trend: last > tr[last]
  return last > ma[ma.length - 1] && last > tr[tr.length - 1];
}

// --- 缠论底背离 + MACD 打分 ---
function scoreStock(st: StockData, params: Record<string, any>): { score: number; signals: string[] } {
  const kl = st.kline;
  if (!kl || kl.length < 55) return { score: 0, signals: [] };

  const closes = kl.map(k => k.close);
  const lows = kl.map(k => k.low);
  const vols = kl.map(k => k.volume);
  const n = closes.length;

  const { dif, dea, hist } = macd(closes);
  const signals: string[] = [];

  // 1) 缠论底背离：价格新低 + DIF 未新低 + MACD 绿柱缩短
  const recentLow = Math.min(...lows.slice(-5));
  const prevLow = Math.min(...lows.slice(-60, -5));
  const recentDif = dif[n - 1];
  const recentLowIdx = lows.slice(-5).indexOf(recentLow);
  const prevLowIdx = lows.slice(-60, -5).indexOf(prevLow);
  const difAtRecent = dif[n - 5 + recentLowIdx];
  const difAtPrev = dif[n - 60 + prevLowIdx];

  const priceNewLow = recentLow < prevLow;
  const difDivergence = difAtRecent > difAtPrev; // 价格新低但 DIF 抬升
  const recentHistSum = hist.slice(-5).reduce((a, b) => a + b, 0);
  const prevHistSum = hist.slice(-10, -5).reduce((a, b) => a + b, 0);
  const macdShrinking = Math.abs(recentHistSum) < Math.abs(prevHistSum) && recentHistSum < 0;

  let score = 0;
  if (priceNewLow && difDivergence) { score += 40; signals.push('缠论底背离(DIF抬升)'); }
  if (priceNewLow && macdShrinking) { score += 20; signals.push('绿柱缩短'); }

  // 2) MACD 金叉 / 红柱
  const goldCross = dif[n - 1] > dea[n - 1] && dif[n - 2] <= dea[n - 2];
  const redBar = hist[n - 1] > 0;
  if (goldCross) { score += 25; signals.push('MACD金叉'); }
  else if (redBar) { score += 12; signals.push('MACD红柱'); }

  // 3) 价格站上 MA20（趋势确认）
  const ma20 = sma(closes, 20);
  if (closes[n - 1] > ma20[n - 1]) { score += 10; signals.push('站上MA20'); }

  // 4) 量能：缩量企稳
  const recentVol = vols.slice(-5).reduce((a, b) => a + b, 0);
  const prevVol = vols.slice(-10, -5).reduce((a, b) => a + b, 0);
  if (recentVol < prevVol * 0.8) { score += 8; signals.push('缩量企稳'); }

  // 5) 日内初筛：可成交性（涨跌幅不过于极端）
  const chg = st.changePercent ?? 0;
  if (chg > 7.5 || chg < -5) { score -= 15; }

  return { score: Math.max(0, score), signals };
}

const plugin: StockScreenerPlugin = {
  id: 'chan-macd-regime',
  name: '缠论MACD·市场择时',
  version: '1.0.0',
  description: '自研策略沉淀：缠论底背离 + MACD共振 + 市场择时(regime_ma30+trend)。对齐Python回测 ma30_AND_trend + sig_chan_macd，最优参数 tr90_f20s60。',
  strategies: [
    {
      id: 'chan-macd-regime',
      name: '缠论MACD·市场择时',
      description: '市场在 regime_ma30+trend90 多头区才出手，个股筛选缠论底背离+MACD金叉',
      category: 'reversal',
      params: [
        { key: 'regimeMa', name: '市场均线', type: 'number', default: 30 },
        { key: 'trendMa', name: '趋势均线', type: 'number', default: 90 },
        { key: 'useRegimeGate', name: '启用市场择时', type: 'boolean', default: true },
        { key: 'minScore', name: '最低得分', type: 'number', default: 40 },
        { key: 'topN', name: '返回数量', type: 'number', default: 10 },
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const regimeMa = Number(params.regimeMa) || 30;
        const trendMa = Number(params.trendMa) || 90;
        const useRegimeGate = params.useRegimeGate !== false;
        const minScore = Number(params.minScore) || 40;
        const topN = Number(params.topN) || 10;

        // 市场择时门（gate）
        if (useRegimeGate) {
          const nav = buildMarketNav(data);
          if (nav.length > 0 && !regimeGate(nav, regimeMa, trendMa)) {
            return []; // 市场不在多头区，不出手
          }
        }

        const results: FilterResult[] = [];
        for (const s of data) {
          if (!s || !s.code) continue;
          const { score, signals } = scoreStock(s, params);
          if (score < minScore) continue;
          results.push({
            code: s.code,
            name: s.name,
            score,
            signals,
            metrics: {
              changePercent: s.changePercent ?? 0,
              price: s.price ?? 0,
            },
          });
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topN);
      },
    },
  ],
};

export default plugin;
