// Fast verification: do the 3 chan buy-point strategies match anything
// when resolved to CORRECT plugins? Sample-based for speed.
const Database = require('better-sqlite3');
const db = new Database('/root/sclaw/data/stock_history.db', { readonly: true });

const buyPointsPlugin = require('/root/sclaw/backend/dist-plugins/plugins/common/chan-buy-points/index.js').default;
const theoryPlugin = require('/root/sclaw/backend/dist-plugins/plugins/common/chan-theory-screener/index.js').default;

function log(...a) { console.log(...a); }

// Sample universe: codes with a recent bar, limit 600
const recent = db.prepare(`
  SELECT DISTINCT code FROM stock_daily WHERE date >= '2026-08-10' LIMIT 600
`).all();
log('[prefilter] recent sample codes:', recent.length);

const infos = db.prepare('SELECT code, name FROM stock_info').all();
const infoMap = new Map(infos.map(r => [r.code, r.name]));

const universe = [];
for (const r of recent) {
  const name = infoMap.get(r.code) || r.code;
  if (/^[*S]*ST/i.test(name) || name.endsWith('退')) continue;
  universe.push({ code: r.code, name, price: 0, changePercent: 0, kline: null });
}
log('[prefilter] after ST filter:', universe.length);

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
log('[kline] attached:', attached);

const strategies = [
  { pluginId: 'chan-buy-points', strategyId: 'chan-first-buy', plugin: buyPointsPlugin },
  { pluginId: 'chan-buy-points', strategyId: 'chan-second-buy-daily', plugin: buyPointsPlugin },
  { pluginId: 'chan-theory-screener', strategyId: 'chan-third-buy', plugin: theoryPlugin },
];

const union = new Map();
for (const cfg of strategies) {
  const strat = cfg.plugin.strategies.find(s => s.id === cfg.strategyId);
  if (!strat) { log('MISSING STRATEGY', cfg.pluginId + '/' + cfg.strategyId); continue; }
  const t0 = Date.now();
  const hits = strat.execute(universe, {});
  log(`\n=== ${cfg.pluginId}/${cfg.strategyId}: ${hits.length} matches (${Date.now() - t0}ms) ===`);
  hits.slice(0, 10).forEach(h => log(`  ${h.code} ${h.name} score=${h.score} ${JSON.stringify(h.signals)}`));
  for (const h of hits) union.set(h.code, h);
}
log(`\n[UNION] total unique: ${union.size}`);
