// Verify chan-third-buy after pivot fix — sample universe
const Database = require('better-sqlite3');
const db = new Database('/root/sclaw/data/stock_history.db', { readonly: true });

const theoryPlugin = require('/root/sclaw/backend/dist-plugins/plugins/common/chan-theory-screener/index.js').default;
const buyPointsPlugin = require('/root/sclaw/backend/dist-plugins/plugins/common/chan-buy-points/index.js').default;

const recent = db.prepare(`SELECT DISTINCT code FROM stock_daily WHERE date >= '2026-08-10' LIMIT 1200`).all();
const infos = db.prepare('SELECT code, name FROM stock_info').all();
const infoMap = new Map(infos.map(r => [r.code, r.name]));

const universe = [];
for (const r of recent) {
  const name = infoMap.get(r.code) || r.code;
  if (/^[*S]*ST/i.test(name) || name.endsWith('退')) continue;
  universe.push({ code: r.code, name, price: 0, changePercent: 0, kline: null });
}

const stmt = db.prepare('SELECT date, open, high, low, close, volume FROM stock_daily WHERE code = ? ORDER BY date ASC');
let attached = 0;
for (const s of universe) {
  const kline = stmt.all(s.code);
  if (kline.length >= 60) { s.kline = kline; s.price = kline[kline.length - 1].close; s.changePercent = 2.0; attached++; }
}
console.log('[universe] attached:', attached);

for (const [pluginId, plugin, strategyId] of [
  ['chan-buy-points', buyPointsPlugin, 'chan-first-buy'],
  ['chan-buy-points', buyPointsPlugin, 'chan-second-buy-daily'],
  ['chan-theory-screener', theoryPlugin, 'chan-third-buy'],
]) {
  const strat = plugin.strategies.find(s => s.id === strategyId);
  const t0 = Date.now();
  const hits = strat.execute(universe, {});
  console.log(`\n=== ${pluginId}/${strategyId}: ${hits.length} matches (${Date.now() - t0}ms) ===`);
  hits.slice(0, 8).forEach(h => console.log(`  ${h.code} ${h.name} score=${h.score} ${JSON.stringify(h.signals)}`));
}
