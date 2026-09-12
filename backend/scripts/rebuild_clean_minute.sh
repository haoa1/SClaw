#!/bin/bash
# 串行重建 clean_m30 + clean_m60（源库 stock_history.db 已补齐至 2026-09-11）
# 用途: Step 2 —— 行数守恒 + 复权因子自证 的输入
set -u
cd /root/sclaw/backend || exit 1
LOG=/root/sclaw/backend/scripts/logs/rebuild_clean.log
mkdir -p "$(dirname "$LOG")"

{
  echo "=== REBUILD_CLEAN_START $(date '+%F %T') ==="
  echo "--- 旧库 ---"
  ls -la data/clean_m30.db data/clean_m60.db 2>/dev/null

  for P in 30 60; do
    echo
    echo "--- build period=$P start $(date '+%F %T') ---"
    python3 scripts/build_m30_clean.py --period $P
    echo "--- build period=$P end rc=$? $(date '+%F %T') ---"
  done

  echo
  echo "--- 新库 ---"
  ls -la data/clean_m30.db data/clean_m60.db 2>/dev/null
  echo
  echo "--- Step2 验收 ---"
  python3 /tmp/verify_step2.py
  echo "=== REBUILD_CLEAN_DONE $(date '+%F %T') ==="
} >> "$LOG" 2>&1
