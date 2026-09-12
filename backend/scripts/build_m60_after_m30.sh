#!/bin/bash
# 等 m30 建库跑完，再建 60m 干净库（串行，避免同源库 I/O 争抢）
# 由 systemd-run 拉起 → 独立 cgroup，Garuda 重启不会团灭
set -u
LOG=/tmp/build_m60.log
wait_pid() {
  local pid=$1 i=0
  while true; do
    # 进程存在且命令里还是 build_m30_clean.py 才算还在跑（防 PID 复用）
    if ! grep -qa "build_m30_clean.py" /proc/$pid/cmdline 2>/dev/null; then
      echo "[chain] pid $pid 已退出/复用，开始 60m 建库" 
      return 0
    fi
    sleep 15
    i=$((i+1))
    if [ $((i % 20)) -eq 0 ]; then echo "[chain] 仍在等 pid $pid ... ($((i*15))s)"; fi
  done
}

{
  echo "=== chain start $(date '+%F %T') ==="
  wait_pid 341001
  cd /root/sclaw/backend || exit 1
  echo "=== 60m build start $(date '+%F %T') ==="
  python3 scripts/build_m30_clean.py --period 60
  rc=$?
  echo "=== 60m build end $(date '+%F %T') rc=$rc ==="
} >> "$LOG" 2>&1
