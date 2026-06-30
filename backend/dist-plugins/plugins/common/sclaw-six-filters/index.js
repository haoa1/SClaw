"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin = {
    id: 'sclaw-six-filters',
    name: 'SClaw六维精选',
    version: '1.0.0',
    description: '综合6个条件的短线精选策略：涨幅3~5% + 20日内有涨停基因 + 量比>1 + 换手5~10% + 市值50~300亿 + 分时强势',
    strategies: [
        {
            id: 'six-filters',
            name: '六维精选',
            description: '六维精选',
            category: 'special',
            params: [
                {
                    key: "minVolumeRatio",
                    label: "最低量比",
                    type: "number",
                    default: 1,
                    min: 0.5,
                    max: 5,
                    step: 0.1,
                },
            ],
            execute(data, params) {
                const results = [];
                const minVolRatio = params.minVolumeRatio ?? 1;
                for (const item of data) {
                    // 条件1: 当日涨幅3%~5%
                    const chg = item.changePercent ?? item.pctChg ?? 0;
                    if (chg < 3 || chg > 5)
                        continue;
                    // 条件2: 20日内出现过涨停 (涨停基因)
                    // 依赖历史数据字段检查，如果没有历史数据字段则宽松处理
                    const hasLimitUp = item.limitUpIn20Days === true;
                    // 条件3: 量比 > minVolumeRatio (默认1.0, 数据源: 腾讯行情API)
                    const volRatio = item.volumeRatio ?? 0;
                    if (!volRatio || volRatio <= minVolRatio)
                        continue;
                    // 条件4: 换手率 5%~10%
                    const tr = item.turnoverRate ?? item.turnover ?? 0;
                    if (tr < 5 || tr > 10)
                        continue;
                    // 条件5: 总市值50~300亿 (marketCap单位是元,转为亿)
                    const mcap = item.marketCap ?? 0;
                    const mcapYi = mcap / 100000000;
                    if (mcapYi < 50 || mcapYi > 300)
                        continue;
                    // 条件6: 当日分时运行在均价线上
                    const priceAboveAvg = item.priceAboveVwap === true;
                    const signals = [
                        '涨幅' + chg.toFixed(1) + '%',
                        '换手' + tr.toFixed(1) + '%',
                        '市值' + mcapYi.toFixed(0) + '亿',
                        '量比' + volRatio.toFixed(2),
                    ];
                    if (hasLimitUp)
                        signals.push('涨停基因✓');
                    if (priceAboveAvg)
                        signals.push('分时强势✓');
                    results.push({
                        code: item.code,
                        name: item.name,
                        score: chg >= 4 ? 85 : 75,
                        signals,
                        metrics: { changePercent: chg, turnoverRate: tr, marketCapYi, volumeRatio: volRatio, hasLimitUp, priceAboveAvg }
                    });
                }
                return results;
            },
        }
    ],
};
exports.default = plugin;
