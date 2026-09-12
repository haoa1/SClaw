#!/bin/bash
# holder_audit.sh —— 切库前「谁还开着老库」审计（纯 /proc 扫描，不依赖 lsof）
# 用法: bash backend/scripts/holder_audit.sh
# 判读: clean_daily.db 的持有者只允许 [node dist/index.js]=SClaw 与 [v2_build.py]=构建器。
#       出现任何第三方 pid → 切库会被 promote 闸门拒绝，须先查清再切。
#
# 2026-09-12 13:2x 实测：仅 345871(node) + 389629(v2_build)；m30/m60 无持有者；无 unlinked。

DATA=${DATA:-/root/sclaw/backend/data}

for DB in clean_daily.db clean_daily_v2.db clean_m30.db clean_m60.db; do
  echo "==== $DB ===="
  PIDS=$(find /proc/[0-9]*/fd -lname "*$DB*" -printf '%h\n' 2>/dev/null \
         | sed 's,/proc/,,' | sed 's,/fd,,' | sort -u)
  [ -z "$PIDS" ] && echo "  (无持有者)"
  for p in $PIDS; do
    CMD=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-100)
    PP=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
    printf '  pid=%-8s ppid=%-8s %s\n' "$p" "$PP" "$CMD"
  done
done

echo
echo "==== inode 对照（切库前后比对：clean_daily.db 的 inode 必须变成 v2 的 inode）===="
stat -c '%i  %n' "$DATA/clean_daily.db" "$DATA/clean_daily_v2.db" 2>/dev/null

echo
echo "==== 已删除但仍被持有（unlinked，切库后最容易踩的暗雷）===="
HIT=$(find /proc/[0-9]*/fd -lname '*clean_daily*@*' -printf '%h %l\n' 2>/dev/null | head)
[ -z "$HIT" ] && echo "  (无)" || echo "$HIT"
