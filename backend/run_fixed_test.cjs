const path = require('path');
require('tsx/cjs');
// Force fresh load of the FIXED plugin (clear any cached module)
const pluginPath = '/root/sclaw/plugins/common/limit-up-pullback-macd/index.ts';
delete require.cache[require.resolve(pluginPath)];
const plugin = require(pluginPath).default || require(pluginPath);
console.log('PLUGIN:', plugin.id, 'v' + plugin.version, '| strategies:', plugin.strategies.map(s=>s.id).join(','));

const { DataFetcher } = require('/root/sclaw/backend/dist/data/data-fetcher.js');
const fetcher = new DataFetcher();

(async () => {
  const t0 = Date.now();
  const allStocks = await fetcher.fetchAllStocks(['SH','SZ','BJ']);
  console.log('Fetched quotes:', allStocks.length, 'in', Date.now()-t0, 'ms');

  // Build StockData objects with daily klines (same as api.js screen pipeline)
  const CONCURRENCY = 20;
  const stocks = [];
  let idx = 0;
  async function worker() {
    while (idx < allStocks.length) {
      const i = idx++;
      const s = allStocks[i];
      if (!s || !s.code) continue;
      const mkt = s.market || ((s.code.startsWith('6')||s.code.startsWith('9')) ? 'SH' : 'SZ');
      try {
        const { data: daily } = await fetcher.fetchKLine(s.code, mkt, 120);
        stocks.push({ code: s.code, name: s.name, market: mkt, kline: daily || [] });
      } catch (e) { /* skip */ }
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  console.log('Klines fetched:', stocks.length, 'in', Date.now()-t0, 'ms');

  // Run the strategy with user's default params (3连板, 回调8~45%, 绿柱见顶连续缩短贴近0轴)
  const strategy = plugin.strategies[0];
  const params = { lookbackDays: 20, minStreak: 3, pullbackMin: 8, pullbackMax: 45, shrinkDays: 2, nearZeroAbs: 0.5 };
  const results = strategy.execute(stocks, params);
  console.log('MATCHES:', results.length);
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
