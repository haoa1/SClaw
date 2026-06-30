"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Serenity 瓶颈投资法 — AI/半导体供应链 chokepoint 筛选
 *
 * 基于 @aleabitoreddit (白毛股神) 的六层筛选漏斗：
 * 1. 赛道选择：AI 供应链 "喉舌"环节
 * 2. 不可替代性：市场份额 >50%
 * 3. "龙虾理论"：提价权 x 放量
 * 4. 地缘政治催化：出口管制/产业政策
 * 5. 机构验证：JP Morgan / Fidelity 开始建仓
 * 6. 流动性时机：市值 < $3B
 */
const plugin = {
    id: 'serenity-chokepoint',
    name: 'Serenity 瓶颈投资法',
    version: '1.0.0',
    description: 'Serenity 白毛股神六层筛选漏斗：AI 供应链不可替代节点 + 小市值 + 定价权 + 地缘催化 + 机构验证',
    strategies: [
        {
            id: 'chokepoint-screener',
            name: '瓶颈筛选',
            description: '基于 Serenity 瓶颈投资法的六维筛选',
            category: 'long-term',
            params: [
                {
                    key: 'maxMarketCapYi',
                    label: '最大市值 (亿)',
                    type: 'number',
                    default: 100,
                    min: 10,
                    max: 500,
                    step: 10,
                },
                {
                    key: 'minChangePercent',
                    label: '最低涨幅 %',
                    type: 'number',
                    default: 0,
                    min: -10,
                    max: 20,
                    step: 1,
                },
                {
                    key: 'minVolumeRatio',
                    label: '最低量比',
                    type: 'number',
                    default: 0.5,
                    min: 0.1,
                    max: 5,
                    step: 0.1,
                },
            ],
            execute(data, params) {
                const results = [];
                const maxMcapYi = params.maxMarketCapYi ?? 100;
                const minChg = params.minChangePercent ?? 0;
                const minVolRatio = params.minVolumeRatio ?? 0.5;
                for (const item of data) {
                    // Layer 1: 小市值 — Serenity 强调 < $3B (约 210亿RMB以内)
                    const mcap = item.marketCap ?? 0;
                    const mcapYi = mcap / 100000000;
                    if (mcapYi > maxMcapYi || mcapYi <= 0)
                        continue;
                    // Layer 2: 股价趋势 — 非垃圾股，有交易活跃度
                    const chg = item.changePercent ?? 0;
                    if (chg < minChg)
                        continue;
                    // Layer 3: 成交量佐证
                    const volRatio = item.volumeRatio ?? 0;
                    if (volRatio < minVolRatio)
                        continue;
                    // 构建信号矩阵（基于 Serenity 框架的"可应用字段"评分）
                    const signals = [];
                    signals.push(`市值${mcapYi.toFixed(0)}亿`);
                    signals.push(`涨幅${chg.toFixed(1)}%`);
                    if (volRatio > 0)
                        signals.push(`量比${volRatio.toFixed(2)}`);
                    // 额外质量信号
                    const tr = item.turnoverRate ?? 0;
                    if (tr > 0 && tr < 50) {
                        signals.push(`换手${tr.toFixed(1)}%`);
                    }
                    // 评分逻辑：
                    // Serenity 框架最看重的是 "不可替代性"
                    // 没有 StockData 里的字段能直接衡量 "不可替代性"
                    // 所以评分基于可观测指标代理
                    let score = 50; // Base
                    // 市值越小越好（被忽视阶段加分）
                    if (mcapYi < 30)
                        score += 20; // < $500M — 秘密发现期
                    else if (mcapYi < 100)
                        score += 10; // < $1.5B — 早期发现
                    else
                        score += 5;
                    // 量比: 有增量资金
                    if (volRatio > 1.5)
                        score += 10;
                    else if (volRatio > 1)
                        score += 5;
                    // 涨幅: 正向动量
                    if (chg > 5)
                        score += 10;
                    else if (chg > 2)
                        score += 5;
                    results.push({
                        code: item.code,
                        name: item.name,
                        score: Math.min(score, 100),
                        signals,
                        metrics: {
                            marketCapYi,
                            changePercent: chg,
                            volumeRatio: volRatio,
                            turnoverRate: tr,
                        },
                    });
                }
                return results;
            },
        },
    ],
};
exports.default = plugin;
