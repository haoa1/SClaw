#!/bin/bash
# 全量 v2 重建驱动：每轮最多 1.5h，挂了就重启续传（靠 done 表）。
# 2026-09-12 修补：去掉 `| tail -30`（管道缓冲导致看不到实时进度），
# 改为直接 append 到 LOG，可 tail -f 实时观察。
DB=/root/sclaw/backend/data/clean_daily_v2.db
LOG=/tmp/v2_driver.log
cd /tmp
for i in $(seq 1 300); do
  echo "=== pass $i  $(date '+%F %H:%M:%S') ===" >> "$LOG"
  timeout 5400 python3 -u /tmp/v2_build.py --beg 2015-01-01 --end 2026-09-11 >> "$LOG" 2>&1
  rc=$?
  n=$(python3 -c "
import sqlite3
try:
    c=sqlite3.connect('file:$DB?mode=ro',uri=True)
    print(c.execute('select count(*) from done').fetchone()[0])
except Exception:
    print('?')
" 2>/dev/null)
  echo "pass=$i rc=$rc done=$n  $(date '+%F %H:%M:%S')" >> "$LOG"
  if [ "$rc" = "0" ]; then
    echo "ALL DONE" >> "$LOG"
    break
  fi
  sleep 5
done
echo "=== driver exit ===" >> "$LOG"
