import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'oscillation-hunter',
  name: '震荡市猎手',
  version: '1.0.0',
  description: '专为震荡平衡市设计的智能选股策略，综合评估估值安全、成交活跃、趋势健康三个维度，帮助用户在涨跌各半的市场中精选优质标的',
  strategies: [
    {
      id: 'oscillation-pick',
      name: '震荡优选',
      description: '震荡行情综合选股：估值合理(PE<20) + 成交活跃(换手率适中) + 趋势稳健，适合当前涨跌平衡市',
      category: 'mid-term',
      params: [
          {
              "key": "maxPe",
              "label": "最大市盈率",
              "type": "number",
              "default": 20,
              "min": 5,
              "max": 50
          },
          {
              "key": "minTurnover",
              "label": "最低换手率(%)",
              "type": "number",
              "default": 0.5,
              "min": 0.1,
              "max": 10
          },
          {
              "key": "maxTurnover",
              "label": "最高换手率(%)",
              "type": "number",
              "default": 8,
              "min": 1,
              "max": 30
          },
          {
              "key": "minPrice",
              "label": "最低股价(元)",
              "type": "number",
              "default": 10,
              "min": 1,
              "max": 1000
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        // 震荡市综合选股策略
        // data: 全量股票数据
        // params: { maxPe, minTurnover, maxTurnover, minPrice }
        
        const maxPe = params.maxPe || 20;
        const minTurnover = params.minTurnover || 0.5;
        const maxTurnover = params.maxTurnover || 8;
        const minPrice = params.minPrice || 10;
        
        const results = [];
        
        for (const stock of data) {
          // 基础过滤
          if (!stock.pe || stock.pe <= 0) continue;
          if (stock.price < minPrice) continue;
          if (stock.pe > maxPe) continue;
          
          // 换手率过滤（震荡市需要一定活跃度，但不过热）
          const to = stock.turnover || 0;
          if (to < minTurnover || to > maxTurnover) continue;
          
          // 计算综合评分 (0-100)
          let score = 0;
          
          // 1. 估值评分 (PE越低越好) - 最高35分
          const peScore = Math.max(0, 35 * (1 - (stock.pe - 5) / (maxPe - 5)));
          score += peScore;
          
          // 2. 换手率评分 (适中最好，过高或过低都不好) - 最高25分
          const idealTurnover = (minTurnover + maxTurnover) / 2;
          const toScore = 25 * (1 - Math.abs(to - idealTurnover) / (maxTurnover - minTurnover));
          score += Math.max(0, toScore);
          
          // 3. 价格稳定性评分 (跌得少的更安全) - 最高20分
          const changePct = stock.changePct || 0;
          let stabilityScore = 10;
          if (changePct > -2 && changePct < 0) stabilityScore = 18;
          else if (changePct >= 0 && changePct < 3) stabilityScore = 20;
          else if (changePct >= 3 && changePct < 5) stabilityScore = 15;
          else if (changePct >= 5) stabilityScore = 8;
          else if (changePct < -2) stabilityScore = 5;
          score += stabilityScore;
          
          // 4. 市值规模评分 (大市值更稳健) - 最高20分
          const mc = stock.marketCap || 0;
          const mcScore = mc > 0 ? Math.min(20, 20 * (mc / 1000000000000)) : 10;
          score += mcScore;
          
          // 生成信号
          const signals = [];
          if (stock.pe < 15) signals.push('低估值');
          if (to > 1 && to < 5) signals.push('换手适中');
          if (changePct >= 0) signals.push('今日上涨');
          if (mc > 100000000000) signals.push('大盘蓝筹');
          if (stock.pe < 12) signals.push('深度价值');
          if (signals.length === 0) signals.push('震荡防御');
          
          results.push({
            code: stock.code,
            name: stock.name,
            score: Math.round(score * 10) / 10,
            signals: signals,
            metrics: {
              pe: stock.pe,
              turnover: to,
              changePct: changePct,
              price: stock.price
            }
          });
        }
        
        // 按评分降序排序
        results.sort((a, b) => b.score - a.score);
        
        return results.slice(0, 50);
      },
    }
  ],
};

export default plugin;
