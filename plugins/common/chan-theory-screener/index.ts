/**
 * 缠中说禅选股策略 — Chan Theory Stock Screener
 * 
 * 基于缠论核心概念的量化选股策略：
 *   1. 底分型选股 — 日线底分型 + 成交量确认
 *   2. 底背驰选股 — MACD底背驰（价格新低但MACD不新低）
 *   3. 第三类买点 — 突破中枢后回踩不破
 *
 * 参考：缠中说禅《教你炒股票》108课
 */

import { StockScreenerPlugin, StockData, FilterResult, KLineData } from '../../backend/src/types';

// ====== Helper Functions ======

/** EMA计算 */
function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      result.push(values[i]);
    } else {
      result.push((values[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
  }
  return result;
}

/** MACD计算 */
function computeMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = emaFast.map((v, i) => v - emaSlow[i]);
  const dea = ema(dif, signal);
  const macd = dif.map((v, i) => 2 * (v - dea[i]));
  return { dif, dea, macd };
}

/** 判断底分型: 中间K线最低点最低，最高点也比两边低 */
function isBottomFractal(k1: KLineData, k2: KLineData, k3: KLineData): boolean {
  return k2.low < k1.low && k2.low < k3.low && k2.high < k1.high && k2.high < k3.high;
}

/** 判断顶分型: 中间K线最高点最高，最低点也比两边高 */
function isTopFractal(k1: KLineData, k2: KLineData, k3: KLineData): boolean {
  return k2.high > k1.high && k2.high > k3.high && k2.low > k1.low && k2.low > k3.low;
}

/** SMA (简单移动平均) */
function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      result.push(sum / period);
    }
  }
  return result;
}

// ====== Strategy 1: 底分型选股 ======

function executeFractalStrategy(data: StockData[], _params: Record<string, any>): FilterResult[] {
  const results: FilterResult[] = [];

  for (const item of data) {
    const kline = item.kline;
    if (!kline || kline.length < 10) continue;

    // 取最近10根K线
    const recent = kline.slice(-10);

    // 寻找底分型
    let foundBottom = false;
    let fractalIdx = -1;
    let score = 0;
    const signals: string[] = [];

    for (let i = 1; i < recent.length - 1; i++) {
      if (isBottomFractal(recent[i - 1], recent[i], recent[i + 1])) {
        // 底分型确认
        foundBottom = true;
        fractalIdx = i;

        // 评分因素1: 成交量萎缩（底分型中间K线缩量）
        const prevVol = recent[i - 1].volume;
        const fractalVol = recent[i].volume;
        if (fractalVol < prevVol * 0.8) {
          score += 20;
          signals.push('缩量底分型');
        }

        // 评分因素2: 底分型后出现阳线确认
        if (i + 2 < recent.length && recent[i + 2].close > recent[i + 2].open) {
          // 底分型次日收阳
          if (recent[i + 1].close > recent[i + 1].open) {
            score += 15;
            signals.push('底分型+阳线确认');
          }
        }

        // 评分因素3: 底分型位置 — 在近期低点附近加分
        const minLow = Math.min(...recent.slice(0, i + 2).map(k => k.low));
        if (recent[i].low <= minLow * 1.01) {
          score += 15;
          signals.push('阶段低点');
        }

        // 评分因素4: MACD状态 — DIF在0轴下方但拐头向上
        const closes = recent.map(k => k.close);
        const macdResult = computeMACD(closes);
        const dif = macdResult.dif;
        if (dif[i] < 0 && dif[i] > dif[i - 1]) {
          score += 10;
          signals.push('MACD拐头');
        }

        break; // 找最近的一个底分型
      }
    }

    if (foundBottom && score >= 20) {
      // 最终评分归一化到0-100
      const finalScore = Math.min(100, 40 + score);
      results.push({
        code: item.code,
        name: item.name,
        score: finalScore,
        signals: signals.length > 0 ? signals : ['底分型'],
        metrics: {
          price: item.price,
          changePercent: item.changePercent,
          score: finalScore,
          fractalStrength: score,
        },
      });
    }
  }

  return results;
}

// ====== Strategy 2: 底背驰选股 ======

function executeDivergenceStrategy(data: StockData[], _params: Record<string, any>): FilterResult[] {
  const results: FilterResult[] = [];

  for (const item of data) {
    const kline = item.kline;
    if (!kline || kline.length < 35) continue;

    // 取最近60根K线
    const recent = kline.slice(-60);
    const closes = recent.map(k => k.close);
    const lows = recent.map(k => k.low);
    const volumes = recent.map(k => k.volume);

    const macdResult = computeMACD(closes);
    const macdValues = macdResult.macd;
    const difValues = macdResult.dif;
    const deaValues = macdResult.dea;

    // 找最近一个低点: 后5根K线的最低点比前面20根都低
    const lookback = Math.min(20, Math.floor(recent.length / 2));
    const recentLow = Math.min(...lows.slice(-5));
    const recentLowIdx = lows.lastIndexOf(recentLow, lows.length - 1);

    // 找前一个低点 (在最近低点之前)
    const prevSegment = lows.slice(0, recentLowIdx - 3);
    if (prevSegment.length < 5) continue;
    const prevLow = Math.min(...prevSegment.slice(-10));
    const prevLowIdx = lows.lastIndexOf(prevLow, prevSegment.length - 1);

    if (recentLowIdx < 0 || prevLowIdx < 0 || prevLowIdx >= recentLowIdx) continue;

    // 背驰条件1: 最近低点 < 前低 (价格新低)
    const priceNewLow = recentLow < prevLow;

    // 背驰条件2: MACD绿柱面积减小 (或DIF值没创新低)
    const prevMacdVals = macdValues.slice(prevLowIdx - 2, prevLowIdx + 3).filter(v => v < 0);
    const recentMacdVals = macdValues.slice(recentLowIdx - 2, recentLowIdx + 3).filter(v => v < 0);

    const prevMacdSum = prevMacdVals.reduce((a, b) => a + b, 0);
    const recentMacdSum = recentMacdVals.reduce((a, b) => a + b, 0);
    const macdShrinking = recentMacdSum > prevMacdSum; // 负数，越大表示萎缩越厉害

    // 背驰条件3: DIF底背驰 — DIF没创新低
    const difNewLow = difValues[recentLowIdx] < difValues[prevLowIdx];
    const difDivergence = !difNewLow;

    // 背驰条件4: 成交量萎缩
    const prevVol = volumes.slice(prevLowIdx - 2, prevLowIdx + 3).reduce((a, b) => a + b, 0);
    const recentVol = volumes.slice(recentLowIdx - 2, recentLowIdx + 3).reduce((a, b) => a + b, 0);
    const volShrinking = recentVol < prevVol * 0.8;

    // 评分计算
    let score = 0;
    const signals: string[] = [];

    if (priceNewLow && difDivergence) {
      score += 40;
      signals.push('DIF底背驰');
    } else if (priceNewLow && macdShrinking) {
      score += 30;
      signals.push('MACD柱底背驰');
    }

    if (priceNewLow) signals.push('价格新低');
    if (macdShrinking) signals.push('MACD绿柱萎缩');
    if (volShrinking) {
      score += 15;
      signals.push('缩量');
    }

    // 检查最近是否出现底分型确认
    if (recent.length >= 10) {
      for (let i = Math.max(1, recent.length - 6); i < recent.length - 1; i++) {
        if (isBottomFractal(recent[i - 1], recent[i], recent[i + 1])) {
          score += 20;
          signals.push('底分型确认');
          break;
        }
      }
    }

    if (score >= 30) {
      results.push({
        code: item.code,
        name: item.name,
        score: Math.min(100, score),
        signals,
        metrics: {
          price: item.price,
          changePercent: item.changePercent,
          score: Math.min(100, score),
          difDivergence: difDivergence ? 1 : 0,
          macdShrinking: macdShrinking ? 1 : 0,
        },
      });
    }
  }

  return results;
}

// ====== Strategy 3: 第三类买点 ======

function executeThirdBuyStrategy(data: StockData[], params: Record<string, any>): FilterResult[] {
  const results: FilterResult[] = [];

  // 参数：中枢周期 (日线默认20)
  const pivotPeriod = (params.pivotPeriod as number) || 20;

  for (const item of data) {
    const kline = item.kline;
    if (!kline || kline.length < pivotPeriod * 2) continue;

    const recent = kline.slice(-pivotPeriod * 2);
    const closes = recent.map(k => k.close);
    const highs = recent.map(k => k.high);
    const lows = recent.map(k => k.low);
    const volumes = recent.map(k => k.volume);

    // 计算均线作为"中枢"的近似
    const maPeriod = Math.max(5, Math.floor(pivotPeriod / 4));
    const ma = sma(closes, maPeriod);

    // 寻找最近的中枢区间
    // 中枢 = 最近 N 根K线（排除最后5根"突破/回踩"K线，否则突破条件永远无法成立）
    const pivotHigh = Math.max(...highs.slice(-pivotPeriod - 5, -5));
    const pivotLow = Math.min(...lows.slice(-pivotPeriod - 5, -5));
    const pivotMid = (pivotHigh + pivotLow) / 2;

    // 第3类买点条件：
    // 条件1: 最近价格突破中枢
    const recentHigh = Math.max(...highs.slice(-5));
    const priceAbovePivot = recentHigh > pivotHigh * 1.01;

    // 条件2: 最近有回调但不破中枢上沿
    const pullbackLow = Math.min(...lows.slice(-3));
    const pullbackAbovePivot = pullbackLow > pivotHigh;

    // 条件3: 突破时放量，回调时缩量
    const breakVol = volumes.slice(-7, -2).reduce((a, b) => a + b, 0) / 5;
    const pullbackVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const volConfirm = breakVol > 0 && pullbackVol > 0 && pullbackVol < breakVol * 0.9;

    // 条件4: MACD在0轴上方
    const macdResult = computeMACD(closes);
    const dif = macdResult.dif;
    const difAboveZero = dif[dif.length - 1] > 0;

    // 硬性门槛：三买必须同时满足「突破中枢」+「回踩不破中枢上沿」，否则直接排除
    if (!priceAbovePivot || !pullbackAbovePivot) continue;

    // 评分
    let score = 0;
    const signals: string[] = [];

    score += 30;
    signals.push('突破中枢');

    score += 30;
    signals.push('回踩不破');

    if (volConfirm) {
      score += 15;
      signals.push('缩量回踩');
    }

    if (difAboveZero) {
      score += 10;
      signals.push('MACD多头');
    }

    // 额外加分：涨跌幅适中 (不太高，刚启动)
    const chg = item.changePercent ?? 0;
    if (chg > 0 && chg < 5) {
      score += 15;
      signals.push('涨幅适中');
    }

    if (score >= 40) {
      results.push({
        code: item.code,
        name: item.name,
        score: Math.min(100, score),
        signals,
        metrics: {
          price: item.price,
          changePercent: item.changePercent,
          score: Math.min(100, score),
          pivotHigh,
          pivotLow,
        },
      });
    }
  }

  return results;
}

// ====== Plugin Definition ======

const plugin: StockScreenerPlugin = {
  id: 'chan-theory-screener',
  name: '缠中说禅选股',
  version: '1.0.0',
  description: '基于缠中说禅《教你炒股票》核心理论的量化选股策略集。包含底分型、底背驰、第三类买点三种策略，均从日线K线数据中计算。',

  strategies: [
    {
      id: 'chan-fractal',
      name: '缠论底分型',
      description: '日线底分型选股 — 检测三K线底分型形态，辅以成交量萎缩和MACD拐头确认。缠论第18课定义的分型结构。',
      category: 'reversal',
      params: [],
      execute: executeFractalStrategy,
    },
    {
      id: 'chan-divergence',
      name: '缠论底背驰',
      description: 'MACD底背驰选股 — 价格创新低但MACD（DIF或红绿柱面积）不创新低，为缠论第一类买点的核心判断依据。缠论第24、29课。',
      category: 'reversal',
      params: [],
      execute: executeDivergenceStrategy,
    },
    {
      id: 'chan-third-buy',
      name: '第三类买点',
      description: '第三类买点选股 — 股价突破近期中枢（N日盘整区间），回踩不破中枢上沿且缩量，是缠论趋势确认的关键信号。缠论第18、25课。',
      category: 'momentum',
      params: [
        {
          key: 'pivotPeriod',
          label: '中枢周期(日)',
          type: 'number',
          default: 20,
          min: 10,
          max: 60,
          step: 5,
        },
      ],
      execute: executeThirdBuyStrategy,
    },
  ],
};

export default plugin;
