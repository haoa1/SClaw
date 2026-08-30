// Verify: do chan-first-buy / chan-second-buy-daily / chan-third-buy actually match stocks
// when resolved to the CORRECT plugins (as the API auto-resolve does)?
// Mimics scheduler: prefilter + attach kline from DB + run strategies (union).
const Database = require('better-sqlite3');
const db = new Database('/root/sclaw/data/stock_history.db', { readonly: true });

const buyPointsPlugin = require('/root/sclaw/backend/dist-plugins/plugins/common/chan-buy-points/index.js').default;
const theoryPlugin = require('/root/sclaw/backend/dist-plugins/plugins/common/chan-theory-screener/index.js').default;

// ---- Load universe (mimic scheduler pre-filter lightly: non-ST, >=60 bars) ----
const infos = db.prepare('SELECT code, name FROM stock_info').all();
const infoMap = new Map(infos.map(r => [r.code, r.name]));

const rows = db.prepare(`
  SELECT code, COUNT(*) c FROM stock_daily GROUP BY code HAVING c >= 60
`).all();
console.log(`[prefilter] codes with >=60 bars: ${rows.length}`);

const universe = [];
for (const r of rows) {
  const name = infoMap.get(r.code) || r.code;
  if (/^[*S]*ST/i.test(name) || name.endsWith('退')) continue;
  universe.push({ code: r.code, name, price: 0, changePercent: 0, kline: null });
}
console.log(`[prefilter] after ST filter: ${universe.length}`);

// ---- Attach kline ----
const stmt = db.prepare('SELECT date, open, high, low, close, volume FROM stock_daily WHERE code = ? ORDER BY date ASC');
let attached = 0;
for (const s of universe) {
  const kline = stmt.all(s.code);
  if (kline.length >= 60) {
    s.kline = kline;
    s.price = kline[kline.length - 1].close;
    attached++;
  }
}
console.log(`[kline] attached ${attached} stocks`);

// ---- Run the three strategies via CORRECT plugin resolution ----
const strategies = [
  { pluginId: 'chan-buy-points', strategyId: 'chan-first-buy', plugin: buyPointsPlugin },
  { pluginId: 'chan-buy-points', strategyId: 'chan-second-buy-daily', plugin: buyPointsPlugin },
  { pluginId: 'chan-theory-screener', strategyId: 'chan-third-buy', plugin: theoryPlugin },
];

const union = new Map();
for (const cfg of strategies) {
  const strat = cfg.plugin.strategies.find(s => s.id === cfg.strategyId);
  if (!strat) { console.log(`MISSING STRATEGY ${cfg.pluginId}/${cfg.strategyId}`); continue; }
  const t0 = Date.now();
  const hits = strat.execute(universe, {});
  console.log(`\n=== ${cfg.pluginId}/${cfg.strategyId}: ${hits.length} matches (${Date.now() - t0}ms) ===`);
  hits.slice(0, 8).forEach(h => console.log(`  ${h.code} ${h.name} score=${h.score} signals=${JSON.stringify(h.signals)}`));
  for (const h of hits) union.set(h.code, h);
}

console.log(`\n[UNION] total unique matches: ${union.size}`);
