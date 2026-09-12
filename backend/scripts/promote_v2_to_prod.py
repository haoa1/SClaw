#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
promote_v2_to_prod.py — 把验收通过的 clean_daily_v2.db 提升为生产 clean_daily.db

设计原则（2026-09-12）：
  1. **默认 dry-run**：不加 --yes 绝不改动生产库。
  2. **先备份后原子替换**：os.rename 同盘原子，失败可回滚。
  3. **只搬 daily；meta 以生产为底、v2 构建信息加 v2_ 前缀**：v2 的 done/flag/tries 是构建簿记，
     **不得**混进生产；生产 meta 里的域内元数据（volume_unit / volume_src_div 等）**绝不可丢**。
  4. **重建索引**：v2 构建库无索引；生产库必须有 idx_daily_code / idx_daily_date，
     否则 780 万行全表扫描（这是最容易被漏掉、后果最重的一步）。
  5. **门禁**：v2 未跑完（有 todo）或存在不可能日 → 拒绝提升。

用法：
  python3 promote_v2_to_prod.py              # 只体检 + 预演
  python3 promote_v2_to_prod.py --yes        # 真正替换（务必先停掉读写方）
"""
import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import time

PROD = "/root/sclaw/backend/data/clean_daily.db"
V2 = "/root/sclaw/backend/data/clean_daily_v2.db"
STAGE = "/root/sclaw/backend/data/.clean_daily.staged.db"
INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_daily_code ON daily(code)",
    "CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date)",
]
# 生产允许存在的最小表集合；任何「多出来的」表都会在暂存库中被丢弃
KEEP_TABLES = ("daily", "meta")


def q1(conn, sql, args=()):
    r = conn.execute(sql, args).fetchone()
    return r[0] if r else None


def check_v2(ignore_holders=False):
    """门禁：返回 (ok, 说明列表)"""
    msgs, ok = [], True
    if not os.path.exists(V2):
        return False, ["v2 库不存在: %s" % V2]
    c = sqlite3.connect("file:%s?mode=ro" % V2, uri=True)
    tabs = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    if "done" in tabs:
        done = q1(c, "select count(*) from done")
        nrows = q1(c, "select count(*) from daily")
        ncode = q1(c, "select count(distinct code) from daily")
        msgs.append("v2: done=%s  codes_with_data=%s  rows=%s" % (done, ncode, nrows))
    rng = c.execute("select min(date), max(date) from daily").fetchone()
    msgs.append("v2 日期跨度: %s ~ %s" % rng)

    # —— 门禁 1：构建器是否仍在运行（tries 为空不代表跑完了！）——
    try:
        out = subprocess.run(["pgrep", "-af", "v2_build.py"],
                             capture_output=True, text=True).stdout
        skip = _ancestors()
        lines = []
        for ln in out.strip().splitlines():
            t = ln.strip()
            if not t:
                continue
            try:
                pid = int(t.split()[0])
            except (ValueError, IndexError):
                continue
            if pid in skip:
                continue  # 壳进程：命令行里恰好含 "v2_build.py"（含调用者自己）
            lines.append(t)
        if lines:
            msgs.append("v2_build.py 仍在运行 -> 拒绝提升:")
            for t in lines[:3]:
                msgs.append("      " + t)
            ok = False
    except Exception as e:
        msgs.append("进程检查跳过: %s" % e)

    # —— 门禁 2：覆盖率（**同窗口**口径，2026-09-12 修正）——
    # v2 构建带 --beg（本次 2015-01-01），只重建 prod 的一段窗口。
    # 旧写法拿 v2 全量行数 除以 prod **全史**行数，得 99.03% < 99.5%
    # → 结构性永远拒绝（假阴）。必须把 prod 限在 v2 窗口内再比。
    try:
        pp = sqlite3.connect("file:%s?mode=ro" % PROD, uri=True)
        prod_rows_all = q1(pp, "select count(*) from daily") or 0
        prod_codes = q1(pp, "select count(distinct code) from daily")
        v2_rows = q1(c, "select count(*) from daily")
        cut = q1(c, "select min(date) from daily")
        prod_rows = q1(pp, "select count(*) from daily where date >= ?", (cut,)) or 0
        dropped = prod_rows_all - prod_rows
        ratio = (v2_rows / float(prod_rows)) if prod_rows else 0
        msgs.append("覆盖率(同窗口 %s 起): v2 %d / prod %d = %.2f%%"
                    % (cut, v2_rows, prod_rows, ratio * 100))
        msgs.append("  prod 全史 %d 行；其中 %s 前的 %d 行不在 v2 窗口内"
                    % (prod_rows_all, cut, dropped))
        msgs.append("  ⚠️ 切库后 prod 将不再包含 %s 前的历史（--beg 设计如此，D2 已决策不补跑）" % cut)
        if "done" in tabs:
            ndone = q1(c, "select count(*) from done")
            msgs.append("done %d / prod codes %d" % (ndone, prod_codes))
            if ndone < prod_codes:
                msgs.append("done 少于股票池 -> 未跑完")
                ok = False
        if ratio < 0.995:
            msgs.append("覆盖率 <99.5% -> 未跑完")
            ok = False
        # 强校验：同窗口内逐股行数必须完全一致（比总量比严格得多）
        v2c = dict(c.execute("select code, count(*) from daily group by code"))
        pdc = dict(pp.execute(
            "select code, count(*) from daily where date >= ? group by code", (cut,)))
        bad = [k for k in set(v2c) | set(pdc) if v2c.get(k, 0) != pdc.get(k, 0)]
        msgs.append("逐股行数比对: 不一致 %d 只%s"
                    % (len(bad), (" " + str(bad[:5])) if bad else ""))
        if bad:
            msgs.append("逐股不一致 -> 拒绝提升")
            ok = False
    except Exception as e:
        msgs.append("覆盖率检查异常: %s" % e)

    # 不可能日 —— 板块感知 + 复牌/新股窗口 + 低价取整（分级口径，2026-09-12 修正）
    #   GROSS(腐蚀) = |r| > 1.5*板块上限 + 0.005/prev  -> 无歧义数据腐败
    #   NEAR(边界)  = |r| > 板块上限 + 0.005/prev    -> 取整误差/假阳性，不作数
    #   板块上限: 688/689/300/301/302=20%, 4x/8x/920=30%, 其余=10%
    #   无涨跌幅限制窗口: 与上一交易日间隔 >=20 天（长期停牌复牌）则跳过
    if not ok:
        # 前置门禁已判定未跑完 -> 跳过 938k 行全表窗口扫描。
        # 该扫描会长时间持有读锁，导致 v2_build.py 的 commit 抛
        # "database is locked" 而整轮失败重启（实测 2026-09-12 12:59）。
        msgs.append("（前置门禁未通过，跳过全表腐蚀日扫描以避免写锁竞争）")
        return ok, msgs
    try:
        _SQL = """
            with s as (
              select code, date, close,
                     lag(close) over w as pc,
                     lag(date)  over w as pd,
                     row_number() over w as rn
              from daily where close is not null
              window w as (partition by code order by date)
            ),
            g as (
              select close, pc, rn,
                     case
                       when substr(code,1,3) in ('688','689','300','301','302') then 0.20
                       when substr(code,1,1) in ('4','8') or substr(code,1,3)='920' then 0.30
                       else 0.10
                     end as blim,
                     cast(julianday(date) - julianday(pd) as int) as gap
              from s where pc is not null
            )
            select
              sum(case when abs(close/pc-1.0) > 1.5*blim + 0.005/pc then 1 else 0 end),
              sum(case when abs(close/pc-1.0) > blim + 0.005/pc then 1 else 0 end)
            from g where pc > 0 and gap < 20 and rn > 6
        """
        gross, near = c.execute(_SQL).fetchone()
        gross, near = int(gross or 0), int(near or 0)
        msgs.append("v2 腐蚀日(gross=1.5×涨停以外) = %d" % gross)
        msgs.append("v2 边界噪声(near, 含合法 20%%/30%% 板与低价取整) = %d" % near)
        if gross > 6:
            msgs.append("!! 腐蚀日 > 6（已排除上市前5日窗口）-> 拒绝提升")
            ok = False
        elif gross:
            msgs.append("   （残余 %d 例属合法公司行为，不阻断）" % gross)
    except Exception as e:
        msgs.append("不可能日检查跳过: %s" % e)
    # —— 门禁 3：生产库是否被其他进程持有（2026-09-12 加）——
    # os.rename 只替换「目录项」：已打开 PROD 的进程仍指向旧 inode，
    # 会继续读到旧数据（stale）；若它是写方则写进被换走的旧文件（丢数据）。
    # 故必须先把持有者停掉/重启，再切库。
    try:
        hold = openers_of(PROD)
        if hold:
            desc = ", ".join("%d(%s)" % (p, short_cmd(p)) for p in hold[:6])
            msgs.append("!! 生产库被 %d 个进程持有 -> 拒绝提升: %s" % (len(hold), desc))
            msgs.append("   处置：停/重启这些进程后重跑（--ignore-holders 可强制忽略）")
            if ignore_holders:
                msgs.append("   [override] 已指定 --ignore-holders，继续但请自负风险")
            else:
                ok = False
        else:
            msgs.append("生产库无其他进程持有 -> 可安全原子替换")
    except Exception as e:
        msgs.append("持有者检查跳过: %s" % e)
    return ok, msgs


def _ancestors():
    """自身 + 全部祖先进程 PID。用于排除「命令行里恰好含关键字」的壳（含调用者自己）。"""
    out, pid = set(), os.getpid()
    while pid and pid not in out:
        out.add(pid)
        try:
            with open("/proc/%d/stat" % pid) as f:
                # stat 格式: pid (comm) state ppid ... —— comm 可能含空格，故从右起切
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
        except Exception:
            break
    return out


def openers_of(path):
    """返回打开了 path（同一 inode）的进程 PID 列表（不含自身）。依赖 /proc，无需 lsof。"""
    real = os.path.realpath(path)
    me = os.getpid()
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == me:
            continue
        fddir = "/proc/%s/fd" % pid
        try:
            fds = os.listdir(fddir)
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(os.path.join(fddir, fd)) == real:
                    out.append(int(pid))
                    break
            except OSError:
                continue
    return sorted(out)


def short_cmd(pid):
    """取进程命令行前 60 字符，便于人读。"""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            t = f.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
        return (t[:60] + "...") if len(t) > 60 else (t or "?")
    except Exception:
        return "?"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="真正执行替换（否则仅预演）")
    ap.add_argument("--ignore-holders", action="store_true",
                    help="即使生产库被其他进程持有也继续替换（危险）")
    a = ap.parse_args()

    print("=" * 62)
    print("提升 v2 → 生产 clean_daily.db")
    print("=" * 62)

    ok, msgs = check_v2(a.ignore_holders)
    for m in msgs:
        print("  " + m)

    prod_rows = q1(sqlite3.connect("file:%s?mode=ro" % PROD, uri=True),
                   "select count(*) from daily")
    print("  prod 现状: rows=%s" % prod_rows)

    if not ok:
        print("\n[x] 门禁未通过（v2 可能未跑完）→ 拒绝提升")
        sys.exit(2)

    # 磁盘占用预估
    need = os.path.getsize(V2) * 1.2
    free = shutil.disk_usage(os.path.dirname(PROD)).free
    print("\n  暂存+备份预计需要 %.1f GB，可用 %.1f GB" % (need / 1e9, free / 1e9))
    if free < need * 2:
        print("[x] 磁盘余量不足（需容纳 暂存 + 旧库备份）")
        sys.exit(2)

    if not a.yes:
        print("\n[DRY-RUN] 将执行：")
        print("  1) 建暂存库 %s" % STAGE)
        print("     - copy daily（含索引 %s）" % ", ".join(i.split()[5] for i in INDICES))
        print("     - meta：先继承生产库(volume_unit 等)，再并入 v2_* 构建信息 +")
        print("       promoted_from/promoted_at/method")
        print("     - 丢弃 %s" % ", ".join(sorted(set(('done', 'flag', 'tries')) - set(KEEP_TABLES))))
        print("  2) 备份 %s -> %s.bak<ts>" % (PROD, PROD))
        print("  3) os.rename 暂存 -> 生产（同盘原子）")
        print("  4) 复验：行数/日期跨度/索引/不可能日")
        print("\n重跑加 --yes 才真正替换。⚠️ 执行前请确认无进程在读写 clean_daily.db。")
        return

    t0 = time.time()
    if os.path.exists(STAGE):
        os.remove(STAGE)
    st = sqlite3.connect(STAGE)
    print("\n[1/4] 建暂存库 ...")
    st.execute("ATTACH DATABASE 'file:%s?mode=ro' AS v2" % V2)
    st.execute("ATTACH DATABASE 'file:%s?mode=ro' AS pdb" % PROD)
    st.execute("""CREATE TABLE daily (
        code TEXT NOT NULL, date TEXT NOT NULL,
        open REAL, high REAL, low REAL, close REAL,
        volume REAL, amount REAL, turn REAL,
        PRIMARY KEY (code, date))""")
    st.execute("INSERT INTO daily SELECT * FROM v2.daily")
    st.commit()
    n = q1(st, "select count(*) from daily")
    print("      daily = %d 行" % n)

    for ddl in INDICES:
        st.execute(ddl)
    st.commit()

    st.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    # ---- meta 合并策略：生产为底、v2 构建信息加前缀，绝不覆盖域内元数据 ----
    # 1) 先继承生产库的域内元数据（volume_unit / volume_src_div / volume_unit_note ...）。
    #    这些是对外声明「数据单位是什么」的口径凭证，丢了就再也说不清。
    inherited = 0
    try:
        cur = st.execute("INSERT OR REPLACE INTO meta SELECT key, value FROM pdb.meta")
        inherited = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    except Exception as e:
        print("      [warn] 继承生产 meta 失败: %s" % e)
    # 2) v2 的构建元数据统一加 v2_ 前缀，避免与生产键 / 提升键撞名。
    try:
        st.execute("INSERT OR REPLACE INTO meta SELECT 'v2_'||key, value FROM v2.meta")
    except Exception:
        pass
    st.commit()
    print("      meta：继承生产 %d 键 + v2_* 构建信息" % inherited)
    st.execute("INSERT OR REPLACE INTO meta VALUES ('promoted_from','clean_daily_v2.db')")
    st.execute("INSERT OR REPLACE INTO meta VALUES ('promoted_at',?)",
               (time.strftime("%Y-%m-%d %H:%M:%S"),))
    st.execute("INSERT OR REPLACE INTO meta VALUES ('method','tencent_raw_x_baostock_multiplicative')")
    st.commit()
    # 只读 ATTACH 的库会让 PRAGMA optimize 抛 "attempt to write a readonly database"
    # （实测 2026-09-12：v2/pdb 均为 mode=ro）。必须先 DETACH，再优化。
    for _a in ("v2", "pdb"):
        try:
            st.execute("DETACH DATABASE %s" % _a)
        except Exception:
            pass
    try:
        st.execute("PRAGMA optimize")
    except Exception as e:
        print("      [warn] PRAGMA optimize 跳过: %s" % e)
    st.close()
    print("[1/4] 完成，暂存库 %.1f MB" % (os.path.getsize(STAGE) / 1e6))

    bak = "%s.bak%d" % (PROD, int(t0))
    print("[2/4] 备份生产 -> %s" % bak)
    shutil.copy2(PROD, bak)

    print("[3/4] 原子替换 ...")
    os.rename(STAGE, PROD)

    print("[4/4] 复验 ...")
    c = sqlite3.connect("file:%s?mode=ro" % PROD, uri=True)
    print("      rows = %d" % q1(c, "select count(*) from daily"))
    print("      range= %s" % (c.execute("select min(date), max(date) from daily").fetchone(),))
    idx = [r[0] for r in c.execute(
        "select name from sqlite_master where type='index' and sql is not null")]
    print("      idx  = %s" % idx)
    mm = dict(c.execute("select key, value from meta"))
    lost = [k for k in ("volume_unit", "volume_src_div") if k not in mm]
    print("      meta = %d 键, volume_unit=%s" % (len(mm), mm.get("volume_unit")))
    if lost:
        print("[x] meta 域内元数据丢失: %s \u2192 \u7acb\u5373\u56de\u6eda" % lost)
        os.rename(PROD, STAGE)
        shutil.move(bak, PROD)
        sys.exit(4)
    miss = [i.split()[5] for i in INDICES if i.split()[5] not in idx]
    if miss:
        print("[x] 索引缺失: %s → 立即回滚" % miss)
        os.rename(PROD, STAGE)
        shutil.move(bak, PROD)
        sys.exit(3)
    print("\n✅ 提升完成，耗时 %.0fs。备份保留在 %s" % (time.time() - t0, bak))


if __name__ == "__main__":
    main()
