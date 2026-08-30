"use strict";
/**
 * 缠论买卖点 — 日线第一类买点 + 日线第二类买点 + 日线第三类买点
 *
 * 基于缠论核心买卖点理论：
 *   1. 日线第一类买点：底背驰（价格新低 + MACD不新低 + 底分型确认）
 *   2. 日线第二类买点：一买确立后，冲高回落不破前低（纯日线，无需30分钟K线）
 *   3. 日线第三类买点：突破中枢后回踩确认（缠论第18、25课）
 */
// ====== Helper: EMA ======
function ema(values, period) {
    const result = [];
    const multiplier = 2 / (period + 1);
    for (let i = 0; i < values.length; i++) {
        if (i === 0)
            result.push(values[i]);
        else
            result.push((values[i] - result[i - 1]) * multiplier + result[i - 1]);
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
// ====== Helper: 底分型（修正版） ======
// 缠论第17课：中间K线的低点最低即为底分型，不要求高点也最低
function isBottomFractal(k1, k2, k3) {
    return k2.low < k1.low && k2.low < k3.low;
}
// ====== Helper: 顶分型（修正版） ======
// 缠论第17课：中间K线的高点最高即为顶分型，不要求低点也最高
function isTopFractal(k1, k2, k3) {
    return k2.high > k1.high && k2.high > k3.high;
}
// ====== Helper: SMA ======
function sma(values, period) {
    const result = [];
    for (let i = 0; i < values.length; i++) {
        if (i < period - 1) {
            result.push(NaN);
            continue;
        }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++)
            sum += values[j];
        result.push(sum / period);
    }
    return result;
}
// ====== Helper: 寻找最后一个下跌中枢（近似） ======
// 在指定范围 [startIdx, endIdx) 内，找到最后一个价格窄幅波动的区间
// 用来代替以前简单取最后15根K线最低点的做法
function findLastConsolidation(highs, lows, endIdx, minBars = 8, maxRangePct = 12) {
    const startIdx = Math.max(0, endIdx - 40);
    let bestZone = null;
    for (let i = endIdx - minBars; i >= startIdx; i--) {
        const zoneHigh = Math.max(...highs.slice(i, endIdx));
        const zoneLow = Math.min(...lows.slice(i, endIdx));
        const midPrice = (zoneHigh + zoneLow) / 2;
        const rangePct = midPrice > 0 ? (zoneHigh - zoneLow) / midPrice * 100 : 999;
        if (rangePct <= maxRangePct) {
            // 找到！用这个区间的最低点作为前低参考
            bestZone = { start: i, low: zoneLow, high: zoneHigh, rangePct };
            break; // 取离最近的
        }
    }
    // 保底：如果没找到合适的盘整区间，用 endIdx-20 到 endIdx-5 的最低点
    if (!bestZone) {
        const fallbackStart = Math.max(0, endIdx - 20);
        const fallbackLow = Math.min(...lows.slice(fallbackStart, Math.max(0, endIdx - 3)));
        return { start: fallbackStart, low: fallbackLow, high: Math.max(...highs.slice(fallbackStart, endIdx)), rangePct: -1 };
    }
    return bestZone;
}
// ====== Helper: 寻找摆动高点和低点（用于三买的中枢识别） ======
function findSwingPoints(klines, lookback = 60) {
    const swings = [];
    const len = Math.min(lookback, klines.length);
    for (let i = 1; i < len - 1; i++) {
        const prev = klines[i - 1];
        const curr = klines[i];
        const next = klines[i + 1];
        if (isTopFractal(prev, curr, next)) {
            swings.push({ idx: i, type: 'high', price: curr.high, date: curr.date });
        }
        if (isBottomFractal(prev, curr, next)) {
            swings.push({ idx: i, type: 'low', price: curr.low, date: curr.date });
        }
    }
    return swings;
}
// ====== Helper: 从摆动点划分线段 ======
// 从摆动点中提取交替的高低点作为"线段"
function extractSegments(swings) {
    const segments = [];
    if (swings.length < 2)
        return segments;
    for (let i = 0; i < swings.length - 1; i++) {
        const curr = swings[i];
        const next = swings[i + 1];
        if (curr.type !== next.type) {
            segments.push({
                startIdx: curr.idx,
                endIdx: next.idx,
                startPrice: curr.price,
                endPrice: next.price,
                high: Math.max(curr.price, next.price),
                low: Math.min(curr.price, next.price),
                direction: next.price > curr.price ? 'up' : 'down',
            });
        }
    }
    return segments;
}
// ====== Helper: 寻找缠论中枢 ======
// 中枢 = 至少三个连续线段的价格区间重叠
function findZhongShu(segments, minOverlapBars = 3) {
    if (segments.length < 3)
        return null;
    for (let i = 0; i <= segments.length - 3; i++) {
        const s1 = segments[i];
        const s2 = segments[i + 1];
        const s3 = segments[i + 2];
        // 三个线段必须有交替方向（上-下-上 或 下-上-下）
        if (s1.direction === s2.direction || s2.direction === s3.direction)
            continue;
        // 找三个线段的最大重叠区间
        const overlapHigh = Math.min(s1.high, s2.high, s3.high);
        const overlapLow = Math.max(s1.low, s2.low, s3.low);
        // 必须有正的重叠区间
        if (overlapHigh > overlapLow) {
            // 重叠区间要有一定宽度（至少覆盖 minOverlapBars 根K线）
            const rangePct = (overlapHigh - overlapLow) / ((overlapHigh + overlapLow) / 2) * 100;
            if (rangePct > 0.5) {
                return {
                    high: overlapHigh,
                    low: overlapLow,
                    mid: (overlapHigh + overlapLow) / 2,
                    startIdx: s1.startIdx,
                    endIdx: s3.endIdx,
                    rangePct,
                    direction: s1.direction,
                };
            }
        }
    }
    return null;
}
// ====== Strategy 1: 日线第一类买点（底背驰） ======
function executeFirstBuyStrategy(data, _params) {
    const results = [];
    for (const item of data) {
        const kline = item.kline;
        if (!kline || kline.length < 60)
            continue;
        const recent = kline.slice(-120);
        const closes = recent.map(k => k.close);
        const lows = recent.map(k => k.low);
        const highs = recent.map(k => k.high);
        const volumes = recent.map(k => k.volume);
        const macdResult = computeMACD(closes);
        const dif = macdResult.dif;
        // 找最近一个显著低点
        const lookback = Math.min(20, Math.floor(recent.length / 3));
        const recentMin = Math.min(...lows.slice(-lookback));
        const recentIdx = lows.lastIndexOf(recentMin, lows.length - 1);
        if (recentIdx < 15)
            continue;
        // === 改进：用盘整区间识别代替粗糙的"取前15根" ===
        // 在 recentIdx 之前寻找一个盘整区间（≈最后一个中枢的近似）
        const consolidation = findLastConsolidation(highs, lows, recentIdx - 3);
        if (!consolidation || consolidation.start < 0)
            continue;
        const prevLow = consolidation.low;
        const prevIdx = lows.lastIndexOf(prevLow, consolidation.start + 10);
        if (prevIdx < 0 || prevIdx >= recentIdx || recentIdx - prevIdx < 8)
            continue;
        // === 第一类买点评分（v1.5.0: DIF底背驰+底分型改为必须条件） ===
        let score = 0;
        const signals = [];
        // === 必须条件1: DIF底背驰 ===
        const priceNewLow = recentMin < prevLow;
        const difAtRecent = dif[recentIdx];
        const difAtPrev = dif[prevIdx];
        const difDivergence = priceNewLow && difAtRecent > difAtPrev;
        if (!difDivergence) continue;
        score += 10;
        signals.push('DIF底背驰');
        // === 必须条件2: 底分型确认 ===
        const nearLowStart = Math.max(0, recentIdx - 3);
        const nearLowEnd = Math.min(recent.length, recentIdx + 8);
        let hasFractal = false;
        for (let i = Math.max(1, nearLowStart); i < nearLowEnd - 1; i++) {
            if (isBottomFractal(recent[i - 1], recent[i], recent[i + 1])) {
                hasFractal = true;
                break;
            }
        }
        if (!hasFractal) continue;
        score += 15;
        signals.push('底分型确认');
        // === 硬条件3: MACD绿柱面积缩小（缠论第37课：背驰的MACD验证） ===
        const prevMacdArea = macdResult.macd.slice(prevIdx - 3, prevIdx + 4).filter(v => v < 0).reduce((a, b) => a + b, 0);
        const recentMacdArea = macdResult.macd.slice(recentIdx - 3, recentIdx + 4).filter(v => v < 0).reduce((a, b) => a + b, 0);
        const macdShrinking = prevMacdArea < 0 && recentMacdArea < 0 && recentMacdArea > prevMacdArea;
        if (!macdShrinking) continue;
        score += 15;
        signals.push('MACD绿柱缩小');
        // 加分项1: 价格新低
        if (priceNewLow) {
            score += 5;
            signals.push('价格新低');
        }
        // 加分项2: 成交量萎缩
        const prevVol = volumes.slice(Math.max(0, prevIdx - 2), prevIdx + 3).reduce((a, b) => a + b, 0) / 5;
        const recentVol = volumes.slice(Math.max(0, recentIdx - 2), recentIdx + 3).reduce((a, b) => a + b, 0) / 5;
        if (recentVol < prevVol * 0.8 && prevVol > 0) {
            score += 10;
            signals.push('缩量见底');
        }
        // 条件4: 价格从低点回升
        const recentClose = closes[closes.length - 1];
        const pctFromLow = (recentClose - recentMin) / recentMin * 100;
        if (pctFromLow > 2) {
            score += 10;
            signals.push(`回升${pctFromLow.toFixed(1)}%`);
        }
        // 条件5: DIF拐头向上
        if (difAtRecent < 0 && dif.length > recentIdx + 3) {
            const difTrend = dif[recentIdx + 3] > difAtRecent;
            if (difTrend) {
                score += 10;
                signals.push('DIF拐头向上');
            }
        }
        // 条件6: 盘整区间确认
        if (consolidation.rangePct > 0 && consolidation.rangePct < 15) {
            score += 5;
            signals.push('背驰段确认');
        }
        if (score >= 75) {
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
// ====== Strategy 2: 日线第二类买点（纯日线） ======
function executeSecondBuyDailyStrategy(data, _params) {
    const results = [];
    for (const item of data) {
        const kline = item.kline;
        if (!kline || kline.length < 60)
            continue;
        const daily = kline.slice(-120);
        const closes = daily.map(k => k.close);
        const lows = daily.map(k => k.low);
        const highs = daily.map(k => k.high);
        const volumes = daily.map(k => k.volume);
        const dailyMacd = computeMACD(closes);
        // === 第一步：找日线第一类买点（底背驰） ===
        // 使用与一买策略一致的判断标准
        const lookback = Math.min(20, Math.floor(daily.length / 3));
        const recentLow = Math.min(...lows.slice(-lookback));
        const recentLowIdx = lows.lastIndexOf(recentLow, lows.length - 1);
        if (recentLowIdx < 15)
            continue;
        const consolidation = findLastConsolidation(highs, lows, recentLowIdx - 3);
        if (!consolidation)
            continue;
        const prevLow = consolidation.low;
        const prevLowIdx = lows.lastIndexOf(prevLow, consolidation.start + 10);
        if (prevLowIdx < 0 || prevLowIdx >= recentLowIdx)
            continue;
        if (recentLowIdx - prevLowIdx < 8)
            continue;
        // 日线底背驰确认（与一买策略统一）
        const priceNewLow = recentLow < prevLow;
        const difDivergence = priceNewLow && dailyMacd.dif[recentLowIdx] > dailyMacd.dif[prevLowIdx];
        if (!difDivergence)
            continue;
        // 额外底分型确认（统一的附加条件）
        let nearLowHasFractal = false;
        for (let i = Math.max(1, recentLowIdx - 2); i < Math.min(daily.length - 1, recentLowIdx + 6); i++) {
            if (isBottomFractal(daily[i - 1], daily[i], daily[i + 1])) {
                nearLowHasFractal = true;
                break;
            }
        }
        if (!nearLowHasFractal)
            continue;
        // === 第二步：从一买低点之后找反弹高点 ===
        const afterBuy = daily.slice(recentLowIdx);
        if (afterBuy.length < 10)
            continue;
        // 反弹高点：在一买低点之后精确搜索最高点（修复 lastIndexOf 问题）
        let reboundHigh = 0;
        let reboundHighIdx = recentLowIdx;
        // 用 for 循环精确找一买后的最高点和位置
        for (let i = recentLowIdx; i < highs.length; i++) {
            if (highs[i] > reboundHigh) {
                reboundHigh = highs[i];
                reboundHighIdx = i;
            }
        }
        if (reboundHighIdx <= recentLowIdx)
            continue;
        // 反弹确认：一买后价格回升（缠论：只要有回升即可）
        const reboundPct = (reboundHigh - recentLow) / recentLow * 100;
        if (reboundPct <= 0)
            continue;
        // === 第三步：检查回调 ===
        const currentPrice = closes[closes.length - 1];
        // 回落确认：当前价低于反弹高点即可（缠论：只要有回落）
        const pullbackFromHigh = (reboundHigh - currentPrice) / reboundHigh * 100;
        if (pullbackFromHigh <= 0)
            continue;
        // 核心条件：回落不破一买低点（给1%缓冲）
        const notBreakLow = currentPrice > recentLow * 1.01;
        if (!notBreakLow)
            continue;
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
        // 回调幅度适中（3%~30%）
        if (pullbackFromHigh >= 3 && pullbackFromHigh <= 30) {
            score += 10;
            signals.push(`回调${pullbackFromHigh.toFixed(1)}%`);
        }
        // 回调缩量（反弹高位量 vs 当前量）
        const volAtHigh = volumes.slice(Math.max(0, reboundHighIdx - 2), reboundHighIdx + 3).reduce((a, b) => a + b, 0) / 5;
        const volRecent = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
        if (volRecent < volAtHigh * 0.8 && volAtHigh > 0) {
            score += 15;
            signals.push('缩量回调');
        }
        // DIF回抽0轴
        const dif = dailyMacd.dif;
        const difAtLow = dif[recentLowIdx];
        const difRecent = dif[dif.length - 1];
        const maxDifAfterBuy = Math.max(...dif.slice(recentLowIdx));
        const difPullback = maxDifAfterBuy > 0 && difRecent < maxDifAfterBuy * 0.7 && difRecent > difAtLow;
        if (difPullback) {
            score += 15;
            signals.push('DIF回抽0轴');
        }
        // 底分型确认（回调区域出现底分型）
        const recentDaily10 = daily.slice(-10);
        for (let i = 1; i < recentDaily10.length - 1; i++) {
            if (isBottomFractal(recentDaily10[i - 1], recentDaily10[i], recentDaily10[i + 1])) {
                score += 10;
                signals.push('底分型确认');
                break;
            }
        }
        // 价格在MA20附近
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        if (Math.abs(currentPrice - ma20) / ma20 < 0.15) {
            score += 5;
            signals.push('价近MA20');
        }
        if (score >= 65) {
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
// ====== Strategy 3: 日线第三类买点（修正版） ======
function executeThirdBuyStrategy(data, _params) {
    const results = [];
    const pivotPeriod = (_params.pivotPeriod) || 30;
    for (const item of data) {
        const kline = item.kline;
        if (!kline || kline.length < 60)
            continue;
        const recent = kline.slice(-pivotPeriod * 2);
        const closes = recent.map(k => k.close);
        const highs = recent.map(k => k.high);
        const lows = recent.map(k => k.low);
        const volumes = recent.map(k => k.volume);
        // === 改进：用摆动段重叠识别真正缠论中枢 ===
        const swings = findSwingPoints(recent, pivotPeriod * 3);
        const segments = extractSegments(swings);
        let zhongshu = findZhongShu(segments);
        // 如果没找到严格缠论中枢，用盘整区间近似
        if (!zhongshu) {
            const approx = findLastConsolidation(highs, lows, highs.length - 5, 10, 15);
            if (approx && approx.start >= 0) {
                zhongshu = { high: approx.high, low: approx.low, mid: (approx.high + approx.low) / 2, rangePct: approx.rangePct };
            } else {
                continue;
            }
        }
        const zhongshuTop = zhongshu.high;
        // === 条件判断 ===
        // 条件1: 价格突破中枢上沿（缠论：只要有突破即满足）
        const recentHigh5 = Math.max(...highs.slice(-5));
        const priceAbovePivot = recentHigh5 > zhongshuTop;
        if (!priceAbovePivot)
            continue;
        // 条件2: 回踩不跌破中枢上沿（必须条件）
        const pullbackLow5 = Math.min(...lows.slice(-5));
        const pullbackAbovePivot = pullbackLow5 > zhongshuTop;
        if (!pullbackAbovePivot)
            continue;
        // 条件3: 必须有实际回踩（当前价低于近期高点即可）
        const currentPrice = closes[closes.length - 1];
        const hasPullback = currentPrice < recentHigh5;
        if (!hasPullback)
            continue;
        // 条件4: MACD在0轴上方（多头确认，必须条件）
        const macdResult = computeMACD(closes);
        const dif = macdResult.dif;
        const difAboveZero = dif[dif.length - 1] > 0;
        if (!difAboveZero)
            continue;
        // 条件5: 突破时放量，回踩时缩量
        const allVolumes = volumes;
        const breakZoneVol = allVolumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
        const pullbackVol = allVolumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const volConfirm = breakZoneVol > 0 && pullbackVol > 0 && pullbackVol <= breakZoneVol * 1.0;
        // 评分
        let score = 0;
        const signals = [];
        // 缠论中枢识别（核心）
        score += 15;
        signals.push('缠论中枢识别');
        score += 20;
        signals.push('突破中枢上沿');
        score += 20;
        signals.push('回踩不破中枢');
        // 成交量确认：突破放量+回踩缩量
        if (volConfirm) {
            score += 15;
            signals.push('量能配合');
        }
        if (difAboveZero) {
            score += 10;
            signals.push('MACD多头');
        }
        // 涨幅适中（刚启动）
        const chg = item.changePercent || 0;
        if (chg >= -2 && chg < 5) {
            score += 10;
            signals.push('涨幅适中');
        }
        // 中枢质量加分
        if (zhongshu.rangePct > 1 && zhongshu.rangePct < 20) {
            score += 5;
            signals.push('中枢质量好');
        }
        if (score >= 65) {
            results.push({
                code: item.code,
                name: item.name,
                score: Math.min(100, score),
                signals,
                metrics: {
                    price: item.price,
                    changePercent: item.changePercent,
                    score: Math.min(100, score),
                    zhongshuTop: parseFloat(zhongshuTop.toFixed(2)),
                    zhongshuBottom: parseFloat(zhongshu.low.toFixed(2)),
                    zhongshuRange: parseFloat(zhongshu.rangePct.toFixed(2)),
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
    version: '1.5.0',
    description: '基于缠论一买、二买、三买的完整选股策略。日线第一类买点（底背驰）+ 日线第二类买点（冲高回踩）+ 日线第三类买点（突破中枢回踩确认）。v1.5.0: 一买DIF背驰+底分型改为必须条件；三买突破提高至5%、增加回踩确认、MACD多头必须。',
    strategies: [
        {
            id: 'chan-first-buy',
            name: '日线第一类买点',
            description: '日线底背驰选股 — 价格新低但MACD不新低，辅以底分型确认、缩量见底、盘整区间确认。缠论第24课定义的第一类买点。',
            category: 'reversal',
            params: [],
            execute: executeFirstBuyStrategy,
        },
        {
            id: 'chan-second-buy-daily',
            name: '日线第二类买点',
            description: '纯日线第二类买点 — 日线底背驰确立后，在日线级别冲高回落不破前低、缩量回调、DIF回抽0轴。仅需日线K线数据，不需要30分钟K线。',
            category: 'reversal',
            params: [],
            execute: executeSecondBuyDailyStrategy,
        },
        {
            id: 'chan-third-buy',
            name: '日线第三类买点',
            description: '第三类买点选股 — 用摆动高低点识别缠论真中枢（三段次级别走势重叠），股价突破中枢上沿后回踩确认。缠论第18、25课。仅需日线K线数据。',
            category: 'breakout',
            params: [{ key: 'pivotPeriod', type: 'number', default: 30, description: '中枢搜索周期（日线，默认30）' }],
            execute: executeThirdBuyStrategy,
        },
    ],
};
module.exports = plugin;
