import { StockScreenerPlugin, StockData, FilterResult } from '../../backend/src/types';

const plugin: StockScreenerPlugin = {
  id: 'sclaw-dt-filter',
  name: '做T五维精选',
  version: '1.0.0',
  description: '做T策略的5个条件：涨幅3~5% + 20日内涨停基因 + 量比>1(计算) + 换手5~10% + 市值50~300亿',
  strategies: [
    {
      id: 'dt-filter',
      name: '做T五维精选',
      description: '涨幅3~5%+涨停基因+量比>1+换手5~10%+市值50~300亿',
      category: 'day-trade',
      params: [
          {
              "key": "minChange",
              "label": "最低涨幅",
              "type": "number",
              "default": 3,
              "min": 0,
              "max": 10
          },
          {
              "key": "maxChange",
              "label": "最高涨幅",
              "type": "number",
              "default": 5,
              "min": 0,
              "max": 10
          },
          {
              "key": "minVolumeRatio",
              "label": "最低量比",
              "type": "number",
              "default": 1,
              "min": 0.5,
              "max": 5
          },
          {
              "key": "minTurnover",
              "label": "最低换手",
              "type": "number",
              "default": 5,
              "min": 0,
              "max": 20
          },
          {
              "key": "maxTurnover",
              "label": "最高换手",
              "type": "number",
              "default": 10,
              "min": 0,
              "max": 30
          },
          {
              "key": "minMcap",
              "label": "最低市值(亿)",
              "type": "number",
              "default": 50,
              "min": 0,
              "max": 1000
          },
          {
              "key": "maxMcap",
              "label": "最高市值(亿)",
              "type": "number",
              "default": 300,
              "min": 0,
              "max": 5000
          }
      ],
      execute(data: StockData[], params: Record<string, any>): FilterResult[] {
        const results = [];
        const minChg = params.minChange ?? 3;
        const maxChg = params.maxChange ?? 5;
        const minVolRatio = params.minVolumeRatio ?? 1;
        const minTr = params.minTurnover ?? 5;
        const maxTr = params.maxTurnover ?? 10;
        const minMcapYi = params.minMcap ?? 50;
        const maxMcapYi = params.maxMcap ?? 300;
        for (const item of data) {
          const chg = item.changePercent ?? item.pctChg ?? 0;
          if (chg < minChg || chg > maxChg) continue;
          const hasLimitUp = item.limitUpIn20Days === true || item.hasLimitUp === true;
          if (!hasLimitUp) continue; // 条件5：20日内有涨停基因（硬性要求）
          let volRatio = item.volumeRatio ?? 0;
          if (volRatio < 0.1 || volRatio > 1000) {
            if (item.volume && item.avgVolume) {
              volRatio = item.volume / item.avgVolume;
            } else { volRatio = 0; }
          }
          if (volRatio < minVolRatio) continue;
          let tr = item.turnoverRate ?? 0;
          if (tr > 100) tr = tr / 100;
          if (tr < minTr || tr > maxTr) continue;
          let mcap = item.marketCap ?? 0;
          let mcapYi = mcap / 100000000;
          if (mcapYi < minMcapYi || mcapYi > maxMcapYi) continue;
          const signals = [];
          signals.push('涨幅' + chg.toFixed(1) + '%');
          if (hasLimitUp) signals.push('涨停基因✓');
          signals.push('量比' + volRatio.toFixed(2));
          signals.push('换手' + tr.toFixed(1) + '%');
          signals.push('市值' + mcapYi.toFixed(0) + '亿');
          results.push({ code: item.code, name: item.name, score: (hasLimitUp ? 40 : 0) + (chg >= 4 ? 20 : 10) + (volRatio >= 1.5 ? 20 : 10) + (tr >= 6 && tr <= 8 ? 20 : 10), signals, metrics: { changePercent: chg, turnoverRate: tr, mcapYi, volRatio, hasLimitUp } });
        }
        return results;
      },
    }
  ],
};

export default plugin;
