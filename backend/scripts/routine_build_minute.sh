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
#  - 无新数据则跳过重建：判据有两条 ——
#      (1) 源末端日期 > 产物末端日期
#      (2) 源状态指纹(末端日期+该日行数) != 产物 meta 里记录的「已消费源状态」
#    (2) 覆盖「同一天从半成品补全」（日期没变但行数变多，只比日期会漏）
#  - 幂等：回补用 INSERT OR REPLACE；重建是「先建临时库再替换」，重复跑结果一致
#  - 只读源库、产物库有 .bak 备份由 build 脚本自身负责
#  - 源端不可达自愈：backfill 内部已设 socket 超时(30s) + 熔断（全失败 exit 2），
#    本例行再叠一层 timeout 硬上限 → 「源端挂了」表现为一次快速失败告警，
#    而不是进程无限挂起把单例锁永久持有（那样次日例行会静默跳过，没有任何告警）
#
# 环境变量:
#   LOOKBACK_DAYS=5   回补回溯天数（覆盖漏跑一天 + 假期）
#   SKIP_BACKFILL=1   跳过第①步（仅重建+自证）
#   SKIP_VERIFY=1     跳过第③步
#   FORCE_REBUILD=1   即使无新数据也重建
#   BF_TIMEOUT=900    ① 回补的单次硬超时（秒），超时即杀进程并告警
#   BS_PROXY=127.0.0.1:17891   baostock 出口（专用境外 mihomo 隔离实例）；置空=直连（会被厂商按 IP 拉黑）
#   BF_WORKERS=4      回补并发（降并发以保护共享出口 IP，勿随意调高）
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
# ① 回补的硬超时（秒）。baostock 源端不可达时脚本内部已设 socket 超时 + 熔断，
# 这里再加一层进程级兜底：超时即 timeout 杀进程，保证单例锁一定会被释放。
BF_TIMEOUT="${BF_TIMEOUT:-900}"

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

# ---------- ⓪ 数据源出口预检 ----------
# baostock 厂商按 **IP** 拉黑（2026-09-12 定性：同一匿名账号 直连→10001011 / 经境外出口→login success）。
# 故回补必须经「专用境外出口」（mihomo 隔离实例 socks 17891，生成器 /usr/local/bin/baostock-egress-gen.py）。
# 出口不可用时降级直连（大概率仍被拉黑），但把状态写进日志与告警，便于定位。
BS_PROXY="${BS_PROXY:-127.0.0.1:17891}"   # baostock 出口（空=直连）
BF_WORKERS="${BF_WORKERS:-4}"             # 降并发：保护共享出口 IP 不再被打进黑名单
PROXY_ARG=()
proxy_alive() {
  python3 - "$1" <<'PY'
import socket, sys
h, _, p = sys.argv[1].partition(":")
try:
    socket.create_connection((h, int(p)), timeout=2).close()
except Exception:
    sys.exit(1)
PY
}
PROXY_STATE="ok"
if proxy_alive "$BS_PROXY"; then
  log "⓪ 境外出口 $BS_PROXY 可用"
else
  log "⓪ 境外出口 $BS_PROXY 未监听 → 拉起 mihomo-baostock.service"
  systemctl start mihomo-baostock.service 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 1.5; proxy_alive "$BS_PROXY" && break; done
  if proxy_alive "$BS_PROXY"; then
    log "⓪ 境外出口已恢复"
  else
    PROXY_STATE="unavailable"; BS_PROXY=""
    log "⓪ [WARN] 境外出口不可用 → 本次降级直连（baostock 大概率返回黑名单 10001011）"
  fi
fi
if [ -n "$BS_PROXY" ]; then PROXY_ARG=(--proxy "$BS_PROXY"); fi

# 源库/产物库的日期覆盖（date-only）
# 输出（空格分隔）:
#   源库  : <总行数> <末端日期> <末端日期行数>
#   产物库: <总行数> <产物末端日期> <产物记录的「已消费源状态」>
read_cov() {
  python3 - "$1" <<'PY'
import sqlite3, sys
what = sys.argv[1]
D = "/root/sclaw/backend/data"
if what == "30m" or what == "60m":
    c = sqlite3.connect("file:%s/stock_history.db?mode=ro" % D, uri=True)
    n, mx = c.execute("SELECT COUNT(*), MAX(substr(datetime,1,10)) FROM stock_kline_%s" % what).fetchone()
    nmx = c.execute("SELECT COUNT(*) FROM stock_kline_%s WHERE substr(datetime,1,10)=?" % what,
                    (mx,)).fetchone()[0] if mx else 0
    print("%s %s %s" % (n, mx or "-", nmx))
else:
    t = "m30" if what == "m30" else "m60"
    c = sqlite3.connect("file:%s/clean_%s.db?mode=ro" % (D, what), uri=True)
    n = c.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
    meta = dict(c.execute("SELECT key,value FROM meta").fetchall())
    rng = meta.get("date_range", "") or ""
    print("%s %s %s" % (n, rng.split("~")[-1].strip() or "-", meta.get("src_state", "") or "-"))
PY
}

echo "=================================================================="
log "分时数据例行开始  window=$START_DATE..$END_DATE lookback=${LOOKBACK_DAYS}d"

# 覆盖快照：read_cov 每次都要起一个 python 进程，并对千万行的源表做全表扫描（单次 5~8s），
# 而本脚本原先在 20 处重复调用（同一张表要读 5 遍，白烧约 1 分钟）。
# 改为「按需取一次快照、其余复用变量」：全程 8 次（4 前置 + 2 回补后 + 2 重建后）。
COV_SRC30_BEFORE="$(read_cov 30m)"
COV_SRC60_BEFORE="$(read_cov 60m)"
COV_M30_BEFORE="$(read_cov m30)"
COV_M60_BEFORE="$(read_cov m60)"
log "例行前覆盖: 源30m[$COV_SRC30_BEFORE]  源60m[$COV_SRC60_BEFORE]  clean_m30[$COV_M30_BEFORE]  clean_m60[$COV_M60_BEFORE]"

# ---------- ① 增量回补 ----------
BF_ROWS_BEFORE_30=$(echo "$COV_SRC30_BEFORE" | cut -d' ' -f1)
BF_ROWS_BEFORE_60=$(echo "$COV_SRC60_BEFORE" | cut -d' ' -f1)
if [ "$SKIP_BACKFILL" = "1" ]; then
  log "① 回补: 跳过 (SKIP_BACKFILL=1)"
  STEP_RC[backfill]="skip"
else
  bf_rc=0
  for P in 30 60; do
    log "① 回补 period=$P start=$START_DATE end=$END_DATE workers=$BF_WORKERS 出口=${BS_PROXY:-直连} ... (硬超时 ${BF_TIMEOUT}s)"
    timeout -k 15 "$BF_TIMEOUT" python3 scripts/backfill_m30.py --start "$START_DATE" --end "$END_DATE" --period "$P" --workers "$BF_WORKERS" "${PROXY_ARG[@]}"
    rc=$?
    if [ $rc -eq 0 ]; then
      log "① 回补 period=$P OK"
    elif [ $rc -eq 124 ]; then
      # timeout 只杀直接子进程；进程池 worker 可能残留 → 补一刀清干净，避免孤儿长期占着源连接
      pkill -9 -f "backfill_m30\.py" 2>/dev/null || true
      bf_rc=1; ALERTS+=("回补 period=$P 超时(>${BF_TIMEOUT}s)被终止：源端不可达？")
      log "① 回补 period=$P 超时被终止 rc=124（已清理残留 worker）"
    else
      # rc=2 = 源端整体不可用（网络不可达 / 登录被拒如 baostock 黑名单 10001011）
      # 把 backfill 打印的原因带进告警，避免只看到「失败」无从下手
      LASTERR=$(grep -aE "登录被拒|熔断|以非零码退出" "$LOG" 2>/dev/null | tail -1 | cut -c1-200)
      [ -n "$LASTERR" ] || LASTERR="（见日志尾部）"
      LASTERR="$LASTERR [出口=${BS_PROXY:-直连}/$PROXY_STATE]"
      bf_rc=1; ALERTS+=("回补 period=$P 失败(rc=$rc): $LASTERR")
      log "① 回补 period=$P 失败 rc=$rc  $LASTERR"
    fi
  done
  if [ $bf_rc -eq 0 ]; then STEP_RC[backfill]="ok"; else STEP_RC[backfill]="fail"; fi
fi
# 回补后对源表取一次新快照：后续「重建判定」与「状态落盘」都以这份为准
COV_SRC30_AFTER="$(read_cov 30m)"
COV_SRC60_AFTER="$(read_cov 60m)"
BF_ROWS_AFTER_30=$(echo "$COV_SRC30_AFTER" | cut -d' ' -f1)
BF_ROWS_AFTER_60=$(echo "$COV_SRC60_AFTER" | cut -d' ' -f1)
NEW_30=$((BF_ROWS_AFTER_30 - BF_ROWS_BEFORE_30))
NEW_60=$((BF_ROWS_AFTER_60 - BF_ROWS_BEFORE_60))
log "① 回补新增: 30m +$NEW_30  60m +$NEW_60"

# ---------- ② 重建 clean（无新数据则跳过） ----------
SRC_MAX_30=$(echo "$COV_SRC30_AFTER" | cut -d' ' -f2)
SRC_MAX_60=$(echo "$COV_SRC60_AFTER" | cut -d' ' -f2)
CLN_MAX_30=$(echo "$COV_M30_BEFORE" | cut -d' ' -f2)
CLN_MAX_60=$(echo "$COV_M60_BEFORE" | cut -d' ' -f2)
# 源状态指纹 = 「末端日期|末端日期行数」；产物端存的是上次构建时消费掉的源状态
SRC_STATE_30=$(echo "$COV_SRC30_AFTER" | cut -d' ' -f2,3 | tr ' ' '|')
SRC_STATE_60=$(echo "$COV_SRC60_AFTER" | cut -d' ' -f2,3 | tr ' ' '|')
CONSUMED_30=$(echo "$COV_M30_BEFORE" | cut -d' ' -f3)
CONSUMED_60=$(echo "$COV_M60_BEFORE" | cut -d' ' -f3)

need_p30=0; need_p60=0
if [ "$FORCE_REBUILD" = "1" ]; then
  need_p30=1; need_p60=1
else
  # 判据1: 源末端日期比产物新 → 必建
  # 判据2: 源状态指纹 != 产物记录的「已消费源状态」→ 必建
  #        （这条覆盖「同一天从半成品补全」：日期没变但行数变多，只比日期会漏）
  if [ "$SRC_MAX_30" \> "$CLN_MAX_30" ] || [ "$SRC_STATE_30" != "$CONSUMED_30" ]; then need_p30=1; fi
  if [ "$SRC_MAX_60" \> "$CLN_MAX_60" ] || [ "$SRC_STATE_60" != "$CONSUMED_60" ]; then need_p60=1; fi
fi
log "② 重建判定: 源30m末端=$SRC_MAX_30 产物末端=$CLN_MAX_30 (源状态=$SRC_STATE_30 vs 已消费=$CONSUMED_30) → $([ $need_p30 = 1 ] && echo 重建 || echo 跳过); 源60m末端=$SRC_MAX_60 产物末端=$CLN_MAX_60 (源状态=$SRC_STATE_60 vs 已消费=$CONSUMED_60) → $([ $need_p60 = 1 ] && echo 重建 || echo 跳过)"

rb_rc=0
BUILT=()
for P in 30 60; do
  if [ "$P" = "30" ]; then need=$need_p30; else need=$need_p60; fi
  if [ "$need" = "0" ]; then
    log "② 重建 clean_m$P: 跳过（源状态未变，产物已是最新）"
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
# 源用「回补后」的快照即可（回补后源不会再变）；clean 可能刚刚被重建过 → 必须重读（2 次）
COV_SRC_30="$COV_SRC30_AFTER"; COV_SRC_60="$COV_SRC60_AFTER"
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
    # "<rows> <max_date> [<extra>]"  extra: 源=末端日期行数 / 产物=已消费源状态("日期|行数")
    parts = s.split(" ")
    out = {"rows": int(parts[0]), "max_date": parts[1]}
    if len(parts) > 2:
        out["extra"] = parts[2]
    return out
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
