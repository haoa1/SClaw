"use strict";
/**
 * 缠论买卖点 — 日线第一类买点 + 日线/30分钟第二类买点
 *
 * 基于缠论核心买卖点理论：
 *   1. 日线第一类买点：底背驰（价格新低 + MACD不新低 + 底分型确认）
 *   2. 30分钟第二类买点：第一类买点确立后，30分钟回调不破前低
 *   3. 日线第二类买点：第一类买点确立后，日线回调不破前低（纯日线，无需30分钟K线）
 */

// ====== Helper: EMA ======
function ema(values, period) {
    const result = [];
    const multiplier = 2 / (period + 1);
    for (let i = 0; i < values.length; i++) {
        if (i === 0) result.push(values[i]);
        else result.push((values[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
    return result;
}

// ====== Helper: MACD ======
function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const dif = emaFast.map((v, i) => v - emaSlow[i]);
    const dea = ema(dif, signal);
    const macd = dif.map((v, i) => 2 * (v - dea[i]));
    return { dif, dea, macd };
}

// ====== Helper: 底分型 ======
function isBottomFractal(k1, k2, k3) {
    return k2.low < k1.low && k2.low < k3.low && k2.high < k1.high && k2.high < k3.high;
}

// ====== Helper: 顶分型 ======
function isTopFractal(k1, k2, k3) {
    return k2.high > k1.high && k2.high > k3.high && k2.low > k1.low && k2.low > k3.low;
}

// ====== Strategy 1: 日线第一类买点（底背驰） ======
function executeFirstBuyStrategy(data, _params) {
    const results = [];
    for (const item of data) {
        const kline = item.kline;
        if (!kline || kline.length < 60) continue;

        const recent = kline.slice(-120);
        const closes = recent.map(k => k.close);
        const lows = recent.map(k => k.low);
        const volumes = recent.map(k => k.volume);
        const macdResult = computeMACD(closes);
        const dif = macdResult.dif;

        // 找最近一个显著低点
        const lookback = Math.min(20, Math.floor(recent.length / 3));
        const recentMin = Math.min(...lows.slice(-lookback));
        const recentIdx = lows.lastIndexOf(recentMin, lows.length - 1);
        if (recentIdx < 10) continue;

        // 找前一个低点（在最近低点之前，间隔至少10根K线）
        const prevSegment = lows.slice(0, recentIdx - 5);
        if (prevSegment.length < 10) continue;
        const prevLow = Math.min(...prevSegment.slice(-15));
        const prevIdx = lows.lastIndexOf(prevLow, prevSegment.length - 1);
        if (prevIdx < 0 || prevIdx >= recentIdx || recentIdx - prevIdx < 10) continue;

        // === 第一类买点评分 ===
        let score = 0;
        const signals = [];

        // 条件1: 价格新低
        const priceNewLow = recentMin < prevLow;
        if (priceNewLow) {
            score += 10;
            signals.push('价格新低');
        }

        // 条件2: DIF底背驰（核心条件）
        const difAtRecent = dif[recentIdx];
        const difAtPrev = dif[prevIdx];
        const difDivergence = priceNewLow && difAtRecent > difAtPrev;
        if (difDivergence) {
            score += 35;
            signals.push('DIF底背驰');
        }

        // 条件3: MACD绿柱缩小
        const prevMacdArea = macdResult.macd.slice(prevIdx - 3, prevIdx + 3).filter(v => v < 0).reduce((a, b) => a + b, 0);
        const recentMacdArea = macdResult.macd.slice(recentIdx - 3, recentIdx + 3).filter(v => v < 0).reduce((a, b) => a + b, 0);
        const macdShrinking = prevMacdArea < 0 && recentMacdArea < 0 && recentMacdArea > prevMacdArea;
        if (macdShrinking) {
            score += 10;
            signals.push('MACD绿柱缩小');
        }

        // 条件4: 成交量萎缩
        const prevVol = volumes.slice(Math.max(0, prevIdx - 2), prevIdx + 3).reduce((a, b) => a + b, 0) / 5;
        const recentVol = volumes.slice(Math.max(0, recentIdx - 2), recentIdx + 3).reduce((a, b) => a + b, 0) / 5;
        if (recentVol < prevVol * 0.8 && prevVol > 0) {
            score += 10;
            signals.push('缩量见底');
        }

        // 条件5: 最近出现底分型
        const recentFractal = recent.slice(-10);
        let hasFractal = false;
        for (let i = 1; i < recentFractal.length - 1; i++) {
            if (isBottomFractal(recentFractal[i - 1], recentFractal[i], recentFractal[i + 1])) {
                hasFractal = true;
                break;
            }
        }
        if (hasFractal) {
            score += 15;
            signals.push('底分型确认');
        }

        // 条件6: 价格从低点回升至少3%
        const recentClose = closes[closes.length - 1];
        const pctFromLow = (recentClose - recentMin) / recentMin * 100;
        if (pctFromLow > 3) {
            score += 5;
            signals.push(`回升${pctFromLow.toFixed(1)}%`);
        }

        // 条件7: DIF拐头向上
        if (difAtRecent < 0 && dif.length > recentIdx + 3) {
            const difTrend = dif[recentIdx + 3] > difAtRecent;
            if (difTrend) {
                score += 10;
                signals.push('DIF拐头向上');
            }
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
                    divergenceStrength: score,
                    lowPrice: recentMin,
                    lowDate: recent[recentIdx].date,
                    pctFromLow: parseFloat(pctFromLow.toFixed(2)),
                },
            });
        }
    }
    return results;
}

// ====== Strategy 2: 30分钟第二类买点 ======
function executeSecondBuyStrategy(data, _params) {
    const results = [];
    for (const item of data) {
        const kline = item.kline;         // 日线K线
        const kline30 = item.kline30min;  // 30分钟K线

        if (!kline || kline.length < 60) continue;

        // === 第一步：日线检查是否有第一类买点特征 ===
        const daily = kline.slice(-90);
        const dailyLows = daily.map(k => k.low);
        const dailyCloses = daily.map(k => k.close);

        const recentDailyLow = Math.min(...dailyLows.slice(-20));
        const recentDailyLowIdx = dailyLows.lastIndexOf(recentDailyLow, dailyLows.length - 1);
        if (recentDailyLowIdx < 5) continue;

        const prevDailySegment = dailyLows.slice(0, recentDailyLowIdx - 5);
        if (prevDailySegment.length < 10) continue;
        const prevDailyLow = Math.min(...prevDailySegment.slice(-15));
        const prevDailyLowIdx = dailyLows.lastIndexOf(prevDailyLow, prevDailySegment.length - 1);
        if (prevDailyLowIdx < 0 || prevDailyLowIdx >= recentDailyLowIdx) continue;

        // 日线底背驰：价格新低 + DIF不新低
        const dailyMacd = computeMACD(dailyCloses);
        const dailyDifDivergence = recentDailyLow < prevDailyLow &&
            dailyMacd.dif[recentDailyLowIdx] > dailyMacd.dif[prevDailyLowIdx];
        if (!dailyDifDivergence) continue;

        // 日线第一类买点确立后，股价应已回升至少5%
        const currentPrice = dailyCloses[dailyCloses.length - 1];
        const pctUp = (currentPrice - recentDailyLow) / recentDailyLow * 100;
        if (pctUp < 5) continue;

        // === 第二步：检查30分钟线的第二类买点 ===
        if (!kline30 || kline30.length < 80) continue;

        const m30 = kline30.slice(-120);
        const m30Lows = m30.map(k => k.low);
        const m30Highs = m30.map(k => k.high);
        const m30Closes = m30.map(k => k.close);
        const m30Volumes = m30.map(k => k.volume);
        const m30Macd = computeMACD(m30Closes, 12, 26, 9);

        // 找30分钟K线上最近的一个显著低点
        const m30RecentMin = Math.min(...m30Lows.slice(-40));
        const m30RecentIdx = m30Lows.lastIndexOf(m30RecentMin, m30Lows.length - 1);
        if (m30RecentIdx < 5) continue;

        // 从低点之后找高点（冲高过程）
        const afterLow = m30.slice(m30RecentIdx);
        if (afterLow.length < 30) continue;

        const afterHigh = Math.max(...afterLow.map(k => k.high));
        const afterHighIdx = m30Highs.lastIndexOf(afterHigh, m30Highs.length - 1);
        if (afterHighIdx <= m30RecentIdx || afterHighIdx - m30RecentIdx < 5) continue;

        // 当前30分钟价格
        const currentM30Price = m30Closes[m30Closes.length - 1];
        const pullbackPct = (afterHigh - currentM30Price) / afterHigh * 100;
        // 第二类买点核心：回调不破前低
        const notBreakLow = currentM30Price > m30RecentMin * 1.005;

        // === 评分 ===
        let score = 0;
        const signals = [];

        // 基础：日线底背驰
        score += 20;
        signals.push('日线底背驰');

        // 日线回升幅度
        if (pctUp >= 5) {
            score += 5;
            signals.push(`已回升${pctUp.toFixed(1)}%`);
        }

        // 30分钟冲高确认
        const risePct30 = (afterHigh - m30RecentMin) / m30RecentMin * 100;
        if (risePct30 >= 5) {
            score += 10;
            signals.push(`30分冲高${risePct30.toFixed(1)}%`);
        }

        // 第二类买点核心：回调不破前低
        if (notBreakLow) {
            score += 25;
            signals.push('回调不破前低');
        }

        // 回调幅度适中
        if (pullbackPct >= 3 && pullbackPct <= 15) {
            score += 10;
            signals.push(`回调${pullbackPct.toFixed(1)}%`);
        }

        // DIF回抽0轴
        const m30Dif = m30Macd.dif;
        const recentDif = m30Dif[m30Dif.length - 1];
        const maxDif = Math.max(...m30Dif.slice(m30RecentIdx));
        const maxDifIdx = m30Dif.lastIndexOf(maxDif, m30Dif.length - 1);
        const difPullbackRatio = maxDif !== 0 ? (maxDif - recentDif) / Math.abs(maxDif) : 0;
        if (difPullbackRatio > 0.4 && recentDif > -Math.abs(maxDif) * 0.5) {
            score += 10;
            signals.push('DIF回抽0轴');
        }

        // 回调缩量
        const volNearHigh = m30Volumes.slice(Math.max(0, afterHighIdx - 3), afterHighIdx + 2).reduce((a, b) => a + b, 0) / 5;
        const volRecent = m30Volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
        if (volRecent < volNearHigh * 0.8 && volNearHigh > 0) {
            score += 10;
            signals.push('缩量回调');
        }

        // 30分钟底分型
        const last10 = m30.slice(-10);
        for (let i = 1; i < last10.length - 1; i++) {
            if (isBottomFractal(last10[i - 1], last10[i], last10[i + 1])) {
                score += 10;
                signals.push('30分底分型');
                break;
            }
        }

        if (score >= 50) {
            results.push({
                code: item.code,
                name: item.name,
                score: Math.min(100, score),
                signals,
                metrics: {
                    price: item.price,
                    changePercent: item.changePercent,
                    score: Math.min(100, score),
                    dailyLowPrice: recentDailyLow,
                    pctFromDailyLow: parseFloat(pctUp.toFixed(2)),
                    m30LowPrice: m30RecentMin,
                    m30HighPrice: afterHigh,
                    m30PullbackPct: parseFloat(pullbackPct.toFixed(2)),
                    m30DifPullback: parseFloat(difPullbackRatio.toFixed(2)),
                },
            });
        }
    }
    return results;
}

// ====== Strategy 3: 日线第二类买点（纯日线，无需30分钟K线） ======
function executeSecondBuyDailyStrategy(data, _params) {
    const results = [];
    for (const item of data) {
        const kline = item.kline;
        if (!kline || kline.length < 60) continue;

        const daily = kline.slice(-120);
        const closes = daily.map(k => k.close);
        const lows = daily.map(k => k.low);
        const highs = daily.map(k => k.high);
        const volumes = daily.map(k => k.volume);
        const dailyMacd = computeMACD(closes);

        // === 第一步：找日线第一类买点（底背驰） ===
        const lookback = Math.min(20, Math.floor(daily.length / 3));
        const recentLow = Math.min(...lows.slice(-lookback));
        const recentLowIdx = lows.lastIndexOf(recentLow, lows.length - 1);
        if (recentLowIdx < 10) continue;

        const prevSegment = lows.slice(0, recentLowIdx - 5);
        if (prevSegment.length < 10) continue;
        const prevLow = Math.min(...prevSegment.slice(-15));
        const prevLowIdx = lows.lastIndexOf(prevLow, prevSegment.length - 1);
        if (prevLowIdx < 0 || prevLowIdx >= recentLowIdx) continue;
        if (recentLowIdx - prevLowIdx < 10) continue;

        // 日线底背驰确认
        const priceNewLow = recentLow < prevLow;
        const difDivergence = priceNewLow && dailyMacd.dif[recentLowIdx] > dailyMacd.dif[prevLowIdx];
        if (!difDivergence) continue;

        // === 第二步：从一买低点之后找反弹高点 ===
        const afterBuy = daily.slice(recentLowIdx);
        if (afterBuy.length < 10) continue;

        // 反弹高点（一买低点之后的最高价）
        const reboundHigh = Math.max(...afterBuy.map(k => k.high));
        const reboundHighIdx = highs.lastIndexOf(reboundHigh, highs.length - 1);
        if (reboundHighIdx <= recentLowIdx) continue;

        // 反弹幅度
        const reboundPct = (reboundHigh - recentLow) / recentLow * 100;
        if (reboundPct < 5) continue; // 反弹至少5%

        // 当前价格
        const currentPrice = closes[closes.length - 1];
        const currentHigh = highs[highs.length - 1];

        // === 第三��：检查回调 ===
        // 当前价格必须从反弹高点有所回落
        const pullbackFromHigh = (reboundHigh - currentPrice) / reboundHigh * 100;
        if (pullbackFromHigh < 2) continue; // 至少回调2%才算有回调

        // 核心条件：回调不破一买低点
        const notBreakLow = currentPrice > recentLow * 1.005;
        if (!notBreakLow) continue;

        // === 评分 ===
        let score = 0;
        const signals = [];

        // 日线底背驰基础分
        score += 25;
        signals.push('日线底背驰');

        // 反弹幅度
        score += Math.min(10, Math.floor(reboundPct));
        signals.push(`反弹${reboundPct.toFixed(1)}%`);

        // 回调不破前低（核心）
        score += 25;
        signals.push('回调不破前低');

        // 回调幅度适中（3%~20%）
        if (pullbackFromHigh >= 3 && pullbackFromHigh <= 20) {
            score += 10;
            signals.push(`回调${pullbackFromHigh.toFixed(1)}%`);
        }

        // 回调缩量（反弹高段量 vs 当前量）
        const volAtHigh = volumes.slice(Math.max(0, reboundHighIdx - 2), reboundHighIdx + 2).reduce((a, b) => a + b, 0) / 4;
        const volRecent = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
        if (volRecent < volAtHigh * 0.8 && volAtHigh > 0) {
            score += 15;
            signals.push('缩量回调');
        }

        // DIF回抽0轴（从反弹高位向0轴回归）
        const dif = dailyMacd.dif;
        const difAtLow = dif[recentLowIdx];
        const difRecent = dif[dif.length - 1];
        const maxDifAfterBuy = Math.max(...dif.slice(recentLowIdx));
        // DIF从高位回落但仍高于一买时的DIF
        const difPullback = maxDifAfterBuy > 0 && difRecent < maxDifAfterBuy * 0.7 && difRecent > difAtLow;
        if (difPullback) {
            score += 15;
            signals.push('DIF回抽0轴');
        }

        // 底分型确认
        const recent10 = daily.slice(-10);
        for (let i = 1; i < recent10.length - 1; i++) {
            if (isBottomFractal(recent10[i - 1], recent10[i], recent10[i + 1])) {
                score += 10;
                signals.push('底分型确认');
                break;
            }
        }

        // 价格在MA20附近（不要太远）
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        if (Math.abs(currentPrice - ma20) / ma20 < 0.15) {
            score += 5;
            signals.push('价近MA20');
        }

        if (score >= 50) {
            results.push({
                code: item.code,
                name: item.name,
                score: Math.min(100, score),
                signals,
                metrics: {
                    price: item.price,
                    changePercent: item.changePercent,
                    score: Math.min(100, score),
                    firstBuyLow: recentLow,
                    reboundHigh,
                    reboundPct: parseFloat(reboundPct.toFixed(2)),
                    pullbackPct: parseFloat(pullbackFromHigh.toFixed(2)),
                    currentPrice: parseFloat(currentPrice.toFixed(2)),
                    difAtLow: parseFloat(difAtLow.toFixed(4)),
                    difRecent: parseFloat(difRecent.toFixed(4)),
                },
            });
        }
    }
    return results;
}

// ====== Plugin Definition ======
const plugin = {
    id: 'chan-buy-points',
    name: '缠论买卖点',
    version: '1.1.0',
    description: '基于缠论第一类买点和第二类买点的精准选股策略。日线第一类买点（底背驰）+ 30分钟第二类买点 + 日线第二类买点。',
    strategies: [
        {
            id: 'chan-first-buy',
            name: '日线第一类买点',
            description: '日线底背驰选股 — 价格新低但MACD不新低，辅以底分型确认、缩量见底。缠论第24课定义的第一类买点。',
            category: 'reversal',
            params: [],
            execute: executeFirstBuyStrategy,
        },
        {
            id: 'chan-second-buy',
            name: '30分钟第二类买点',
            description: '日线第一类买点成立后，30分钟线寻找第二类买点 — 冲高回落不破前低，缩量回调至0轴附近。缠论第18课定义的第二类买点。需要30分钟K线数据。',
            category: 'reversal',
            params: [],
            execute: executeSecondBuyStrategy,
        },
        {
            id: 'chan-second-buy-daily',
            name: '日线第二类买点',
            description: '纯日线第二类买点 — 日线底背驰确立后，在日线级别冲高回落不破前低、缩量回调、DIF回抽0轴。仅需日线K线数据，不需要30分钟K线。',
            category: 'reversal',
            params: [],
            execute: executeSecondBuyDailyStrategy,
        },
    ],
};
exports.default = plugin;
