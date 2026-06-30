"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Serenity 瓶颈投资法 v2 — AI/半导体供应链 chokepoint 筛选 + 深度数据集成
 *
 * 六层筛选漏斗，数据源全面升级：
 * Layer 1: 赛道选择 — 行业分类 (analysis_data_bridge)
 * Layer 2: 不可替代性 — 毛利率>50%(AKShare)
 * Layer 3: 龙虾理论 — ROE>15% + 营收增长率>20% (AKShare)
 * Layer 4: 地缘催化 — autocli 新闻搜索（出口管制/关税等）
 * Layer 5: 机构验证 — 基金增减持(AKShare) + 十大流通股东
 * Layer 6: 流动性时机 — 市值<$3B + 量比+换手率 (Tencent实时)
 *
 * 双阶段筛选：
 *   Phase 1 (本插件): 快速量化过滤 — 排除噪音, 保留候选
 *   Phase 2 (AI agent): 调用 AKShare+autocli 做六层全量验证 + 评分
 */
const plugin = {
    id: 'serenity-chokepoint-v2',
    name: 'Serenity 瓶颈投资法 v2',
    version: '2.1.0',
    description: '六层筛选漏斗：AI供应链不可替代节点，快速量化排除噪音 → AI深度集成AKShare+autocli',
    strategies: [
        {
            id: 'chokepoint-screener-v2',
            name: '瓶颈筛选 v2 (快速扫描)',
            description: 'Phase 1 量化初筛 — 排除北交所/ST/微盘/低价股噪音，保留基本面可验证的候选',
            category: 'long-term',
            params: [
                // ── 市场排除 ──
                { key: 'includeBJ', label: '包含北交所', type: 'boolean', default: false },
                { key: 'excludeST', label: '排除ST/*ST', type: 'boolean', default: true },
                // ── 市值门槛 ──
                { key: 'minMarketCapYi', label: '最小市值 (亿)', type: 'number', default: 10, min: 1, max: 50, step: 5 },
                { key: 'maxMarketCapYi', label: '最大市值 (亿)', type: 'number', default: 100, min: 10, max: 500, step: 10 },
                // ── 价格过滤（排除低价股/仙股）──
                { key: 'minPrice', label: '最低股价 (元)', type: 'number', default: 5, min: 1, max: 50, step: 1 },
                // ── 动量与成交量 ──
                { key: 'minChangePercent', label: '最低涨幅 %', type: 'number', default: 1, min: -5, max: 20, step: 0.5 },
                { key: 'minVolumeRatio', label: '最低量比', type: 'number', default: 0.8, min: 0.1, max: 5, step: 0.1 },
                // ── 深度筛选参数 (供 AI agent 参考, 插件内不执行) ──
                { key: 'minGrossMargin', label: '最低毛利率 % (深度筛选)', type: 'number', default: 50, min: 0, max: 100, step: 5 },
                { key: 'minROE', label: '最低ROE % (深度筛选)', type: 'number', default: 15, min: 0, max: 50, step: 1 },
                { key: 'industryContains', label: '行业/概念关键词 (深度筛选)', type: 'string', default: '半导体,光刻,芯片,AI,国产替代' },
                { key: 'institutionalAction', label: '机构动作 (深度筛选)', type: 'select', default: '增仓', options: ['增仓', '新进', '减仓', 'all'] },
            ],
            execute(data, params) {
                const results = [];
                const includeBJ = params.includeBJ ?? false;
                const excludeST = params.excludeST ?? true;
                const minMcapYi = params.minMarketCapYi ?? 10;
                const maxMcapYi = params.maxMarketCapYi ?? 100;
                const minPrice = params.minPrice ?? 5;
                const minChg = params.minChangePercent ?? 1;
                const minVolRatio = params.minVolumeRatio ?? 0.8;
                for (const item of data) {
                    // ── Layer 1: 市场排除 ──
                    if (!includeBJ && item.market === 'BJ')
                        continue;
                    if (excludeST && item.name && (item.name.startsWith('ST') || item.name.startsWith('*ST')))
                        continue;
                    // ── Layer 6: 流动性 + 市值 ──
                    const mcap = item.marketCap ?? 0;
                    const mcapYi = mcap / 100000000;
                    if (mcapYi > maxMcapYi || mcapYi < minMcapYi)
                        continue;
                    // ── 价格过滤 ──
                    const price = item.price ?? 0;
                    if (price < minPrice)
                        continue;
                    // ── 动量 ──
                    const chg = item.changePercent ?? 0;
                    if (chg < minChg)
                        continue;
                    // ── 成交量佐证 ──
                    const volRatio = item.volumeRatio ?? 0;
                    if (volRatio < minVolRatio)
                        continue;
                    // ── 信号矩阵 ──
                    const signals = [];
                    signals.push(item.market === 'SH' ? '沪' : '深');
                    signals.push(mcapYi.toFixed(0) + '亿');
                    signals.push('$' + price.toFixed(2));
                    signals.push(chg.toFixed(1) + '%');
                    if (volRatio > 0)
                        signals.push('量比' + volRatio.toFixed(2));
                    const tr = item.turnoverRate ?? 0;
                    if (tr > 0 && tr < 50)
                        signals.push('换手' + tr.toFixed(1) + '%');
                    if (item.limitUpIn20Days)
                        signals.push('20日涨停🦀');
                    if (item.priceAboveVwap)
                        signals.push('均价线上');
                    // ── 评分 ──
                    let score = 50;
                    // 小市值加分 (越快接近上限越扣分)
                    if (mcapYi < 30)
                        score += 20;
                    else if (mcapYi < 60)
                        score += 15;
                    else if (mcapYi < 100)
                        score += 10;
                    else
                        score += 5;
                    // 量比
                    if (volRatio > 2)
                        score += 15;
                    else if (volRatio > 1.5)
                        score += 10;
                    else if (volRatio > 1)
                        score += 5;
                    // 涨幅动量
                    if (chg > 8)
                        score += 10;
                    else if (chg > 4)
                        score += 8;
                    else if (chg > 2)
                        score += 5;
                    // 换手率 (非妖股范围)
                    if (tr > 3 && tr < 15)
                        score += 5;
                    else if (tr >= 15)
                        score -= 5; // 换手过高 → 游资炒作嫌疑
                    // 价格 (低价股折价)
                    if (price < 10)
                        score -= 5;
                    else if (price > 30)
                        score += 5;
                    results.push({
                        code: item.code,
                        name: item.name,
                        score: Math.max(0, Math.min(100, score)),
                        signals,
                        metrics: {
                            market: item.market,
                            marketCapYi: Math.round(mcapYi * 100) / 100,
                            price: price,
                            changePercent: chg,
                            volumeRatio: volRatio,
                            turnoverRate: tr,
                            targetGrossMargin: 50,
                            targetROE: 15,
                        },
                    });
                }
                // 按评分降序排列
                results.sort((a, b) => b.score - a.score);
                return results;
            },
        },
    ],
};
exports.default = plugin;
