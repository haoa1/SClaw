const m = require('/root/sclaw/backend/dist/chan/engine.js');
const Database = require('better-sqlite3');
const db = new Database('/root/sclaw/data/stock_history.db', { readonly: true });

function run(code, level, limit, table, timeCol) {
  const rows = db.prepare('SELECT ' + timeCol + ' AS date, open, high, low, close, volume FROM ' + table + ' WHERE code = ? ORDER BY ' + timeCol + ' DESC LIMIT ?').all(code, limit).reverse();
  const a = m.analyzeChan(rows, code, level);
  console.log(code + ' ' + level + ': K=' + rows.length + ' bis=' + a.bis.length + ' segs=' + a.segments.length + ' zs=' + a.zhongshus.length + ' trend=' + a.trend);
  for (let i = 0; i < a.zhongshus.length; i++) {
    const z = a.zhongshus[i];
    const ks = rows.slice(z.startIdx, z.endIdx + 1);
    const pierce = ks.filter(k => k.high > z.zg || k.low < z.zd).length;
    console.log('  ZS' + (i + 1) + ': K[' + z.startIdx + '-' + z.endIdx + '] ' + rows[z.startIdx].date + ' ~ ' + rows[z.endIdx].date + ' ZG=' + z.zg + ' ZD=' + z.zd + ' W=' + (z.zg - z.zd).toFixed(2) + ' pierce=' + (pierce / ks.length * 100).toFixed(0) + '% seg=' + (z.segmentStart + 1) + '-' + (z.segmentEnd + 1));
  }
}

run('688352', 'm60', 600, 'stock_kline_60m', 'datetime');
run('600519', 'daily', 600, 'stock_daily', 'date');
run('000001', 'daily', 600, 'stock_daily', 'date');
