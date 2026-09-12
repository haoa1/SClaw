#!/bin/bash
# ============================================================================
# probe_bridge_resurrect.sh — 证明「桥接会自动复活它管理的进程」
# ----------------------------------------------------------------------------
# 用途：为「切库前必须先停 garuda-mcp-bridge」提供**受控、可复现**的证据。
#       只靠历史日志（mcp_listen.log 里 5 次 [ensure] SClaw MCP down ... starting）
#       是"旁证"；本实验是"直接证据"，且带**阴性对照**。
#
# 原理：garuda_mcp.py::_listen_sse() 是 while True 循环，
#       每次回到循环顶部都会调 _ensure_sclaw()（源码 401~403 行）；
#       连接断开时打印 "reconnecting in 5s" 并 sleep 5 后回到顶部（415~416 行）；
#       _ensure_sclaw() 发现端口不通就 subprocess.Popen(sclaw_cmd)（314~340 行）。
#
# 隔离设计：全程只用端口 3999 + 假拉起命令，**绝不触碰生产 SClaw(3001)**。
#
# 预期结果（2026-09-12 13:17 实测）：
#   T0 假服务占住 3999            → 端口开
#   T1 假桥接启动                 → "[ensure] SClaw MCP already up" → SPAWN=0（阴性对照）
#   T2 kill 假服务                → 端口关
#   T3 +4s                        → "[ensure] SClaw MCP down ...; starting: ..." → SPAWN=1 ✅
#
# 用法： bash probe_bridge_resurrect.sh
# ============================================================================
set -u
LOG=/tmp/resurrect_proof.log
: > "$LOG"

echo "== T0 起一个假服务占住 3999 =="
python3 -m http.server 3999 --bind 127.0.0.1 > /tmp/fake_server.out 2>&1 &
FAKE=$!
sleep 1.5
echo "  假服务 PID=$FAKE  端口探测: $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3999/ || echo 不可达)"

echo
echo "== T1 起假桥接（--ensure，拉起命令会往 $LOG 追加 SPAWN）=="
cd /root/.garuda/workspace
timeout 40 /root/garuda/venv/bin/python3 /root/.garuda/workspace/garuda_mcp.py \
  -t sse --url http://127.0.0.1:3999/mcp --listen \
  --wake-session probe_resurrect --ensure \
  --sclaw-cmd "sh -c 'echo SPAWN \$(date +%H:%M:%S) >> /tmp/resurrect_proof.log; exec sleep 600'" \
  > /tmp/resurrect_probe.out 2>&1 &
PROBE=$!
echo "  假桥接 PID=$PROBE"
sleep 8
echo "  8s 后（假服务仍在）：SPAWN 次数=$(wc -l < "$LOG")  <- 期望 0（端口开着，不该拉）"

echo
echo "== T2 杀掉假服务（模拟 SClaw 死亡）@ $(date +%H:%M:%S) =="
kill -9 "$FAKE" 2>/dev/null
wait "$FAKE" 2>/dev/null
echo "  假服务已杀；端口: $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3999/ || echo 不可达)"

echo
echo "== T3 观察 20s，看是否自动复活 =="
for i in 1 2 3 4 5; do
  sleep 4
  echo "  t=+$((i*4))s  累计 SPAWN=$(wc -l < "$LOG")"
done

echo
echo "== 复活记录 =="
cat "$LOG"
echo
echo "== 假桥接日志（关键行）=="
grep -n "ensure\|listen" /tmp/resurrect_probe.out | head -20

echo
echo "== 清理 =="
kill "$PROBE" 2>/dev/null
pkill -f "http.server 3999" 2>/dev/null
pkill -f "sleep 600" 2>/dev/null
sleep 1
echo "  残留 sleep600=$(pgrep -fc 'sleep 600' || true)  http.server3999=$(pgrep -fc 'http.server 3999' || true)"
echo "  生产 SClaw: $(pgrep -af 'dist/index.js' || echo 无)"
echo "  生产 :3001 HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3001/mcp)"
