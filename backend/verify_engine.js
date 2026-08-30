// End-to-end: run the FIXED 早盘 task config through the REAL StrategyEngine
// (same code path the scheduler uses: union mode, correct plugin ids)
require('tsx/cjs');
const Database = require('better-sqlite3');
const db = new Database('/root/sclaw/data/stock_history.db', { readonly: true });
const { StrategyEngine } = require('/root/sclaw/backend/dist/strategies/strategy-engine.js');

const fs = require('fs');
const path = require('path');
const pluginsDir = '/root/sclaw/plugins/common';
const pluginIds = ['chan-buy-points', 'chan-theory-screener'];

function loadPlugins() {
  const plugins = [];
  for (const id of pluginIds) {
    const entryTs = path.join(pluginsDir, id, 'index.ts');
    const entryJs = path.join(pluginsDir, id, 'index.js');
    const entry = fs.existsSync(entryTs) ? entryTs : entryJs;
    const mod = require(entry);
    plugins.push(mod.default || mod);
  }
  return plugins;
}

const plugins = loadPlugins();
console.log('plugins loaded:', plugins.map(p => p.id).join(','));

// Universe: sample of recent codes with kline (like scheduler pre-filter: non-ST, >=60 bars)
const recent = db.prepare(`SELECT DISTINCT code FROM stock_daily WHERE date >= '2026-08-14' LIMIT 800`).all();
const infos = db.prepare('SELECT code, name FROM stock_info').all();
const infoMap = new Map(infos.map(r => [r.code, r.name]));
const stmt = db.prepare('SELECT date, open, high, low, close, volume FROM stock_daily WHERE code = ? ORDER BY date ASC');

const allStocks = [];
for (const r of recent) {
  const name = infoMap.get(r.code) || r.code;
  if (/^[*S]*ST/i.test(name) || name.endsWith('退')) continue;
  const kline = stmt.all(r.code);
  if (kline.length < 60) continue;
  allStocks.push({ code: r.code, name, price: kline[kline.length - 1].close, changePercent: 0, volumeRatio: 1, marketCap: 1000000000, kline });
}
console.log('universe size:', allStocks.length);

// FIXED task config (早盘): same as scheduled_tasks.json now
const strategies = [
  { pluginId: 'chan-buy-points', strategyId: 'chan-first-buy', params: {} },
  { pluginId: 'chan-buy-points', strategyId: 'chan-second-buy-daily', params: {} },
  { pluginId: 'chan-theory-screener', strategyId: 'chan-third-buy', params: {} },
];

const engine = new StrategyEngine(() => plugins);
engine.execute(allStocks, { strategies, combineMode: 'union' }).then(({ results, pluginResults }) => {
  console.log('\n=== per-strategy ===');
  for (const [k, v] of pluginResults) console.log(`  ${k}: ${v.length}`);
  console.log(`=== UNION total: ${results.length} ===`);
  results.slice(0, 15).forEach(r => console.log(`  ${r.code} ${r.name} score=${r.score}`));
}).catch(e => { console.error('ERR', e); process.exit(1); });
