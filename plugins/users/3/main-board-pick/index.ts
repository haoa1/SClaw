import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'main-board-pick',
  name: '主板尾盘精选',
  version: '1.0.0',
  description: '主板短线精选：涨幅3~5% + 20日内涨停基因 + 量比>1 + 换手5~10% + 市值<200亿 + 分时均价线上方。每天14:30执行。',
  strategies: [
    {
      id: 'main-board-pick',
      name: '主板尾盘精选',
      description: '主板：涨幅3~5% + 20日涨停 + 量比>1 + 换手5~10% + 市值<200亿 + 分时均价线上',
      category: 'short-term',
      params: [
          {
              "key": "minChange",
              "name": "最小涨幅",
              "type": "number",
              "default": 3
          },
          {
              "key": "maxChange",
              "name": "最大涨幅",
              "type": "number",
              "default": 5
          },
          {
              "key": "minVolRatio",
              "name": "最小量比",
              "type": "number",
              "default": 1
          },
          {
              "key": "minTurnover",
              "name": "最小换手率",
              "type": "number",
              "default": 5
          },
          {
              "key": "maxTurnover",
              "name": "最大换手率",
              "type": "number",
              "default": 10
          },
          {
              "key": "maxMcap",
              "name": "最大市值(亿)",
              "type": "number",
              "default": 200
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        // 主板尾盘精选策略\nconst {stockPool} = params;\nconst results = [];\nfor (const s of stockPool) {\n  if (!s) continue;\n  // 1. 主板过滤：排除科创板(688/689)和创业板(300/301)\n  const code = s.code || '';\n  if (code.startsWith('688') || code.startsWith('689') || code.startsWith('300') || code.startsWith('301')) {\n    continue;\n  }\n  // 2. 涨幅3~5%\n  const chg = parseFloat(s.changePercent) || 0;\n  if (chg < 3 || chg > 5) continue;\n  // 3. 量比>1\n  const vr = parseFloat(s.volumeRatio) || 0;\n  if (vr <= 1) continue;\n  // 4. 换手率5~10%\n  const tr = parseFloat(s.turnoverRate) || 0;\n  if (tr < 5 || tr > 10) continue;\n  // 5. 市值<200亿（marketCap单位是元）\n  const mcap = parseFloat(s.marketCap) || 0;\n  const mcapYi = mcap / 100000000;\n  if (mcapYi >= 200) continue;\n  // 6. 分时均价线上方\n  const aboveVwap = s.priceAboveVwap;\n  if (aboveVwap === false || aboveVwap === 0 || aboveVwap === '0' || aboveVwap === null || aboveVwap === undefined) {\n    continue;\n  }\n  // 信号收集\n  const signals = [];\n  if (chg >= 3 && chg <= 5) signals.push('涨幅适中');\n  if (vr > 1) signals.push('量比充足');\n  if (tr >= 5 && tr <= 10) signals.push('换手活跃');\n  if (mcapYi < 200) signals.push('小盘弹性');\n  if (aboveVwap) signals.push('分时强势');\n  results.push({\n    code: s.code,\n    name: s.name,\n    score: signals.length * 20,\n    signals,\n    metrics: {\n      changePercent: chg,\n      volumeRatio: vr,\n      turnoverRate: tr,\n      marketCapYi: mcapYi\n    }\n  });\n}\n// 按得分排序\nresults.sort((a, b) => b.score - a.score);\nreturn results.slice(0, 20);
      },
    }
  ],
};

export default plugin;
