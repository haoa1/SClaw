#!/bin/bash
# 真浏览器验证：几何量测（决定性）+ 逐卡截图（肉眼确认）
# 用法: bash verify_charts_report.sh [URL]
#   默认验线上 URL；给 file:///... 可验本地产物
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
U="${1:-https://garuda.yizhipotian.top:8443/static/losers_charts_20260913/charts_report.html}"

echo "=== 0) 已安装 agent-browser / CJK 字体？ ==="
command -v agent-browser >/dev/null || { echo "缺 agent-browser"; exit 1; }
fc-list 2>/dev/null | grep -qi "Noto Sans CJK" || echo "⚠️  未装 fonts-noto-cjk —— 截图里汉字可能是豆腐块"

echo "=== 1) open（必须重开，否则看到旧 DOM） ==="
agent-browser open "$U" >/dev/null
sleep 3
agent-browser set viewport 1400 1500 >/dev/null

echo "=== 2) 几何量测：月份刻度 vs 图例 重叠对数 / 右面板标签是否越界 ==="
agent-browser eval "$(cat "$HERE/check_overlap.js")"

echo
echo "=== 3) 逐卡截图（第1张与第6张） ==="
agent-browser eval 'var c=document.querySelectorAll("section.card")[0];document.querySelectorAll("details").forEach(function(d){d.open=false;});c.querySelector("details").open=true;c.scrollIntoView({block:"start"});c.id'
sleep 1
agent-browser screenshot chart_card1.png
agent-browser eval 'var c=document.querySelectorAll("section.card")[5];c.scrollIntoView({block:"start"});c.id'
sleep 1
agent-browser screenshot chart_card6.png

echo "=== 4) JS 异常 ==="
agent-browser errors 2>&1 | tail -5

echo
echo "判据: overlapPairs=0 且右面板标签 [in] 且无 JS 异常 → PASS"
echo "截图: $(pwd)/chart_card1.png, chart_card6.png（用 read_image 看）"
