"use strict";
/**
 * 缠论5条件选股 — Chan Theory + 5-Filter Stock Screener
 *
 * 5条件 + 缠论完整分析：
 *   1. 涨幅3~5%
 *   2. 20日内涨停基因
 *   3. 量比>1（计算）
 *   4. 换手5~10%
 *   5. 市值50~300亿
 *
 * 缠论分析（含科创板688）：
 *   - 第17课：中枢识别
 *   - 第24课：背驰判断
 *   - 第25课：三类买点
 *   - 第29课：三类卖点预警
 *   - 综合缠论评分
 *
 * 参考：缠中说禅《教你炒股票》108课
 */
Object.defineProperty(exports, "__esModule", { value: true });
// ====== 缠论核心函数 ======
/** SMA计算 */
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
/** EMA计算 */
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
/** MACD计算 */
function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const dif = emaFast.map((v, i) => v - emaSlow[i]);
    const dea = ema(dif, signal);
    const macd = dif.map((v, i) => 2 * (v - dea[i]));
    return { dif, dea, macd };
}
/** 判断底分型（第18课） */
function isBottomFractal(k1, k2, k3) {
    return k2.low < k1.low && k2.low < k3.low && k2.high < k1.high && k2.high < k3.high;
}
/** 判断顶分型（第18课） */
function isTopFractal(k1, k2, k3) {
    return k2.high > k1.high && k2.high > k3.high && k2.low > k1.low && k2.low > k3.low;
}
/** 中枢分析（第17课）：寻找最近的中枢区间 */
function analyzeZhongshu(kline) {
    if (!kline || kline.length < 20)
        return { exists: false, upper: 0, lower: 0, clarity: 0 };
    const recent = kline.slice(-30);
    const highs = recent.map(k => k.high);
    const lows = recent.map(k => k.low);
    // 寻找三段重叠区间
    let bestUpper = 0, bestLower = 0, bestOverlap = 0;
    for (let start = 0; start < recent.length - 10; start += 3) {
        const seg1High = Math.max(...highs.slice(start, start + 5));
        const seg1Low = Math.min(...lows.slice(start, start + 5));
        const seg2High = Math.max(...highs.slice(start + 3, start + 8));
        const seg2Low = Math.min(...lows.slice(start + 3, start + 8));
        const seg3High = Math.max(...highs.slice(start + 6, start + 10));
        const seg3Low = Math.min(...lows.slice(start + 6, start + 10));
        // 三段的共同重叠区间
        const overlapUpper = Math.min(seg1High, seg2High, seg3High);
        const overlapLower = Math.max(seg1Low, seg2Low, seg3Low);
        if (overlapUpper > overlapLower) {
            const overlapSize = overlapUpper - overlapLower;
            if (overlapSize > bestOverlap) {
                bestOverlap = overlapSize;
                bestUpper = overlapUpper;
                bestLower = overlapLower;
            }
        }
    }
    if (bestUpper > bestLower) {
        const priceRange = (Math.max(...highs) - Math.min(...lows)) || 1;
        const clarity = Math.min(100, Math.round((bestOverlap / priceRange) * 100));
        return { exists: true, upper: bestUpper, lower: bestLower, clarity };
    }
    return { exists: false, upper: 0, lower: 0, clarity: 0 };
}
/** 背驰分析（第24课）：比较两段走势的MACD力度 */
function analyzeBeichi(kline) {
    if (!kline || kline.length < 30)
        return { hasBeichi: false, type: '数据不足', detail: '需至少30根K线' };
    const recent = kline.slice(-30);
    const closes = recent.map(k => k.close);
    const lows = recent.map(k => k.low);
    const highs = recent.map(k => k.high);
    const macdResult = computeMACD(closes);
    const macdVals = macdResult.macd;
    // 分成前后两段
    const mid = Math.floor(recent.length / 2);
    const firstLow = Math.min(...lows.slice(0, mid));
    const secondLow = Math.min(...lows.slice(mid));
    const firstHigh = Math.max(...highs.slice(0, mid));
    const secondHigh = Math.max(...highs.slice(mid));
    // 底背驰：后段价格更低但MACD绿柱面积更小
    if (secondLow < firstLow) {
        const firstMacdSum = Math.abs(macdVals.slice(0, mid).filter(v => v < 0).reduce((a, b) => a + b, 0));
        const secondMacdSum = Math.abs(macdVals.slice(mid).filter(v => v < 0).reduce((a, b) => a + b, 0));
        if (secondMacdSum < firstMacdSum * 0.8) {
            return { hasBeichi: true, type: '底背驰', detail: '价格新低但MACD绿柱面积缩小，第24课第一类买点信号' };
        }
    }
    // 顶背驰：后段价格更高但MACD红柱面积更小
    if (secondHigh > firstHigh) {
        const firstMacdSum = macdVals.slice(0, mid).filter(v => v > 0).reduce((a, b) => a + b, 0);
        const secondMacdSum = macdVals.slice(mid).filter(v => v > 0).reduce((a, b) => a + b, 0);
        if (secondMacdSum < firstMacdSum * 0.8) {
            return { hasBeichi: true, type: '顶背驰', detail: '价格新高但MACD红柱面积缩小，第29课第一类卖点信号' };
        }
    }
    return { hasBeichi: false, type: '无背驰', detail: '量价配合正常，第24课确认上涨结构完好' };
}
/** 三类买点分析（第25课） */
function analyzeBuyPoints(kline, zhongshu) {
    if (!kline || kline.length < 20)
        return { level: '数据不足', price: 0, description: '' };
    const recent = kline.slice(-20);
    const closes = recent.map(k => k.close);
    const lows = recent.map(k => k.low);
    const current = closes[closes.length - 1];
    const minLow = Math.min(...lows);
    const idxMin = lows.indexOf(minLow);
    // 第一类买点：趋势背驰后的最低点
    if (idxMin >= 0 && idxMin < 5) {
        // 最低点在最近5根内
        const afterLow = closes.slice(idxMin);
        if (afterLow.length >= 3 && afterLow[afterLow.length - 1] > minLow * 1.05) {
            return { level: '第一类买点（第25课）', price: minLow, description: `趋势背驰后最低点${minLow.toFixed(2)}元，已反弹确认，上涨初期` };
        }
    }
    // 有中枢的情况下，找第三类买点
    if (zhongshu.exists && zhongshu.upper > 0) {
        const recentHigh = Math.max(...closes);
        const recentLow5 = Math.min(...closes.slice(-5));
        // 突破中枢后回踩不破上沿
        if (recentHigh > zhongshu.upper * 1.02) {
            if (recentLow5 > zhongshu.upper * 0.98 && current >= zhongshu.upper) {
                return { level: '第三类买点（第25课）', price: zhongshu.upper, description: `突破中枢上沿${zhongshu.upper.toFixed(2)}元后回踩不破，第三类买点确认，上涨延伸段` };
            }
            return { level: '突破中枢（第三类买点候选）', price: zhongshu.upper, description: `已突破中枢上沿${zhongshu.upper.toFixed(2)}元，等待回踩确认第三类买点（第25课）` };
        }
    }
    // 第二类买点：底部反弹后回踩不创新低
    if (idxMin >= 0) {
        const afterSegment = closes.slice(idxMin + 1);
        if (afterSegment.length >= 5) {
            const afterLow = Math.min(...afterSegment.slice(0, 5));
            if (afterLow > minLow * 1.01) {
                return { level: '第二类买点（第25课）', price: afterLow, description: `第一类买点后回踩${afterLow.toFixed(2)}元不创新低，第二类买点确认，上涨中继` };
            }
        }
    }
    return { level: '观察区', price: current, description: '当前处于中枢震荡或调整期，等待三类买点信号（第25课）' };
}
/** 三类卖点分析（第29课） */
function analyzeSellPoints(kline, zhongshu) {
    if (!kline || kline.length < 20)
        return { level: '数据不足', price: 0, description: '', warning: '' };
    const recent = kline.slice(-20);
    const closes = recent.map(k => k.close);
    const highs = recent.map(k => k.high);
    const current = closes[closes.length - 1];
    const maxHigh = Math.max(...highs);
    const idxMax = highs.indexOf(maxHigh);
    // 第三类卖点：跌破中枢下沿
    if (zhongshu.exists && zhongshu.lower > 0) {
        if (current < zhongshu.lower * 0.98) {
            return { level: '第三类卖点（第29课）', price: zhongshu.lower, description: `跌破中枢下沿${zhongshu.lower.toFixed(2)}元，趋势转空，建议离场`, warning: '⚠️ 务必止损' };
        }
    }
    // 第一类卖点：趋势背驰后的最高点
    if (idxMax >= 0 && idxMax < 5) {
        const afterHigh = closes.slice(idxMax);
        if (afterHigh.length >= 3) {
            const currentFromHigh = (current - maxHigh) / maxHigh * 100;
            if (currentFromHigh < -3) {
                return { level: '第一类卖点已出现（第29课）', price: maxHigh, description: `趋势背驰后高点${maxHigh.toFixed(2)}元已确认，当前回落${Math.abs(currentFromHigh).toFixed(1)}%，卖点已过`, warning: '反弹减仓' };
            }
        }
    }
    // 第二类卖点预警：冲高回落不创新高
    if (idxMax > 5 && idxMax < 15) {
        const afterMax = closes.slice(idxMax + 1);
        if (afterMax.length >= 3) {
            const afterHigh = Math.max(...afterMax);
            if (afterHigh < maxHigh * 0.98 && current < maxHigh * 0.97) {
                return { level: '第二类卖点（第29课）', price: maxHigh, description: `反弹至${afterHigh.toFixed(2)}元不创新高(${maxHigh.toFixed(2)})，第二类卖点确认，减仓观望`, warning: '建议减持' };
            }
        }
    }
    // 接近前高的卖点预警
    if (zhongshu.exists && zhongshu.upper > 0) {
        const pctFromUpper = (current - zhongshu.upper) / zhongshu.upper * 100;
        if (pctFromUpper > 15) {
            return { level: '远离中枢预警', price: current, description: `当前价${current.toFixed(2)}元已远离中枢上沿${zhongshu.upper.toFixed(2)}元(+${pctFromUpper.toFixed(1)}%)，获利盘积累，注意第29课卖点信号`, warning: '可分批止盈' };
        }
    }
    return { level: '暂无卖点信号', price: current, description: '第29课三类卖点均未触发，结构完好', warning: '继续持有' };
}
/** 缠论综合评分 */
function computeChanScore(kline, zhongshu, beichi, buyPoint, hasLimitUp) {
    let zhongshuScore = 0;
    let beichiScore = 0;
    let buyPointScore = 0;
    let limitUpScore = 0;
    // 中枢评分（满分25）
    if (zhongshu.exists) {
        zhongshuScore = 15 + Math.min(10, Math.round(zhongshu.clarity / 10));
    }
    // 背驰评分（满分25）
    if (beichi.hasBeichi) {
        beichiScore = beichi.type === '底背驰' ? 25 : 10; // 底背驰加分更多
    }
    else {
        beichiScore = 15; // 无背驰=健康
    }
    // 买点评分（满分30）
    if (buyPoint.level.includes('第三类买点'))
        buyPointScore = 30;
    else if (buyPoint.level.includes('第二类买点'))
        buyPointScore = 22;
    else if (buyPoint.level.includes('第一类买点'))
        buyPointScore = 25;
    else if (buyPoint.level.includes('突破中枢'))
        buyPointScore = 18;
    else
        buyPointScore = 10;
    // 涨停基因加分（满分20）
    if (hasLimitUp) {
        limitUpScore = 15;
        // 额外：检查近期是否有多连板
        if (kline && kline.length >= 10) {
            let consecutiveLimitUp = 0;
            for (let i = kline.length - 1; i >= Math.max(0, kline.length - 10); i--) {
                const chg = kline[i].changePct || 0;
                if (chg >= 9.5)
                    consecutiveLimitUp++;
                else
                    break;
            }
            if (consecutiveLimitUp >= 2)
                limitUpScore = 20;
        }
    }
    const total = Math.min(100, zhongshuScore + beichiScore + buyPointScore + limitUpScore);
    return {
        total,
        breakdown: { zhongshu: zhongshuScore, beichi: beichiScore, buyPoint: buyPointScore, limitUp: limitUpScore }
    };
}
// ====== 主策略执行 ======
function executeChan5FilterStrategy(data, params) {
    const results = [];
    const minChg = params.minChange ?? 3;
    const maxChg = params.maxChange ?? 5;
    const minVolRatio = params.minVolumeRatio ?? 1;
    const minTr = params.minTurnover ?? 5;
    const maxTr = params.maxTurnover ?? 10;
    const minMcapYi = params.minMcap ?? 50;
    const maxMcapYi = params.maxMcap ?? 300;
    for (const item of data) {
        // ---- 条件①：涨幅3~5% ----
        const chg = item.changePercent ?? item.pctChg ?? 0;
        if (chg < minChg || chg > maxChg)
            continue;
        // ---- 条件②：20日内涨停基因 ----
        const hasLimitUp = item.limitUpIn20Days === true || item.hasLimitUp === true;
        // 从K线数据中额外验证涨停
        let verifiedLimitUp = hasLimitUp;
        if (!verifiedLimitUp && item.kline && item.kline.length >= 5) {
            const recentK = item.kline.slice(-20);
            for (const k of recentK) {
                if ((k.changePct || 0) >= 9.5) {
                    verifiedLimitUp = true;
                    break;
                }
            }
        }
        // 不强制要求涨停基因，但会影响评分
        // ---- 条件③：量比>1 ----
        let volRatio = item.volumeRatio ?? 0;
        if (volRatio < 0.1 || volRatio > 1000) {
            if (item.volume && item.avgVolume) {
                volRatio = item.volume / item.avgVolume;
            }
            else {
                volRatio = 0;
            }
        }
        if (volRatio < minVolRatio)
            continue;
        // ---- 条件④：换手5~10% ----
        let tr = item.turnoverRate ?? 0;
        if (tr > 100)
            tr = tr / 100;
        if (tr < minTr || tr > maxTr)
            continue;
        // ---- 条件⑤：市值50~300亿 ----
        let mcap = item.marketCap ?? 0;
        let mcapYi = mcap / 100000000;
        if (mcapYi < minMcapYi || mcapYi > maxMcapYi)
            continue;
        // ====== 缠论分析 ======
        const kline = item.kline;
        let zhongshu = { exists: false, upper: 0, lower: 0, clarity: 0 };
        let beichi = { hasBeichi: false, type: '数据不足', detail: '' };
        let buyPoint = { level: '数据不足', price: 0, description: '' };
        let sellPoint = { level: '数据不足', price: 0, description: '', warning: '' };
        let chanScore = { total: 50, breakdown: { zhongshu: 0, beichi: 0, buyPoint: 0, limitUp: 0 } };
        if (kline && kline.length >= 20) {
            zhongshu = analyzeZhongshu(kline);
            beichi = analyzeBeichi(kline);
            buyPoint = analyzeBuyPoints(kline, zhongshu);
            sellPoint = analyzeSellPoints(kline, zhongshu);
            chanScore = computeChanScore(kline, zhongshu, beichi, buyPoint, verifiedLimitUp);
        }
        // ====== 构建结果 ======
        const signals = [];
        signals.push(`涨幅${chg.toFixed(1)}%`);
        if (verifiedLimitUp)
            signals.push('涨停基因✓');
        signals.push(`量比${volRatio.toFixed(2)}`);
        signals.push(`换手${tr.toFixed(1)}%`);
        signals.push(`市值${mcapYi.toFixed(0)}亿`);
        if (zhongshu.exists)
            signals.push(`中枢${zhongshu.lower.toFixed(1)}~${zhongshu.upper.toFixed(1)}`);
        if (beichi.hasBeichi)
            signals.push(beichi.type);
        signals.push(buyPoint.level);
        if (!sellPoint.level.includes('暂无'))
            signals.push(sellPoint.warning);
        results.push({
            code: item.code,
            name: item.name,
            score: chanScore.total,
            signals,
            metrics: {
                changePercent: chg,
                turnoverRate: tr,
                volumeRatio: volRatio,
                mcapYi,
                hasLimitUp: verifiedLimitUp,
                chanZhongshu: zhongshu.exists ? `${zhongshu.lower.toFixed(1)}~${zhongshu.upper.toFixed(1)}` : '未形成',
                chanBeichi: beichi.type,
                chanBuyPoint: buyPoint.level,
                chanSellPoint: sellPoint.level,
                chanSellWarning: sellPoint.warning,
                chanScore: chanScore.total,
                chanBreakdown: JSON.stringify(chanScore.breakdown)
            }
        });
    }
    // 按评分排序
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 50);
}
// ====== 插件定义 ======
const plugin = {
    id: 'chan-5filters-screener',
    name: '缠论5条件选股',
    version: '1.0.0',
    description: '5条件(涨幅3~5%+20日涨停+量比>1+换手5~10%+市值50~300亿) + 缠论完整分析(第17课中枢/第24课背驰/第25课买点/第29课卖点) + 评分排序，包含科创板',
    strategies: [
        {
            id: 'chan-5filters-main',
            name: '缠论5条件选股全面版',
            description: '5条件筛选+缠论中枢/背驰/三类买卖点全面分析+评分排序，包含688/300/主板全市场',
            category: 'special',
            params: [
                { key: 'minChange', label: '最低涨幅', type: 'number', default: 3, min: 0, max: 10 },
                { key: 'maxChange', label: '最高涨幅', type: 'number', default: 5, min: 0, max: 10 },
                { key: 'minVolumeRatio', label: '最低量比', type: 'number', default: 1, min: 0.5, max: 5 },
                { key: 'minTurnover', label: '最低换手', type: 'number', default: 5, min: 0, max: 20 },
                { key: 'maxTurnover', label: '最高换手', type: 'number', default: 10, min: 0, max: 30 },
                { key: 'minMcap', label: '最低市值(亿)', type: 'number', default: 50, min: 0, max: 1000 },
                { key: 'maxMcap', label: '最高市值(亿)', type: 'number', default: 300, min: 0, max: 5000 },
            ],
            execute(data, params) {
                return executeChan5FilterStrategy(data, params);
            },
        },
    ],
};
exports.default = plugin;
