import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

// ============================================================
// chan-macd-lite — 缠论底背离 + MACD（纯个股，无市场择时）
// 对照变体：不放市场门，仅用个股 K 线信号，用于对比 regime 门贡献
// 对齐 Python sig_chan_macd：priceNewLow+difDivergence +40, +macdShrinking +20
// ============================================================

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

// --- 缠论底背离打分（对齐 Python sig_chan_macd）---
function scoreStock(st: StockData): { score: number; signals: string[] } {
  const kl = st.kline;
  if (!kl || kl.length < 55) return { score: 0, signals: [] };

  const closes = kl.map(k => k.close);
  const lows = kl.map(k => k.low);
  const vols = kl.map(k => k.volume);
  const n = closes.length;

  const { dif, dea, hist } = macd(closes);
  const signals: string[] = [];

  // 缠论段：最近5日低点 vs 前段(60日前)低点
  const recentWindow = lows.slice(-5);
  const prevWindow = lows.slice(-60, -5);
  if (recentWindow.length === 0 || prevWindow.length === 0) return { score: 0, signals: [] };

  const recentLow = Math.min(...recentWindow);
  const prevLow = Math.min(...prevWindow);
  const priceNewLow = recentLow < prevLow;

  // DIF 对应位置
  const recentLowIdx = recentWindow.indexOf(recentLow);
  const prevLowIdx = prevWindow.indexOf(prevLow);
  const difAtRecent = dif[n - 5 + recentLowIdx];
  const difAtPrev = dif[n - 60 + prevLowIdx];
  const difDivergence = difAtRecent > difAtPrev;

  // MACD 绿柱萎缩（负柱缩小 = 下跌动能减弱）
  const recentHist = hist.slice(-5).reduce((a, b) => a + b, 0);
  const prevHist = hist.slice(-10, -5).reduce((a, b) => a + b, 0);
  const macdShrinking = recentHist < 0 && Math.abs(recentHist) < Math.abs(prevHist);

  // 量能萎缩（缩量 = 抛压枯竭）
  const recentVol = vols.slice(-5).reduce((a, b) => a + b, 0);
  const prevVol = vols.slice(-10, -5).reduce((a, b) => a + b, 0);
  const volShrinking = recentVol < prevVol * 0.8;

  let score = 0;
  // 对齐 Python：priceNewLow AND difDivergence → +40
  if (priceNewLow && difDivergence) { score += 40; signals.push('缠论底背离'); }
  // priceNewLow AND macdShrinking → 附加
  if (priceNewLow && macdShrinking) { score += 20; signals.push('绿柱萎缩'); }
  // priceNewLow AND volShrinking → 附加（Python 里 0.8 权重）
  if (priceNewLow && volShrinking) { score += 15; signals.push('缩量企稳'); }

  // MACD 金叉
  const goldCross = dif[n - 1] > dea[n - 1] && dif[n - 2] <= dea[n - 2];
  if (goldCross) { score += 25; signals.push('MACD金叉'); }
  else if (hist[n - 1] > 0) { score += 10; signals.push('MACD红柱'); }

  // 趋势确认：站上 MA20
  const ma20 = sma(closes, 20);
  if (n > 20 && closes[n - 1] > ma20[n - 1]) { score += 8; signals.push('站上MA20'); }

  return { score: Math.max(0, score), signals };
}

const plugin: StockScreenerPlugin = {
  id: 'chan-macd-lite',
  name: '缠论MACD·纯个股',
  version: '1.0.0',
  description: '自研策略变体：缠论底背离 + MACD，纯个股信号（无市场择时门）。用于与 chan-macd-regime 对比 regime 门贡献。',
  strategies: [
    {
      id: 'chan-macd-lite',
      name: '缠论MACD·纯个股',
      description: '纯个股缠论底背离+MACD金叉，不依赖市场择时，任何行情下筛选',
      category: 'reversal',
      params: [
        { key: 'minScore', name: '最低得分', type: 'number', default: 45 },
        { key: 'topN', name: '返回数量', type: 'number', default: 10 },
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const minScore = Number(params.minScore) || 45;
        const topN = Number(params.topN) || 10;

        const results: FilterResult[] = [];
        for (const s of data) {
          if (!s || !s.code) continue;
          const { score, signals } = scoreStock(s);
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
