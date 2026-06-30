"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin = {
    id: 'ma-deviation-t',
    name: '分时均线偏离做T策略',
    version: '1.0.0',
    description: '专为做T设计的策略：基于股价与日内分时均线的偏离程度，结合振幅、换手等因素，筛选适合高抛低吸的标的。股价远离分时均线时，大概率会回拉，是做T的黄金信号。',
    strategies: [
        {
            id: 'ma-deviation-t',
            name: '分时均线偏离做T',
            description: '利用股价偏离日内分时均线的程度，结合振幅、换手，精选适合做T高抛低吸的标的',
            category: 'day-trade',
            params: [
                {
                    "key": "minAmplitude",
                    "label": "最小振幅(%)",
                    "type": "number",
                    "default": 3,
                    "min": 1,
                    "max": 10
                },
                {
                    "key": "minTurnover",
                    "label": "最小换手率(%)",
                    "type": "number",
                    "default": 2,
                    "min": 0.5,
                    "max": 20
                },
                {
                    "key": "maxPrice",
                    "label": "最高股价(元)",
                    "type": "number",
                    "default": 60,
                    "min": 5,
                    "max": 200
                },
                {
                    "key": "minDeviation",
                    "label": "最小偏离率(%)",
                    "type": "number",
                    "default": 1.5,
                    "min": 0.5,
                    "max": 5
                }
            ],
            execute(data, params) {
                const results = [];
                const minAmp = params.minAmplitude || 3;
                const minTo = params.minTurnover || 2;
                const maxPr = params.maxPrice || 60;
                const minDev = params.minDeviation || 1.5;
                for (const s of data) {
                    // 基础筛选：振幅、换手、价格
                    const amp = s.high && s.low && s.close ? ((s.high - s.low) / s.close * 100) : 0;
                    const to = s.turnover || 0;
                    const price = s.price || s.close || 0;
                    if (amp < minAmp)
                        continue;
                    if (to < minTo)
                        continue;
                    if (price > maxPr || price <= 2)
                        continue;
                    // 计算日内分时均线（近似值：用开盘、最高、最低的加权均值）
                    const open = s.open || 0;
                    const high = s.high || 0;
                    const low = s.low || 0;
                    // 分时均线 ≈ (开盘 + 最高 + 最低 + 收盘) / 4 的加权估算
                    // 更准确：用 (open + high + low) / 3 作为日内均价近似
                    const avgPrice = (open + high + low) / 3;
                    if (avgPrice <= 0)
                        continue;
                    // 计算偏离率 (当前价格偏离分时均线的百分比)
                    const deviation = ((price - avgPrice) / avgPrice) * 100;
                    const absDeviation = Math.abs(deviation);
                    // 偏离度不够的过滤掉
                    if (absDeviation < minDev)
                        continue;
                    // --- 综合评分 ---
                    let score = 0;
                    const signals = [];
                    const metrics = {};
                    // 1. 偏离评分 (偏离越大，回拉空间越大) - 最高35分
                    let devScore = 0;
                    if (absDeviation >= 4)
                        devScore = 35;
                    else if (absDeviation >= 3)
                        devScore = 30;
                    else if (absDeviation >= 2)
                        devScore = 25;
                    else if (absDeviation >= 1.5)
                        devScore = 20;
                    else
                        devScore = 15;
                    score += devScore;
                    // 方向判断
                    const direction = deviation > 0 ? '偏高' : '偏低';
                    signals.push(deviation > 0 ? '📈 偏离上轨(高抛)' : '📉 偏离下轨(低吸)');
                    signals.push(`偏离率${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}%`);
                    metrics.deviation = parseFloat(deviation.toFixed(2));
                    // 2. 振幅评分 (振幅越大，做T空间越大) - 最高25分
                    if (amp >= 6) {
                        score += 25;
                        signals.push('振幅极大');
                    }
                    else if (amp >= 4) {
                        score += 20;
                        signals.push('振幅较大');
                    }
                    else if (amp >= 3) {
                        score += 15;
                        signals.push('振幅适中');
                    }
                    metrics.amplitude = parseFloat(amp.toFixed(2));
                    // 3. 换手评分 (流动性好容易成交) - 最高20分
                    if (to >= 8) {
                        score += 20;
                        signals.push('换手极高');
                    }
                    else if (to >= 5) {
                        score += 18;
                        signals.push('换手活跃');
                    }
                    else if (to >= 3) {
                        score += 15;
                        signals.push('换手充足');
                    }
                    else if (to >= 2) {
                        score += 10;
                        signals.push('换手一般');
                    }
                    metrics.turnover = to;
                    // 4. 价格评分 (中等价格最适做T) - 最高10分
                    if (price >= 10 && price <= 30) {
                        score += 10;
                        signals.push('价格适中');
                    }
                    else if (price > 5 && price < 10) {
                        score += 7;
                        signals.push('低价股');
                    }
                    else if (price > 30 && price <= 50) {
                        score += 5;
                        signals.push('价格偏高');
                    }
                    metrics.price = price;
                    // 5. 涨幅加分 (非涨停最安全) - 最高10分
                    const chg = s.changePercent || s.changePct || 0;
                    if (chg > -5 && chg < 7) {
                        score += 10;
                        signals.push('波动空间充足');
                    }
                    else {
                        score += 3;
                    }
                    metrics.changePercent = chg;
                    // 生成日内做T建议
                    let tAdvice = '';
                    if (deviation > 2)
                        tAdvice = '⚡ 建议：先高抛，等回落后再接回';
                    else if (deviation < -2)
                        tAdvice = '⚡ 建议：先低吸，等拉高后卖出';
                    else
                        tAdvice = '⚡ 建议：观察等待更好时机';
                    signals.push(tAdvice);
                    results.push({
                        code: s.code,
                        name: s.name,
                        score: Math.round(score * 10) / 10,
                        signals: signals,
                        metrics: metrics
                    });
                }
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, 20);
            },
        }
    ],
};
exports.default = plugin;
