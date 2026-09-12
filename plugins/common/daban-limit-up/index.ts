import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

/**
 * 打板策略插件 v1.0.0
 * 识别当日涨停股票，判定首板/连板并标注板数；
 * 结合量比、换手率、流通市值、封板强度综合评分，用于打板选股。
 *
 * 数据来源：StockData（腾讯实时行情）+ stock.kline（历史日K）。
 * 说明：插件不含题材/板块数据（StockData 无该字段）；若需题材维度，需扩展数据源。
 */
const plugin: StockScreenerPlugin = {
  id: 'daban-limit-up',
  name: '首板连板识别（打板）',
  version: '1.0.0',
  description: '识别当日涨停，判定首板/N连板并标注板数，结合量比/换手/流通市值/封板强度综合评分，用于打板选股。',
  strategies: [
    {
      id: 'daban-board-recognition',
      name: '首板连板识别打板',
      description: '当日涨停 → 判定首板/连板，标注板数；叠加量能/换手/市值/封板强度评分（不含题材）。',
      category: 'momentum',
      params: [
        { key: 'minBoardCount', label: '最小板数', type: 'number', default: 1, min: 1, max: 8 },
        { key: 'maxBoardCount', label: '最大板数', type: 'number', default: 8, min: 1, max: 15 },
        { key: 'minVolumeRatio', label: '最小量比', type: 'number', default: 0.8, min: 0, max: 20 },
        { key: 'minTurnoverRate', label: '最小换手率%', type: 'number', default: 1, min: 0, max: 100 },
        { key: 'maxCirculatingMarketCap', label: '最大流通市值(亿)', type: 'number', default: 500, min: 0, max: 50000 },
        { key: 'requireSealed', label: '必须封板(价≈最高)', type: 'boolean', default: false },
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        params = params || {};
        // 参数防御：统一转 number（前端可能传字符串 "9"），NaN 时回退默认
        let minBoard = Number(params.minBoardCount ?? 1);
        let maxBoard = Number(params.maxBoardCount ?? 8);
        if (!Number.isFinite(minBoard)) minBoard = 1;
        if (!Number.isFinite(maxBoard)) maxBoard = 8;
        if (minBoard > maxBoard) [minBoard, maxBoard] = [maxBoard, minBoard]; // 参数防御
        const minVR = Number(params.minVolumeRatio ?? 0.8);
        const minTR = Number(params.minTurnoverRate ?? 1);
        const maxMcap = Number(params.maxCirculatingMarketCap ?? 500);
        const requireSealed = params.requireSealed ?? false;

        // 涨停阈值：按板块/ST 判定
        const threshold = (code: string, name: string): number => {
          if (/^(300|301|302|688|689)/.test(code)) return 19.5; // 创业板/科创板 20%
          if (/^(8|92)/.test(code)) return 29.5;                // 北交所 30%（排除 4xx 老三板）
          if (/ST/i.test(name)) return 4.8;                     // ST 主板 5%
          return 9.8;                                           // 主板 10%
        };

        const results: FilterResult[] = [];

        for (const stock of data) {
          const kl = stock.kline;
          if (!kl || kl.length < 20) continue;

          const t = threshold(stock.code, stock.name);
          const chg = stock.changePercent ?? 0;

          // 今日必须涨停，否则非打板标的
          if (chg < t) continue;

          // 计算连板数（含今日）：今日板数=1，再往前数昨日、前日连续涨停。
          // 注意：部分数据源（腾讯日K）在交易时段含当日未收盘bar，
          // 当日涨停已由 changePercent 判定，计数起点应跳过该bar避免板数+1。
          let startIdx = kl.length - 1;
          const last = kl[kl.length - 1];
          if (last && last.date) {
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            // 防御：只取日期前10位比较（兼容 YYYY-MM-DD 及带时间变体）
            if (String(last.date).slice(0, 10) === todayStr) startIdx = kl.length - 2;
          }
          let board = 1;
          for (let i = startIdx; i > 0; i--) {
            const prev = kl[i - 1].close;
            if (prev <= 0) break;
            const pc = ((kl[i].close - prev) / prev) * 100;
            if (pc >= t) board++;
            else break;
          }

          if (board < minBoard || board > maxBoard) continue;

          // 量比 / 换手 / 市值 过滤（circulatingMarketCap 单位是元，转亿）
          const vr = stock.volumeRatio ?? 0;
          const tr = stock.turnoverRate ?? 0;
          const mcap = (stock.circulatingMarketCap ?? stock.marketCap ?? 0) / 100000000;
          if (vr < minVR) continue;
          if (tr < minTR) continue;
          if (maxMcap > 0 && mcap > maxMcap) continue;

          // 封板强度：当前价≈今日最高（封住）
          const sealed = !!(stock.price && stock.high && stock.high > 0 && stock.price >= stock.high * 0.999);
          if (requireSealed && !sealed) continue;

          // 评分 0-100
          let score = 40;
          if (board === 1) score += 12;        // 首板
          else if (board === 2) score += 20;   // 2板
          else if (board === 3) score += 28;   // 3板
          else score += 30;                     // 高连板
          if (vr >= 1.5) score += 8;
          if (vr >= 3) score += 10;
          if (tr >= 5 && tr <= 20) score += 8;
          if (mcap >= 30 && mcap <= 300) score += 8;
          if (sealed) score += 8;
          if (board === 1 && stock.limitUpIn20Days) score += 5; // 近期活跃

          score = Math.max(0, Math.min(100, Math.round(score)));

          const boardLabel = board === 1 ? '首板' : `${board}连板`;
          results.push({
            code: stock.code,
            name: stock.name,
            score,
            signals: [
              boardLabel,
              `${chg.toFixed(1)}%`,
              `量比${vr.toFixed(1)}`,
              `换手${tr.toFixed(1)}%`,
              mcap > 0 ? `流通${Math.round(mcap)}亿` : '',
              sealed ? '封板' : '触板',
            ].filter(Boolean),
            metrics: {
              boardCount: board,
              changePercent: Math.round(chg * 100) / 100,
              volumeRatio: Math.round(vr * 100) / 100,
              turnoverRate: Math.round(tr * 100) / 100,
              circulatingMarketCap: Math.round(mcap),
            },
          });
        }

        return results.sort((a, b) => b.score - a.score);
      },
    },
  ],
};

export default plugin;
