#!/bin/bash
# 分时源数据补齐: 2026-09-08(修复截断) ~ 2026-09-11 的 30m + 60m
# 用法: nohup bash run_backfill_minute.sh > logs/backfill_minute.log 2>&1 &
set -u
cd /root/sclaw/backend/scripts
mkdir -p logs
LOG=logs/backfill_minute.log
echo "=== 开始 $(date '+%F %T') ==="
echo "--- 源库补齐前 ---"
python3 - <<'PY'
import sqlite3
r = sqlite3.connect("file:/root/sclaw/backend/data/stock_history.db?mode=ro", uri=True)
for t in ("stock_kline_30m", "stock_kline_60m"):
    print("  %s rows=%d max=%s" % ((t,) + r.execute("SELECT COUNT(*), MAX(datetime) FROM %s" % t).fetchone()))
PY

for P in 30 60; do
  echo
  echo "=== period=$P 开始 $(date '+%F %T') ==="
  python3 backfill_m30.py --start 2026-09-08 --end 2026-09-11 --period $P --workers 10
  echo "=== period=$P 结束 rc=$? $(date '+%F %T') ==="
done

echo
echo "--- 源库补齐后 ---"
python3 - <<'PY'
import sqlite3
r = sqlite3.connect("file:/root/sclaw/backend/data/stock_history.db?mode=ro", uri=True)
for t in ("stock_kline_30m", "stock_kline_60m"):
    print("  %s rows=%d max=%s" % ((t,) + r.execute("SELECT COUNT(*), MAX(datetime) FROM %s" % t).fetchone()))
    for d, n in r.execute("SELECT substr(datetime,1,10) d, COUNT(*) FROM %s GROUP BY d ORDER BY d DESC LIMIT 5" % t):
        print("     %s bars=%d" % (d, n))
PY
echo "=== BACKFILL_ALL_DONE $(date '+%F %T') ==="
