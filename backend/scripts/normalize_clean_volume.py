#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
normalize_clean_volume.py — 把 clean 层的成交量口径统一为「手」

背景（2026-09-12 实证，见守卫输出）:
  clean_daily.volume  : 沪深主板/创业/中小 = 手, **科创板 688/689 = 股**（差 100 倍）
  clean_m30.volume    : 全表 = 股（baostock 30m 原生：股）
  clean_m60.volume    : 全表 = 手（backfill_m30.py 写库时 /100）

  系统声明口径是「手」:
    - src/tools/stock.ts 工具契约: "volume(成交量手)"
    - backfill_m30.py 注释: stock_kline_60m volume 单位=手(=股/100)
    - 跨级别消费方 (src/chan/service.ts, src/data/data-fetcher.ts) 同时读 m30 与 m60,
      两者差 100 倍 ⇒ 多级别量能比较必然错。

本脚本做什么（一次性迁移，幂等）:
  1. clean_daily.db :: daily  —— 只把 688/689（科创板）volume ÷100（这些行量纲是股）
  2. clean_m30.db   :: m30    —— 全表 volume ÷100（量纲是股 → 手）
  3. clean_m60.db   :: m60    —— 不动（本来就是手）
  归一化后的强不变量: sum(clean_m30 当日 volume) == clean_daily.volume（同日同票，全板块成立）

安全:
  - 默认 dry-run（只读体检）；--apply 才写入，写前自动备份两份 DB（.bak<ts>）。
  - 双跑守卫: 若检测到「科创板已是手」→ 判定已归一化，拒绝执行；state 异常也拒绝。
  - 归一化后在两库 meta 写 volume_unit=手 / volume_unit_hand_at=<ts>（再跑直接拒绝，除非 --force）。
  - 审计 → scripts/logs/normalize_clean_volume_<ts>.json（前后抽样 + 影响行数 + 备份路径）。

配套源码修复（否则例行重建会再次写坏）:
  - scripts/build_m30_clean.py    : 写 m30 时 volume/100（m60 源已是手，不再除）
  - scripts/fetch_daily_clean.py  : baostock 日线中 688/689 的 volume ÷100
  - scripts/fetch_daily_tencent.py: 同上（腾讯源科创板也是股）

用法:
  python3 normalize_clean_volume.py            # 体检（只读）
  python3 normalize_clean_volume.py --apply    # 执行迁移
"""
import argparse
import json
import os
import shutil
import sqlite3
import time

DATA = "/root/sclaw/backend/data"
DAILY_DB = os.path.join(DATA, "clean_daily.db")
M30_DB = os.path.join(DATA, "clean_m30.db")
M60_DB = os.path.join(DATA, "clean_m60.db")
LOGDIR = "/root/sclaw/backend/scripts/logs"

TOL = 0.02          # 比值容差（±2%）
DDL_META = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"
SAMPLE_CODES = ("600519", "000001", "300750", "002594", "688981", "689009")


def med(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def open_all(readonly=True):
    """打开 clean_daily 为主库，并把 clean_m30/clean_m60 以 mm / nn 附加上去。"""
    ro = "?mode=ro" if readonly else ""
    d = sqlite3.connect("file:%s%s" % (DAILY_DB, ro), uri=True, timeout=120)
    d.execute("ATTACH DATABASE 'file:%s%s' AS mm" % (M30_DB, ro))
    d.execute("ATTACH DATABASE 'file:%s%s' AS nn" % (M60_DB, ro))
    return d


def probe(d, date):
    """返回 (可比只数, 科创板比值中位, 非科创板比值中位, 抽样明细)"""
    rows = d.execute(
        """SELECT d.code, d.volume, a.v, b.v
             FROM main.daily d
             LEFT JOIN (SELECT code, SUM(volume) v FROM mm.m30 WHERE substr(datetime,1,10)=? GROUP BY code) a ON a.code=d.code
             LEFT JOIN (SELECT code, SUM(volume) v FROM nn.m60 WHERE substr(datetime,1,10)=? GROUP BY code) b ON b.code=d.code
            WHERE d.date=? AND d.volume>0 AND a.v>0""",
        (date, date, date)).fetchall()
    star, other = [], []
    for code, dv, mv, _ev in rows:
        (star if code.startswith(("688", "689")) else other).append(dv / mv)
    det = []
    for c in SAMPLE_CODES:
        r = d.execute(
            """SELECT d.volume, a.v, b.v FROM main.daily d
                 LEFT JOIN (SELECT SUM(volume) v FROM mm.m30 WHERE code=? AND substr(datetime,1,10)=?) a
                 LEFT JOIN (SELECT SUM(volume) v FROM nn.m60 WHERE code=? AND substr(datetime,1,10)=?) b
                WHERE d.code=? AND d.date=?""", (c, date, c, date, c, date)).fetchone()
        if r and r[0] and r[1]:
            det.append({"code": c, "daily": round(r[0], 2), "m30_sum": round(r[1], 2),
                        "m60_sum": round(r[2] or 0, 2),
                        "daily/m30": round(r[0] / r[1], 4),
                        "m60/m30": round((r[2] or 0) / r[1], 4)})
    return len(rows), med(star), med(other), det


def out_of(v, lo, hi):
    return v is None or not (lo <= v <= hi)


def chunk_update(d, table, where, chunk, label):
    """按 rowid 窗口分块 UPDATE volume/100（每块一次 commit）。

    为什么分块: 两个库是 journal_mode=delete（回滚日志），单条大事务会长时间持写锁，
    在线读方（SClaw/chan REST，better-sqlite3 默认 busy_timeout=5s）会 SQLITE_BUSY 失败。
    分块后每块只锁几百毫秒，且日志文件不会膨胀到 GB 级。
    """
    total = 0
    last = -1
    t0 = time.time()
    while True:
        ids = [r[0] for r in d.execute(
            "SELECT rowid FROM %s WHERE rowid > ? AND (%s) ORDER BY rowid LIMIT %d" % (table, where, chunk),
            (last,)).fetchall()]
        if not ids:
            break
        ph = ",".join("?" * len(ids))
        d.execute("UPDATE %s SET volume = volume/100.0 WHERE rowid IN (%s)" % (table, ph), ids)
        d.commit()
        total += len(ids)
        last = ids[-1]
        if total % (chunk * 10) < chunk:
            print("      %s: %d 行  %.0fs" % (label, total, time.time() - t0))
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--chunk", type=int, default=30000, help="分块更新每块行数（默认 30000，短锁）")
    a = ap.parse_args()

    d = open_all(readonly=not a.apply)

    date = d.execute("SELECT MAX(substr(datetime,1,10)) FROM mm.m30").fetchone()[0]
    date = min(date, d.execute("SELECT MAX(date) FROM main.daily").fetchone()[0])
    print("[i] 体检日 = %s" % date)

    n, r_star, r_other, det = probe(d, date)
    print("[i] 可比只数=%d   科创板 daily/m30 中位=%s   非科创板 daily/m30 中位=%s" % (n, r_star, r_other))
    for x in det:
        print("      %s daily=%-12.1f m30=%-12.1f m60=%-12.1f daily/m30=%.4f m60/m30=%.4f"
              % (x["code"], x["daily"], x["m30_sum"], x["m60_sum"], x["daily/m30"], x["m60/m30"]))

    # --- 状态 / 双跑守卫 ---
    if r_other is not None and r_other > 0.5:
        print("[x] 守卫失败: 非科创板 daily/m30=%.4f（应 ~0.01）→ 疑似已归一化或状态异常，拒绝执行。" % r_other)
        return 2
    if r_star is not None and r_star < 0.5:
        print("[x] 守卫失败: 科创板 daily/m30=%.4f（应 ~1.0）→ 疑似已归一化，拒绝执行。" % r_star)
        return 2
    if not (r_star is not None and 0.9 <= r_star <= 1.1):
        print("[x] 守卫失败: 科创板比值 %s 不在 [0.9,1.1]，状态不符预期，拒绝执行。" % r_star)
        return 2
    if not (r_other is not None and abs(r_other - 0.01) <= 0.001):
        print("[x] 守卫失败: 非科创板比值 %s 偏离 0.01，拒绝执行。" % r_other)
        return 2
    print("[✓] 前置守卫通过: 科创板=股 / 非科创板=手 / m30=股 / m60=手（与预期一致）")

    if not a.apply:
        print("[dry] 未写入。执行请加 --apply")
        return 0

    # --- 幂等标记 ---
    for db, tag in ((DAILY_DB, "clean_daily"), (M30_DB, "clean_m30")):
        c = sqlite3.connect(db)
        c.executescript(DDL_META)
        mark = c.execute("SELECT value FROM meta WHERE key='volume_unit_hand_at'").fetchone()
        c.close()
        if mark and not a.force:
            print("[x] %s 已带归一化标记 (volume_unit_hand_at=%s)，拒绝重复执行（--force 可强跑）。" % (tag, mark[0]))
            return 2

    ts = time.strftime("%Y%m%d_%H%M%S")
    baks = []
    for p in (DAILY_DB, M30_DB):
        b = "%s.bak%s" % (p, ts)
        print("[i] 备份 %s → %s" % (os.path.basename(p), os.path.basename(b)))
        shutil.copy2(p, b)
        baks.append(b)

    cur = chunk_update(d, "main.daily", "code LIKE '688%' OR code LIKE '689%'", a.chunk, "clean_daily(688/689)")
    n_daily = cur
    d.execute(DDL_META)
    d.execute("INSERT OR REPLACE INTO main.meta(key,value) VALUES('volume_unit','手')")
    d.execute("INSERT OR REPLACE INTO main.meta(key,value) VALUES('volume_unit_hand_at',?)", (ts,))
    d.execute("INSERT OR REPLACE INTO main.meta(key,value) VALUES('volume_unit_note',"
              "'科创板 688/689 原为股, 已÷100 统一为手')")
    d.commit()
    print("[✓] clean_daily.db 更新 %d 行（688/689 ÷100）" % n_daily)

    n_m30 = chunk_update(d, "mm.m30", "1=1", a.chunk, "clean_m30(全表)")
    d.execute("INSERT OR REPLACE INTO mm.meta(key,value) VALUES('volume_unit','手')")
    d.execute("INSERT OR REPLACE INTO mm.meta(key,value) VALUES('volume_unit_hand_at',?)", (ts,))
    d.execute("INSERT OR REPLACE INTO mm.meta(key,value) VALUES('volume_unit_note',"
              "'源 30m 为股, 全表÷100 统一为手')")
    d.commit()
    print("[✓] clean_m30.db 更新 %d 行（全表 ÷100）" % n_m30)

    # --- 后置自证 ---
    n2, s2, o2, det2 = probe(d, date)
    print("[i] 迁移后: 科创板中位=%s  非科创板中位=%s" % (s2, o2))
    ok = True
    for lbl, v in (("科创板", s2), ("非科创板", o2)):
        if out_of(v, 1 - TOL, 1 + TOL):
            print("[x] 后置守卫失败: %s daily/m30=%s 应≈1.0" % (lbl, v))
            ok = False
    for x in det2:
        print("      %s daily=%-12.1f m30=%-12.1f m60=%-12.1f daily/m30=%.4f m60/m30=%.4f"
              % (x["code"], x["daily"], x["m30_sum"], x["m60_sum"], x["daily/m30"], x["m60/m30"]))
        if x["m30_sum"] and out_of(x["m60_sum"] / x["m30_sum"], 1 - TOL, 1 + TOL):
            print("[x] 后置守卫失败: %s m60/m30=%.4f 应≈1.0（同口径）" % (x["code"], x["m60_sum"] / x["m30_sum"]))
            ok = False

    os.makedirs(LOGDIR, exist_ok=True)
    audit = os.path.join(LOGDIR, "normalize_clean_volume_%s.json" % ts)
    with open(audit, "w") as f:
        json.dump({"ts": ts, "date": date,
                   "before": {"n": n, "star_median": r_star, "other_median": r_other, "detail": det},
                   "after": {"n": n2, "star_median": s2, "other_median": o2, "detail": det2},
                   "rows": {"clean_daily_688_689": n_daily, "clean_m30_all": n_m30},
                   "backups": baks, "ok": ok}, f, ensure_ascii=False, indent=2)
    print("[i] 审计 → %s" % audit)
    print("[结论] %s" % ("全部通过 ✅" if ok else "存在失败项 ❌"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
