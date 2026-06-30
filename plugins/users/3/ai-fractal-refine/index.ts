import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'ai-fractal-refine',
  name: '底分型精选过滤器',
  version: '1.0.0',
  description: '对缠论底分型选股结果的二次精筛：缩量（量比<0.8）+ 中等市值（50~300亿）+ 换手率适中（1~10%），过滤掉大盘银行股和垃圾微盘股',
  strategies: [
    {
      id: 'fractal-refine',
      name: '底分型精选',
      description: '底分型精选',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        // 底分型精选过滤器：缩量 + 中等市值 + 适度换手\nconst {code, name, market, price, volumeRatio, turnoverRate, marketCap} = stock;\n\n// 条件1：量比 < 0.8（真缩量）\nconst volOk = volumeRatio !== undefined && volumeRatio < 0.8 && volumeRatio > 0;\n\n// 条件2：市值 50~300亿（marketCap单位是元，50亿=5,000,000,000）\nconst mcapOk = marketCap >= 5000000000 && marketCap <= 30000000000;\n\n// 条件3：换手率 1%~10%（去掉僵尸股和过热股）\nconst turnOk = turnoverRate >= 1 && turnoverRate <= 10;\n\n// 条件4：股价 > 5元（排除低价垃圾股）\nconst priceOk = price > 5;\n\n// 计算综合得分\nlet score = 0;\nif (volOk) score += 30;\nif (mcapOk) score += 30;\nif (turnOk) score += 20;\nif (priceOk) score += 20;\n\n// 信号收集\nconst signals = [];\nif (volOk) signals.push('缩量:' + volumeRatio.toFixed(2));\nif (mcapOk) signals.push('市值适中');\nif (turnOk) signals.push('换手适中:' + turnoverRate.toFixed(1) + '%');\nif (priceOk) signals.push('股价>' + price);\n\nreturn {\n  score: score,\n  signals: signals,\n  matched: score >= 80\n};
      },
    }
  ],
};

export default plugin;
