#!/usr/bin/env bash
# routine_build_minute.sh — 分时数据全链路例行（建库例行化的唯一入口）
#
#  ① 增量回补源库 stock_history.db 的 stock_kline_30m / stock_kline_60m（baostock，幂等）
#  ② 重建 clean_m30 / clean_m60（build_m30_clean.py，内含成交量口径自证，失败 exit 3）
#  ③ 全项自证 verify_minute_clean.py（A行数/B因子/C聚合/D量额/E形态/G量纲）
#  ④ 状态落盘 logs/routine_build_status.json；失败写 logs/routine_build_ALERT.txt
#     并在 stdout 打印 [ALERT] 块（供调度器唤醒告警）
#
# 设计要点:
#  - flock 单例：绝不并发跑（避免两个进程同时重建同一库）
#  - 无新数据则跳过重建：源库 max(date) <= 产物覆盖末端时，重建没有意义（节假日/提前跑）
#  - 幂等：回补用 INSERT OR REPLACE；重建是「先建临时库再替换」，重复跑结果一致
#  - 只读源库、产物库有 .bak 备份由 build 脚本自身负责
#
# 环境变量:
#   LOOKBACK_DAYS=5   回补回溯天数（覆盖漏跑一天 + 假期）
#   SKIP_BACKFILL=1   跳过第①步（仅重建+自证）
#   SKIP_VERIFY=1     跳过第③步
#   FORCE_REBUILD=1   即使无新数据也重建
#
# 退出码: 0=通过（含 skip）  1=有步骤失败
set -u

BACKEND=/root/sclaw/backend
LOGDIR="$BACKEND/scripts/logs"
LOG="$LOGDIR/routine_build_minute.log"
STATUS="$LOGDIR/routine_build_status.json"
ALERT="$LOGDIR/routine_build_ALERT.txt"
LOCK="$LOGDIR/.routine_build_minute.lock"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-5}"
SKIP_BACKFILL="${SKIP_BACKFILL:-0}"
SKIP_VERIFY="${SKIP_VERIFY:-0}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"

cd "$BACKEND" || exit 1
mkdir -p "$LOGDIR"

# 全部输出同时落日志文件（调度器只抓到 stdout 尾部，日志保留全过程）
exec > >(tee -a "$LOG") 2>&1

# ---------- 单例锁 ----------
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[skip] $(date '+%F %T') 已有例行实例在跑，本次直接退出（不排队）"
  exit 0
fi

T0=$(date +%s)
START_AT=$(date '+%F %T')
START_DATE=$(date -d "-${LOOKBACK_DAYS} days" +%F 2>/dev/null || date +%F)
END_DATE=$(date +%F)
ALERTS=()
declare -A STEP_RC=()

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 源库/产物库的日期覆盖（date-only）
read_cov() {
  python3 - "$1" <<'PY'
import sqlite3, sys
what = sys.argv[1]
D = "/root/sclaw/backend/data"
if what == "30m" or what == "60m":
    c = sqlite3.connect("file:%s/stock_history.db?mode=ro" % D, uri=True)
    n, mx = c.execute("SELECT COUNT(*), MAX(substr(datetime,1,10)) FROM stock_kline_%s" % what).fetchone()
    print("%s %s" % (n, mx or "-"))
else:
    t = "m30" if what == "m30" else "m60"
    c = sqlite3.connect("file:%s/clean_%s.db?mode=ro" % (D, what), uri=True)
    n = c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
    meta = dict(c.execute("SELECT key,value FROM meta").fetchall())
    rng = meta.get("date_range", "") or ""
    print("%s %s" % (n, rng.split("~")[-1].strip() or "-"))
PY
}

echo "=================================================================="
log "分时数据例行开始  window=$START_DATE..$END_DATE lookback=${LOOKBACK_DAYS}d"
log "例行前覆盖: 源30m[$(read_cov 30m)]  源60m[$(read_cov 60m)]  clean_m30[$(read_cov m30)]  clean_m60[$(read_cov m60)]"

# ---------- ① 增量回补 ----------
BF_ROWS_BEFORE_30=$(read_cov 30m | cut -d' ' -f1)
BF_ROWS_BEFORE_60=$(read_cov 60m | cut -d' ' -f1)
if [ "$SKIP_BACKFILL" = "1" ]; then
  log "① 回补: 跳过 (SKIP_BACKFILL=1)"
  STEP_RC[backfill]="skip"
else
  bf_rc=0
  for P in 30 60; do
    log "① 回补 period=$P start=$START_DATE end=$END_DATE ..."
    python3 scripts/backfill_m30.py --start "$START_DATE" --end "$END_DATE" --period "$P" --workers 10
    rc=$?
    if [ $rc -eq 0 ]; then
      log "① 回补 period=$P OK"
    else
      bf_rc=1; ALERTS+=("回补 period=$P 失败(rc=$rc)")
      log "① 回补 period=$P 失败 rc=$rc"
    fi
  done
  if [ $bf_rc -eq 0 ]; then STEP_RC[backfill]="ok"; else STEP_RC[backfill]="fail"; fi
fi
BF_ROWS_AFTER_30=$(read_cov 30m | cut -d' ' -f1)
BF_ROWS_AFTER_60=$(read_cov 60m | cut -d' ' -f1)
NEW_30=$((BF_ROWS_AFTER_30 - BF_ROWS_BEFORE_30))
NEW_60=$((BF_ROWS_AFTER_60 - BF_ROWS_BEFORE_60))
log "① 回补新增: 30m +$NEW_30  60m +$NEW_60"

# ---------- ② 重建 clean（无新数据则跳过） ----------
SRC_MAX_30=$(read_cov 30m | cut -d' ' -f2)
SRC_MAX_60=$(read_cov 60m | cut -d' ' -f2)
CLN_MAX_30=$(read_cov m30 | cut -d' ' -f2)
CLN_MAX_60=$(read_cov m60 | cut -d' ' -f2)

need_p30=1; need_p60=1
if [ "$FORCE_REBUILD" != "1" ]; then
  # 源末端 <= 产物末端 ⇒ 没有新数据，重建无意义（注意是 <=，相等也要跳过）
  if [ "$SRC_MAX_30" \< "$CLN_MAX_30" ] || [ "$SRC_MAX_30" = "$CLN_MAX_30" ]; then need_p30=0; fi
  if [ "$SRC_MAX_60" \< "$CLN_MAX_60" ] || [ "$SRC_MAX_60" = "$CLN_MAX_60" ]; then need_p60=0; fi
fi
if [ "$FORCE_REBUILD" = "1" ]; then need_p30=1; need_p60=1; fi
log "② 重建判定: 源30m末端=$SRC_MAX_30 产物末端=$CLN_MAX_30 → $([ $need_p30 = 1 ] && echo 重建 || echo 跳过); 源60m末端=$SRC_MAX_60 产物末端=$CLN_MAX_60 → $([ $need_p60 = 1 ] && echo 重建 || echo 跳过)"

rb_rc=0
BUILT=()
for P in 30 60; do
  if [ "$P" = "30" ]; then need=$need_p30; srcmax=$SRC_MAX_30; else need=$need_p60; srcmax=$SRC_MAX_60; fi
  if [ "$need" = "0" ]; then
    log "② 重建 clean_m$P: 跳过（产物已覆盖源末端 $srcmax）"
    continue
  fi
  log "② 重建 clean_m$P ..."
  python3 scripts/build_m30_clean.py --period "$P"
  rc=$?
  if [ $rc -eq 0 ]; then
    BUILT+=("m$P"); log "② 重建 clean_m$P OK"
  else
    rb_rc=1; ALERTS+=("重建 clean_m$P 失败(rc=$rc)")
    log "② 重建 clean_m$P 失败 rc=$rc"
  fi
done
if [ $rb_rc -eq 0 ]; then STEP_RC[rebuild]="${BUILT[*]:-skip}"; else STEP_RC[rebuild]="fail"; fi

# ---------- ③ 全项自证 ----------
VERIFY_LINE="(skipped)"
if [ "$SKIP_VERIFY" = "1" ]; then
  STEP_RC[verify]="skip"
else
  VS="$LOGDIR/routine_build_verify.out"
  log "③ 自证 verify_minute_clean.py ..."
  if python3 scripts/verify_minute_clean.py > "$VS" 2>&1; then
    STEP_RC[verify]="ok"
  else
    STEP_RC[verify]="fail"
    ALERTS+=("自证未通过: $(grep -m1 'VERIFY_RESULT' "$VS" | cut -c1-400)")
  fi
  VERIFY_LINE=$(grep -m1 'VERIFY_RESULT' "$VS" || echo "(无结论行)")
  log "③ $VERIFY_LINE"
fi

# ---------- ④ 状态落盘 + 告警 ----------
ELAPSED=$(( $(date +%s) - T0 ))
COV_SRC_30="$(read_cov 30m)"; COV_SRC_60="$(read_cov 60m)"
COV_CLN_30="$(read_cov m30)"; COV_CLN_60="$(read_cov m60)"
if [ "${#ALERTS[@]}" -gt 0 ]; then STATUS_V="fail"; else STATUS_V="ok"; fi

ALERTF="$LOGDIR/.routine_alerts.tmp"
: > "$ALERTF"
for a in "${ALERTS[@]:-}"; do [ -n "$a" ] && echo "$a" >> "$ALERTF"; done

python3 - "$STATUS" "$STATUS_V" "$START_AT" "$ELAPSED" "$START_DATE" "$END_DATE" "$NEW_30" "$NEW_60" \
        "${STEP_RC[backfill]:-na}" "${STEP_RC[rebuild]:-na}" "${STEP_RC[verify]:-na}" \
        "$VERIFY_LINE" "$COV_SRC_30" "$COV_SRC_60" "$COV_CLN_30" "$COV_CLN_60" "$ALERTF" <<'PY'
import json, sys
p, st, start, el, ws, we, n30, n60, bf, rb, vf, vline, cs30, cs60, cc30, cc60, alertf = sys.argv[1:18]
def cov(s):
    n, d = s.split(" ", 1)
    return {"rows": int(n), "max_date": d}
alerts = [l.strip() for l in open(alertf, encoding="utf-8") if l.strip()]
json.dump({
    "status": st,
    "started_at": start,
    "elapsed_s": int(el),
    "window": [ws, we],
    "backfill": {"rc": bf, "new_rows_30m": int(n30), "new_rows_60m": int(n60),
                 "src_30m": cov(cs30), "src_60m": cov(cs60)},
    "rebuild": {"rc": rb, "built": rb.split() if rb not in ("fail", "na", "skip") else []},
    "verify": {"rc": vf, "result": vline},
    "clean": {"m30": cov(cc30), "m60": cov(cc60)},
    "alerts": alerts,
}, open(p, "w"), ensure_ascii=False, indent=2)
print("STATUS_JSON: %s  status=%s" % (p, st))
PY

if [ "$STATUS_V" = "ok" ]; then
  log "④ 状态: ok  用时 ${ELAPSED}s  → $STATUS"
  rm -f "$ALERT"
  echo "=== ROUTINE_BUILD_DONE $(date '+%F %T') status=ok elapsed=${ELAPSED}s ==="
  exit 0
else
  {
    echo "=== 分时数据例行失败 $(date '+%F %T') ==="
    echo "用时 ${ELAPSED}s"
    for a in "${ALERTS[@]}"; do echo "  - $a"; done
    echo "状态文件: $STATUS"
    echo "日志: $LOG"
  } > "$ALERT"
  log "④ 状态: FAIL"
  echo
  echo "########## [ALERT] 分时数据例行失败 ##########"
  cat "$ALERT"
  echo "############################################"
  echo "=== ROUTINE_BUILD_DONE $(date '+%F %T') status=fail elapsed=${ELAPSED}s ==="
  exit 1
fi
