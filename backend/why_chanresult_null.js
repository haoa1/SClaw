// 测试: 为什么 688615 等走简化版 (chanResult=null)
const Database = require('better-sqlite3');
const { analyzeChan } = require('/root/sclaw/backend/dist/chan/engine.js');
const db = new Database('/root/sclaw/data/stock_history.db', { readonly: true });

const codes = ['688615', '600226', '603283', '688352', '688158', '605006'];
for (const code of codes) {
  const rows = db.prepare('SELECT date, open, high, low, close, volume FROM stock_daily WHERE code = ? ORDER BY date DESC LIMIT 300').all(code).reverse();
  console.log(code + ': kline=' + rows.length);
  if (rows.length < 30) { console.log('  -> kline < 30, skip'); continue; }
  try {
    const a = analyzeChan(rows, code, 'daily');
    console.log('  -> analyzeChan OK: bis=' + a.bis.length + ' segs=' + a.segments.length + ' zs=' + a.zhongshus.length + ' tps=' + a.tradePoints.length + ' divs=' + a.divergences.length);
  } catch (e) {
    console.log('  -> analyzeChan ERROR: ' + e.message);
  }
}
