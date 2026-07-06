import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'life-line-ma60',
  name: '生命线MA60突破',
  version: '1.0.0',
  description: '基于短线操盘绝招(shortcut-trading)的60日生命线买入法：股价在MA60下方但偏离<5%，今日放量站上MA60，量比≥1.5',
  strategies: [
    {
      id: 'ma60-life-line',
      name: '60日生命线突破',
      description: '股价在MA60下方但偏离<5%，今日放量站上MA60，量比≥1.5',
      category: 'special',
      params: [],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const stocks = await screener.getAllStocks();
        const results = [];
        
        for (const s of stocks.slice(0, 1000)) {
          try {
            const kline = await screener.getKLine(s.code, 80);
            if (!kline || kline.length < 60) continue;
            
            const closes = kline.map(k => k.close);
            const volumes = kline.map(k => k.volume);
            
            // 计算MA60
            const sum60 = closes.slice(-60).reduce((a, b) => a + b, 0);
            const ma60 = sum60 / 60;
            
            // 计算前一日MA60
            const sum60Prev = closes.slice(-61, -1).reduce((a, b) => a + b, 0);
            const ma60Prev = sum60Prev / 60;
            
            const price = s.price || closes[closes.length - 1];
            
            // 条件1: 昨日股价在MA60下方
            const prevPrice = closes[closes.length - 2] || price;
            const wasBelowMA60 = prevPrice < ma60Prev;
            
            // 条件2: 今日站上MA60或在前日基础上站上
            const crossedAbove = price >= ma60 && wasBelowMA60;
            
            // 条件3: 偏离<5%
            const deviation = Math.abs((price - ma60) / ma60) * 100;
            const within5Percent = deviation < 5;
            
            // 条件4: 放量
            const avgVol = volumes.slice(-20, -5).reduce((a, b) => a + b, 0) / 15;
            const todayVol = s.volume || 0;
            const volumeRatio = avgVol > 0 ? todayVol / avgVol : 0;
            const isVolumeSurge = volumeRatio >= 1.5;
            
            if ((crossedAbove || (within5Percent && price < ma60)) && volumeRatio >= 1.2) {
              let score = 50;
              if (crossedAbove) score += 20;
              if (volumeRatio >= 2) score += 10;
              if (deviation < 2) score += 10;
              
              results.push({
                code: s.code,
                name: s.name,
                score: Math.min(100, score),
                signals: [
                  crossedAbove ? '今日站上MA60✅' : '接近MA60⬆',
                  `偏离MA60: ${deviation.toFixed(1)}%`,
                  `量比: ${volumeRatio.toFixed(2)}`
                ],
                metrics: {
                  price: price,
                  ma60: ma60,
                  deviation: deviation,
                  volumeRatio: volumeRatio,
                  crossedAbove: crossedAbove
                }
              });
            }
          } catch (e) {
            continue;
          }
        }
        
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, 30);
      },
    }
  ],
};

export default plugin;
