"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin = {
    id: 'chan-5filters-screener',
    name: '缠论5条件选股',
    version: '1.0.0',
    description: '5条件(涨幅3-5%+20日涨停+量比>1+换手5-10%+市值50-300亿) + 缠论完整分析(中枢/背驰/三类买卖点) + 评分排序，包含科创板',
    strategies: [
        {
            id: 'chan-5filters-main',
            name: '缠论5条件选股主策略',
            description: '缠论5条件选股主策略',
            category: 'special',
            params: [],
            execute(data, params) {
                const stocks = await api.screen.run({ id: 'dt-filter' });
                if (!stocks || stocks.length === 0) {
                    return [];
                }
                const results = [];
                for (const s of stocks) {
                    const hist = await api.stock.history({ code: s.code, days: 60 });
                    if (!hist || hist.length < 20) {
                        continue;
                    }
                    const closes = hist.map(d => d.close);
                    const highs = hist.map(d => d.high);
                    const lows = hist.map(d => d.low);
                    let score = s.score || 50; // 中枢分析 let zhongshuScore = 0; let hasZhongshu = false; for (let i = 10; i < highs.length - 10; i++) { const highMax = Math.max(...highs.slice(i-5, i+5)); const lowMin = Math.min(...lows.slice(i-5, i+5)); if (highMax - lowMin > 0) { hasZhongshu = true; zhongshuScore = 20; break; } } if (hasZhongshu) score += zhongshuScore; // 背驰分析 let beichiScore = 0; const firstHalf = closes.slice(0, Math.floor(closes.length/2)); const secondHalf = closes.slice(Math.floor(closes.length/2)); const firstAvg = firstHalf.reduce((a,b)=>a+b,0)/firstHalf.length; const secondAvg = secondHalf.reduce((a,b)=>a+b,0)/secondHalf.length; if (secondAvg > firstAvg) { beichiScore = 15; } score += beichiScore; // 涨停基因加分 const maxUp = Math.max(...hist.map(d => d.changePct || 0)); if (maxUp >= 9.5) score += 10; if (maxUp >= 18) score += 10; // 买点分析 let buyPointScore = 0; const recent20 = closes.slice(-20); const recentLow = Math.min(...recent20); const recentHigh = Math.max(...recent20); const current = closes[closes.length-1]; if (current >= recentLow * 1.05 && current <= recentLow * 1.15) { buyPointScore += 15; } if (current >= recentHigh * 0.90 && current <= recentHigh) { buyPointScore += 10; } score += buyPointScore; // 卖点预警 let sellWarn = ''; if (current >= recentHigh * 0.95) { sellWarn = '接近阶段高点,注意第29课卖点信号'; } else if (current <= recentLow * 1.05) { sellWarn = '接近阶段低点,关注第25课买点信号'; } results.push({ code: s.code, name: s.name, score: Math.min(score, 100), changePct: s.changePct, turnover: s.turnover || s.turnoverRate, volumeRatio: s.volumeRatio, marketCap: s.marketCap, chanTheory: { zhongshu: hasZhongshu ? '已形成' : '未形成', beichi: beichiScore > 0 ? '无背驰' : '有背驰', buyPoint: buyPointScore > 20 ? '三类买点区域' : buyPointScore > 10 ? '二类买点区域' : '观察区', sellWarning: sellWarn || '暂无' } }); } results.sort((a, b) => b.score - a.score); return results.slice(0, 30);
                }
            },
        }
    ],
};
exports.default = plugin;
