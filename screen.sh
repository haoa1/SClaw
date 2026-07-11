#!/usr/bin/env bash
# ==============================================================
#  选股快捷脚本 — 手动执行任意策略
#  用法:
#    bash screen.sh <strategyId> [strategyId2 ...]
#    bash screen.sh         ← 列出可用策略
#
#  示例:
#    bash screen.sh chan-first-buy
#    bash screen.sh chan-second-buy
#    bash screen.sh chan-first-buy chan-second-buy
#    bash screen.sh dt-filter
# ==============================================================
set -e
API="http://localhost:3001"

if [ $# -eq 0 ]; then
  echo "📋 可用策略:"
  curl -s "$API/api/plugins" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    for (const p of d.plugins) {
      for (const s of p.strategies) {
        const cat = s.category || 'other';
        console.log('  ' + s.id.padEnd(28) + ' ' + s.name + '  (' + cat + ')');
      }
    }
  "
  echo ""
  echo "使用: bash screen.sh <strategyId> [strategyId2 ...]"
  exit 0
fi

# 构建请求体
STRATEGIES="["
FIRST=true
for SID in "$@"; do
  if [ "$FIRST" = true ]; then FIRST=false; else STRATEGIES+=","; fi
  STRATEGIES+="{\"pluginId\":\"\",\"strategyId\":\"$SID\",\"params\":{}}"
done
STRATEGIES+="]"

# 调用 API（用 node 避免 curl 的 Content-Type 问题）
node -e "
const http = require('http');
const p = JSON.stringify({ strategies: $STRATEGIES, market: ['SH','SZ'] });
const t0 = Date.now();
const r = http.request({
  hostname: 'localhost', port: 3001, path: '/api/screen',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const elapsed = ((Date.now() - t0)/1000).toFixed(1);
    const j = JSON.parse(d);
    if (j.error) {
      console.log('\\n❌ 错误:', j.error, j.detail || '');
      process.exit(1);
    }
    const s = j.stats;
    console.log('\\n📊 选股结果: ' + s.matchedStocks + '/' + s.totalStocks + '  (' + elapsed + 's)\\n');
    if (s.matchedStocks === 0) {
      console.log('  (无匹配)');
      return;
    }
    // 按评分降序
    const sorted = (j.results || []).sort((a,b) => b.score - a.score);
    // 表头
    console.log('  ' + '代码'.padEnd(9) + '名称'.padEnd(12) + '评分'.padEnd(6) + '涨幅'.padEnd(8) + '信号');
    console.log('  ' + '────'.padEnd(9) + '────'.padEnd(12) + '────'.padEnd(6) + '────'.padEnd(8) + '──────────────────────────────────────');
    for (const r of sorted) {
      const scoreStr = String(r.score);
      const chg = (r.metrics?.changePercent ?? 0).toFixed(1) + '%';
      const sigs = r.signals.slice(0, 5).join(', ') + (r.signals.length > 5 ? '…' : '');
      console.log('  ' + r.code.padEnd(9) + r.name.padEnd(12) + scoreStr.padEnd(6) + chg.padEnd(8) + sigs);
    }
    console.log('');
    // 高评分提示
    const top = sorted.filter(r => r.score >= 70);
    if (top.length > 0) {
      console.log('  ⭐ 高评分(≥70): ' + top.map(r => r.name + '(' + r.code + '/' + r.score + ')').join(', '));
    }
  });
});
r.write(p);
r.end();
" 2>&1
