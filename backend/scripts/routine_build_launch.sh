#!/usr/bin/env bash
# routine_build_launch.sh — 调度器薄壳（launcher）
#
# 为什么需要薄壳:
#   分时数据例行完整跑一轮要 10~30 分钟（回补 2×~5min + 重建 2×~8min + 自证 ~1min），
#   而调度器执行 bash 工具任务会**同步阻塞调度线程**（超时被杀会留下半成品）。
#   → 这里只负责「脱离进程组 + 后台启动 + 立即返回」，真正的活由 routine_build_minute.sh 干。
#
# 立即返回的内容: 启动 pid + 上一次的 status.json 概要（便于在任务结果里直接看到）
#
# 真正的告警通道: routine 自身写 logs/routine_build_status.json + routine_build_ALERT.txt，
#   由 17:50 的巡检 prompt 任务读取并唤醒 AI；本壳只保证「启得起来、不重复启」。
set -u

D=/root/sclaw/backend/scripts
STATUS="$D/logs/routine_build_status.json"
PAT="^bash $D/routine_build_minute\.sh$"   # 精确匹配（避免误伤命令行里提到 .sh 的其他进程）

if pgrep -f "$PAT" >/dev/null 2>&1; then
  echo "[launch] 已有例行实例在跑（$(pgrep -f "$PAT" | tr '\n' ' ')），本次跳过"
else
  nohup setsid bash "$D/routine_build_minute.sh" >/dev/null 2>&1 </dev/null &
  sleep 3
  PIDS=$(pgrep -f "$PAT" | tr '\n' ' ')
  if [ -n "$PIDS" ]; then
    echo "[launch] 已后台启动例行 pid=$PIDS（脱离 Garuda 进程组，Garuda 重启不影响）"
  else
    echo "[launch] !! 启动失败：3s 后未见例行进程，请检查 $D/logs/routine_build_minute.log"
    exit 1
  fi
fi

if [ -f "$STATUS" ]; then
  echo "[launch] 上一次状态:"
  python3 - "$STATUS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("  status=%s started=%s elapsed=%ss" % (d["status"], d["started_at"], d["elapsed_s"]))
print("  覆盖: 源30m=%s 源60m=%s | clean_m30=%s clean_m60=%s"
      % (d["backfill"]["src_30m"]["max_date"], d["backfill"]["src_60m"]["max_date"],
         d["clean"]["m30"]["max_date"], d["clean"]["m60"]["max_date"]))
print("  回补新增: 30m +%s 60m +%s | 重建=%s | 自证=%s"
      % (d["backfill"]["new_rows_30m"], d["backfill"]["new_rows_60m"],
         d["rebuild"]["rc"], d["verify"]["rc"]))
for a in d.get("alerts", []):
    print("  [ALERT] %s" % a)
PY
else
  echo "[launch] 尚无 status.json（首次运行中）"
fi
echo "[launch] 进度: tail -f $D/logs/routine_build_minute.log"
