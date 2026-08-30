import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'limit-up-pullback-macd',
  name: '涨停回调MACD绿柱缩短',
  version: '1.2.0',
  description: '用户定制策略 v1.2.0(MACD 5,13,6)：20个交易日内有≥N连板（默认3连板）→ 从峰值回调一定比例（默认8~45%）→ MACD绿柱从高点（最负值）之后连续靠近0那条横线（逐日变短、绝对值缩小），且当前贴近0轴但【未翻红】。一旦翻红或中途变长立即停止判定。用于捕捉"多涨停爆款回调企稳、金叉临界"的二次上车点。',
  strategies: [
    {
      id: 'limit-up-pullback-green-shrink',
      name: '涨停回调MACD绿柱缩短',
      description: '20日内≥3连板 + 回调8~45% + MACD绿柱从高点连续靠近0线（未翻红，金叉临界）',
      category: 'momentum',
      params: [
        {
          "key": "lookbackDays",
          "label": "回看天数",
          "type": "number",
          "default": 20,
          "min": 5,
          "max": 60
        },
        {
          "key": "minStreak",
          "label": "最少连板数",
          "type": "number",
          "default": 3,
          "min": 2,
          "max": 8
        },
        {
          "key": "pullbackMin",
          "label": "最小回调%",
          "type": "number",
          "default": 8,
          "min": 3,
          "max": 30
        },
        {
          "key": "pullbackMax",
          "label": "最大回调%",
          "type": "number",
          "default": 45,
          "min": 10,
          "max": 60
        },
        {
          "key": "shrinkDays",
          "label": "绿柱连续靠近0线天数",
          "type": "number",
          "default": 2,
          "min": 1,
          "max": 5
        },
        {
          "key": "nearZeroAbs",
          "label": "贴近0轴阈值(绝对值)",
          "type": "number",
          "default": 0.5,
          "min": 0.05,
          "max": 2
        }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        params = params || {};
        const lookback = params.lookbackDays ?? 20;
        const minStreak = params.minStreak ?? 3;
        const pullMin = params.pullbackMin ?? 8;
        const pullMax = params.pullbackMax ?? 45;
        const shrinkDays = params.shrinkDays ?? 2;
        const nearZeroAbs = params.nearZeroAbs ?? 0.5;

        const emaArr = (arr: number[], p: number): number[] => {
          const r: number[] = [];
          const m = 2 / (p + 1);
          for (let i = 0; i < arr.length; i++) {
            if (i === 0) r.push(arr[i]);
            else r.push((arr[i] - r[i - 1]) * m + r[i - 1]);
          }
          return r;
        };
        const macdCalc = (closes: number[]) => {
          const ef = emaArr(closes, 5);
          const es = emaArr(closes, 13);
          const dif = ef.map((v: number, i: number) => v - es[i]);
          const dea = emaArr(dif, 6);
          const hist = dif.map((v: number, i: number) => 2 * (v - dea[i]));
          return { hist };
        };

        const results: FilterResult[] = [];

        for (const stock of data) {
          const kl = stock.kline;
          if (!kl || kl.length < 60) continue;

          // 涨停阈值：创业板/科创板 20%，主板 10%
          const is20pct = /^(300|301|688|689)/.test(stock.code);
          const limitPct = is20pct ? 19.5 : 9.8;

          const lu: boolean[] = new Array(kl.length).fill(false);
          for (let i = 1; i < kl.length; i++) {
            const prev = kl[i - 1].close;
            if (prev <= 0) continue;
            lu[i] = ((kl[i].close - prev) / prev) * 100 >= limitPct;
          }

          // 回看窗口内最大连续涨停
          const startIdx = Math.max(1, kl.length - lookback);
          let maxStreak = 0;
          let cur = 0;
          let streakEnd = -1;
          for (let i = startIdx; i < kl.length; i++) {
            if (lu[i]) { cur++; if (cur > maxStreak) { maxStreak = cur; streakEnd = i; } }
            else cur = 0;
          }
          if (maxStreak < minStreak || streakEnd < 0) continue;

          // 峰值与回调幅度（连板结束后至今最高价）
          let peak = kl[streakEnd].close;
          for (let i = streakEnd; i < kl.length; i++) {
            if (kl[i].high > peak) peak = kl[i].high;
          }
          const curPrice = kl[kl.length - 1].close;
          const pullback = peak > 0 ? ((peak - curPrice) / peak) * 100 : 0;
          if (pullback < pullMin || pullback > pullMax) continue;

          // MACD
          const closes = kl.map((k: any) => k.close);
          const { hist } = macdCalc(closes);

          // ★ v1.2.0(MACD 5,13,6) 绿柱"连续靠近0那条横线，不是翻红"判定：
          //   1) 连板结束后必须存在绿柱高点（最负值 maxGreenIdx）→ "绿柱到顶"已发生
          //   2) 从高点之后，绿柱逐日向0靠近：hist[i] > hist[i-1]（绝对值缩小）
          //   3) 全程必须在绿柱区：hist[i] < 0（【未翻红】，一旦翻红即停止判定）
          //   4) 中途不得回抽变长：一旦 hist[i] <= hist[i-1] 即停止判定
          //   5) 当前必须贴近0那条横线：|hist| <= nearZeroAbs，且仍未翻红
          const segStart = Math.max(streakEnd, hist.length - 40);
          let maxGreenIdx = -1;
          let maxGreenVal = 0;
          for (let i = segStart; i < hist.length; i++) {
            if (hist[i] < maxGreenVal) { maxGreenVal = hist[i]; maxGreenIdx = i; }
          }
          if (maxGreenIdx < 0) continue;

          const curHist = hist[hist.length - 1];
          // 当前必须在绿柱区（未翻红）—— "不是翻红"硬性条件
          if (curHist >= 0) continue;
          // 当前必须贴近0那条横线
          if (Math.abs(curHist) > nearZeroAbs) continue;

          // 从绿柱高点之后，逐日向0靠近（连续变短），未翻红、未回抽
          let shrinkCount = 0;
          let clean = true;
          for (let i = maxGreenIdx + 1; i < hist.length; i++) {
            if (hist[i] >= 0) { clean = false; break; }        // 翻红即停
            if (hist[i] > hist[i - 1]) shrinkCount++;          // 更靠近0
            else { clean = false; break; }                     // 回抽变长即停
          }
          if (!clean) continue;
          if (shrinkCount < shrinkDays) continue;

          const shrinkRatio = maxGreenVal !== 0 ? Math.abs((curHist - maxGreenVal) / maxGreenVal) : 0;

          // 评分
          let score = 40;
          score += Math.min(20, maxStreak * 3);
          score += Math.min(15, shrinkCount * 4);
          score += Math.min(15, Math.round(shrinkRatio * 15));
          if (maxStreak >= 5) score += 5;
          if (curHist > -0.1) score += 5;

          results.push({
            code: stock.code,
            name: stock.name,
            score: Math.min(100, Math.round(score)),
            signals: [
              maxStreak + '连板',
              '回调' + pullback.toFixed(1) + '%',
              '绿柱' + maxGreenVal.toFixed(2) + '→' + curHist.toFixed(2),
              '连续靠近0线' + shrinkCount + '天',
              '未翻红'
            ],
            metrics: {
              maxStreak: maxStreak,
              pullback: Math.round(pullback * 10) / 10,
              macdHist: Math.round(curHist * 100) / 100,
              shrinkDays: shrinkCount,
              greenPeak: Math.round(maxGreenVal * 100) / 100
            }
          });
        }

        return results.sort((a, b) => b.score - a.score);
      }
    }
  ]
};

export default plugin;
