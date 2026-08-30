const path = require('path');
process.chdir('/root/sclaw/backend');
require('tsx/cjs');

(async () => {
  // 1) 强制从磁盘加载修正版插件（独立进程 = 无旧缓存）
  const pluginPath = '/root/sclaw/plugins/users/2/limit-up-pullback-macd/index.ts';
  delete require.cache[require.resolve(pluginPath)];
  const mod = require(pluginPath);
  const plugin = mod.default || mod;
  console.log('PLUGIN:', plugin.id, plugin.version, plugin.name);

  const strat = plugin.strategies.find(s => s.id === 'limit-up-pullback-green-shrink');
  console.log('STRATEGY:', strat.id, strat.name);

  // 2) 拉全市场实时行情
  const { DataFetcher } = require('/root/sclaw/backend/dist/data/data-fetcher.js');
  const df = new DataFetcher();
  console.log('Fetching all stocks...');
  const allStocks = await df.fetchAllStocks(['SH','SZ','BJ']);
  console.log('TOTAL:', allStocks.length);

  // 3) 逐只拉日K（300根），给 kline 字段
  const detectMkt = (code) => (code.startsWith('6') || code.startsWith('9')) ? 'SH' : 'SZ';
  let done = 0;
  const CONC = 20;
  for (let i = 0; i < allStocks.length; i += CONC) {
    await Promise.all(allStocks.slice(i, i + CONC).map(async (stock) => {
      try {
        const { data: daily } = await df.fetchKLine(stock.code, detectMkt(stock.code), 300);
        stock.kline = daily;
      } catch (e) { stock.kline = []; }
    }));
    done += CONC;
    if (done % 1000 === 0) console.log('kline fetched:', done);
  }
  console.log('All klines fetched');

  // 4) 用默认参数跑修正版策略
  const results = strat.execute(allStocks, {
    lookbackDays: 20, minStreak: 3, pullbackMin: 8, pullbackMax: 45,
    shrinkDays: 2, nearZeroAbs: 0.5
  });
  console.log('MATCHES:', results.length);
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
