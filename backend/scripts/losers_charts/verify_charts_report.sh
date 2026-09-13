#!/bin/bash
# 真浏览器验证（v2·2026-09-13 筹码/MACD 补丁后）
#   A) 产物完整性：http(s) URL → 用 mTLS 客户端证书 curl 拉取，md5 对齐本地权威件；无证书须 403
#   B) 几何量测：月份刻度 × 图例 重叠 / 右面板标签越界 / 全图 text 两两重叠
#   C) 开关自检：勾选「显示全部逐笔」→ .full 由 display:none → 可见（可逆）
#   D) 开关视觉证据：元素截图 OFF vs ON，md5 必须不同
#   E) JS 异常
# 用法: bash verify_charts_report.sh [URL]
#   默认验本地权威产物；给 https://... 则先拉线上字节再验同一套（⚠️ agent-browser 不带客户端证书，
#   https 站点必须「先 curl 落地、再对落地文件开浏览器」，直接开 URL 只会看到 nginx 403 空白页）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CANON="/root/research_archive/losers_charts_20260913/charts_report.html"
U="${1:-file://$CANON}"
SHOT="${SHOT_DIR:-$HERE/_verify_shots}"
SERVED="${SERVED_PATH:-/tmp/verify_charts_served.html}"
MTLS=/etc/nginx/ssl/mtls
FAIL=0

echo "=== 0) 依赖检查 ==="
command -v agent-browser >/dev/null || { echo "❌ 缺 agent-browser"; exit 1; }
fc-list 2>/dev/null | grep -qi "Noto Sans CJK" || echo "⚠️  未装 fonts-noto-cjk（截图汉字可能豆腐块）"
echo "URL: $U"

if [ "${U#http}" != "$U" ]; then
  echo "=== 1a) 产物完整性（mTLS curl，按 §CLAUDE 记忆：https 站点浏览器进不去） ==="
  CERT=(); [ -f "$MTLS/client.crt" ] && CERT=(--cacert "$MTLS/ca.crt" --cert "$MTLS/client.crt" --key "$MTLS/client.key")
  curl -sS "${CERT[@]}" -o "$SERVED" -w "code=%{http_code} size=%{size_download}\n" "$U" || { echo "❌ 拉取失败"; FAIL=1; }
  SMD5=$(md5sum "$SERVED" | cut -d' ' -f1)
  echo "served md5=$SMD5  size=$(stat -c%s "$SERVED" 2>/dev/null)"
  if [ -f "$CANON" ]; then
    CMD5=$(md5sum "$CANON" | cut -d' ' -f1); echo "canon  md5=$CMD5"
    [ "$SMD5" = "$CMD5" ] && echo "✅ SERVED_IS_CANON=yes" || { echo "❌ SERVED_IS_CANON=no（线上≠本地权威件）"; FAIL=1; }
  else echo "⚠️  本地权威件不存在，跳过对齐"; fi
  if [ "${#CERT[@]}" != "0" ]; then
    NC=$(curl -sS --cacert "$MTLS/ca.crt" -o /dev/null -w "%{http_code}" --max-time 20 "$U" || echo 000)
    [ "$NC" = "403" ] && echo "✅ 无证书=403" || { echo "⚠️  无证书 code=$NC（期望 403）"; FAIL=1; }
  fi
  U="file://$SERVED"
  echo "→ 浏览器改验落地副本: $U"
else
  echo "=== 1a) 本地权威产物（跳过 mTLS 拉取） ==="
  ls -la "$CANON" 2>/dev/null | tail -1
fi

echo "=== 1b) open（必须重开，否则看到旧 DOM） ==="
agent-browser open "$U" >/dev/null
sleep 3
agent-browser set viewport 1400 1500 >/dev/null
HEAD="$(agent-browser eval "document.title + ' | bodyLen=' + document.body.innerHTML.length + ' | svg=' + document.querySelectorAll('svg').length" 2>&1 | tail -1)"
echo "$HEAD"
echo "$HEAD" | grep -q "svg=18" || { echo "❌ 页面没加载出 18 张图（空白/403？）"; FAIL=1; }

echo "=== 2) 几何量测（决定性） ==="
GEO="$(agent-browser eval "$(cat "$HERE/check_overlap.js")" 2>&1 | tail -1)"
echo "$GEO"
echo "$GEO" | grep -q "overlapPairs=0"      || { echo "❌ 月份刻度与图例重叠"; FAIL=1; }
echo "$GEO" | grep -q "textOverlapTotal=0" || { echo "❌ 存在文字两两重叠";   FAIL=1; }
echo "$GEO" | grep -q "rightOutTotal=0"    || { echo "❌ 文字越出 svg 右界"; FAIL=1; }
echo "$GEO" | grep -q "\[OUT\]"            && { echo "❌ 有面板标签越界";    FAIL=1; }

echo "=== 3) 开关自检（显示全部逐笔） ==="
TOG="$(agent-browser eval "$(cat "$HERE/check_toggle.js")" 2>&1 | tail -1)"
echo "$TOG"
echo "$TOG" | grep -q "verdict=PASS" || { echo "❌ 开关无效（.full 不显示）"; FAIL=1; }

echo "=== 4) 开关视觉证据：元素截图 OFF vs ON ==="
mkdir -p "$SHOT"
agent-browser eval "document.getElementById('alltrades').checked=false;document.getElementById('alltrades').dispatchEvent(new Event('change',{bubbles:true}));document.querySelectorAll('details').forEach(function(d){d.open=false;});document.querySelectorAll('section.card')[0].querySelector('svg.chart').scrollIntoView({block:'start'});'x'" >/dev/null 2>&1
sleep 1
agent-browser screenshot "#688613_2022 svg.chart" "$SHOT/svg_off.png" >/dev/null 2>&1
agent-browser eval "document.getElementById('alltrades').checked=true;document.getElementById('alltrades').dispatchEvent(new Event('change',{bubbles:true}));'x'" >/dev/null 2>&1
sleep 1
agent-browser screenshot "#688613_2022 svg.chart" "$SHOT/svg_on.png" >/dev/null 2>&1
if [ -s "$SHOT/svg_off.png" ] && [ -s "$SHOT/svg_on.png" ]; then
  M1=$(md5sum "$SHOT/svg_off.png" | cut -d' ' -f1)
  M2=$(md5sum "$SHOT/svg_on.png" | cut -d' ' -f1)
  echo "svg_off md5=$M1"
  echo "svg_on  md5=$M2"
  if [ "$M1" = "$M2" ]; then echo "❌ TOGGLE_VISUAL_DIFF=no（截图逐像素相同 ⇒ 开关没画东西）"; FAIL=1
  else echo "✅ TOGGLE_VISUAL_DIFF=yes"; fi
else
  echo "⚠️  元素截图失败（选择器为空？）"; FAIL=1
fi

echo "=== 5) JS 异常 ==="
agent-browser errors 2>&1 | tail -5

echo
if [ "$FAIL" = "0" ]; then echo "✅ VERDICT=PASS"; else echo "❌ VERDICT=FAIL"; fi
echo "截图: $SHOT/svg_off.png, $SHOT/svg_on.png"
exit "$FAIL"
