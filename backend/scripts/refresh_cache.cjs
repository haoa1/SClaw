const { DataFetcher } = require('/root/sclaw/backend/dist/data/data-fetcher');
const f = new DataFetcher();
f.clearCache();
f.fetchAllStocks(['SH', 'SZ', 'BJ']).then(stocks => {
  const bj = stocks.filter(s => s.code.startsWith('92'));
  console.log('Refresh done: ' + stocks.length + ' stocks, BJ: ' + bj.length);
  if (bj.length > 0) {
    console.log('Sample BJ:', JSON.stringify(bj[0]));
  }
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
