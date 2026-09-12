#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_daily_clean.py — 用 baostock 建「干净日线库」，用于可信的回测/验证

背景（2026-09-11 数据取证）:
  stock_history.db 是多源拼接的补丁库, 存在硬伤:
    - close 为不复权原始价 (415 次 |日收益| > 21%, 不可能)
    - volume 单位按股票而异 (000001 是"手", 688825 同量级却放大 100 倍不合理)
    - amount 全 0, stock_daily.turnover_rate 全 0, index_daily 0 行
  => 无法支撑"已验证 alpha"的结论, 必须换干净源。

本脚本产出:
  /root/sclaw/backend/data/clean_daily.db  ->  table daily
  字段: date,code,open,high,low,close,preclose,volume,amount,turn,pctChg,tradestatus,isST
  - adjustflag=2 前复权 (同一快照内自洽; 与项目既有口径一致)
  - turn(换手率)/pctChg 为原始口径, 不受复权影响
  - volume/amount 单位一致 (股/元), 可放心做成交额与量比

关键决策:
  - ProcessPoolExecutor (baostock 非线程安全, 线程池会污染 get_row_data)
  - 每进程 initializer 登录一次, 非每股登录
  - INSERT OR REPLACE 幂等, 可断点续跑
  - 退市/无数据股 -> empty 跳过, 不算错误

用法:
  python3 fetch_daily_clean.py [--start 2022-01-01] [--workers 8] [--limit N] [--proxy host:port]

出口（2026-09-12 追加，重要）:
  baostock 按 **IP** 拉黑，不是按账号 —— 直连(本机 CN 出口)必然 10001011「黑名单用户」，
  经境外出口 → login success。故本脚本默认取 env BS_PROXY（建议 127.0.0.1:17891，
  专用境外 mihomo 隔离实例，见 /etc/mihomo-baostock/），并在开跑前做一次登录预检：
  预检失败直接 exit 2，不再让 8 个 worker 各失败一遍后才看到没信息量的汇总。
  实现见 scripts/bs_proxy.py（与 backfill_m30.py 共用同一份 socket 补丁）。
"""
import argparse
import os
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

try:
    from bs_proxy import install_socks_proxy, proxy_from_env
except ImportError:                          # 兜底：被以绝对路径 / 非 scripts 作为 cwd 调用时
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from bs_proxy import install_socks_proxy, proxy_from_env

SRC_DB = "/root/sclaw/backend/data/stock_history.db"
OUT_DB = "/root/sclaw/backend/data/clean_daily.db"

FIELDS = "date,code,open,high,low,close,preclose,volume,amount,turn,pctChg,tradestatus,isST"

DDL = """
CREATE TABLE IF NOT EXISTS daily (
  code TEXT NOT NULL, date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, preclose REAL,
  volume REAL, amount REAL, turn REAL, pctChg REAL,
  tradestatus INTEGER, isST INTEGER,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date);
"""

_bst = {"bs": None, "conn": None, "login_ok": False, "login_msg": ""}


def _init(proxy=""):
    if proxy:
        install_socks_proxy(proxy)       # 补丁是进程级的：每个子进程各打一次
    import baostock as bs
    lg = bs.login()
    _bst["bs"] = bs
    _bst["login_ok"] = lg.error_code == "0"
    if not _bst["login_ok"]:
        _bst["login_msg"] = "%s:%s" % (lg.error_code, getattr(lg, "error_msg", ""))
    conn = sqlite3.connect(OUT_DB, timeout=60)
    conn.executescript(DDL)
    conn.commit()
    _bst["conn"] = conn


def preflight(proxy):
    """主进程先登一次：出口被拉黑 2 秒内暴露，不必等 8 个 worker 全部失败。

    实测 2026-09-12：厂商按 **IP** 拉黑。直连(本机 CN 出口)必然 10001011，
    经境外出口 → login success。故这里失败直接给出可执行的提示。
    """
    if proxy:
        install_socks_proxy(proxy)
    import baostock as bs
    lg = bs.login()
    if lg.error_code == "0":
        bs.logout()
        return True, "ok"
    return False, "%s:%s" % (lg.error_code, getattr(lg, "error_msg", ""))


def _to_sym(code):
    if code.startswith(("6", "9")):
        return "sh." + code
    if code.startswith(("4", "8")):
        return "bj." + code
    return "sz." + code


def worker(code, start, end):
    bs = _bst["bs"]
    conn = _bst["conn"]
    if not _bst.get("login_ok"):
        # 登录失败就不是「这只票没数据」，而是整条链路不可用 —— 立刻带原因返回
        return code, 0, "login_fail:" + (_bst.get("login_msg") or "unknown")
    try:
        sym = _to_sym(code)
        rs = bs.query_history_k_data_plus(
            sym, FIELDS, start_date=start, end_date=end, frequency="d", adjustflag="2"
        )
        if rs.error_code != "0":
            return code, 0, "query_err"
        rows = []
        while rs.error_code == "0" and rs.next():
            r = rs.get_row_data()
            if len(r) < 13 or not r[1]:
                continue
            def f(x):
                try:
                    return float(x) if x not in ("", None) else None
                except ValueError:
                    return None
            rows.append((code, r[0], f(r[2]), f(r[3]), f(r[4]), f(r[5]), f(r[6]),
                         f(r[7]), f(r[8]), f(r[9]), f(r[10]),
                         int(r[11]) if r[11] not in ("", None) else None,
                         int(r[12]) if r[12] not in ("", None) else None))
        if not rows:
            return code, 0, "empty"
        conn.executemany(
            """INSERT OR REPLACE INTO daily
               (code,date,open,high,low,close,preclose,volume,amount,turn,pctChg,tradestatus,isST)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
        conn.commit()
        return code, len(rows), "ok"
    except Exception as e:
        return code, 0, "error:%s" % e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2022-01-01")
    ap.add_argument("--end", default="")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--proxy", default="",
                    help="SOCKS5 出口 host:port（默认取 env BS_PROXY）。厂商按 IP 拉黑，"
                         "直连必然 10001011，走专用境外出口 127.0.0.1:17891 才通")
    a = ap.parse_args()
    end = a.end or time.strftime("%Y-%m-%d")
    proxy = (a.proxy or proxy_from_env()).strip()

    # 登录预检：先花 1~2 秒在主进程确认出口可用，避免 8 个 worker 各失败一次后
    # 只看到「err=5000」这种没有信息量的汇总。
    ok, msg = preflight(proxy)
    if not ok:
        print("[fetch_daily] 登录预检失败: %s" % msg, flush=True)
        print("  ⇒ 厂商按 **IP** 拉黑（非账号问题）。本机直连必然返回 10001011。", flush=True)
        print("    处置: BS_PROXY=127.0.0.1:17891 python3 scripts/fetch_daily_clean.py ...", flush=True)
        print("          或加 --proxy 127.0.0.1:17891（专用境外 mihomo 隔离实例）", flush=True)
        sys.exit(2)

    # 股票池 = stock_info ∪ stock_daily (后者含退市, 减幸存者偏差)
    conn = sqlite3.connect("file:%s?mode=ro" % SRC_DB, uri=True)
    codes = set()
    for (t,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        if t == "stock_info":
            codes |= {r[0] for r in conn.execute("SELECT code FROM stock_info")}
    try:
        codes |= {r[0] for r in conn.execute("SELECT DISTINCT code FROM stock_daily")}
    except Exception:
        pass
    conn.close()
    codes = sorted(c for c in codes if c and len(c) == 6 and c.isdigit()
                   and c[0] in "0368")
    if a.limit:
        codes = codes[: a.limit]

    print("[fetch_daily] start=%s end=%s workers=%d 股票池=%d 出口=%s"
          % (a.start, end, a.workers, len(codes), proxy or "直连(会被拉黑)"), flush=True)
    t0 = time.time()
    st = {"ok": 0, "empty": 0, "query_err": 0}
    errs, total, done = [], 0, 0
    with ProcessPoolExecutor(max_workers=a.workers, initializer=_init,
                             initargs=(proxy,)) as ex:
        futs = {ex.submit(worker, c, a.start, end): c for c in codes}
        for fut in as_completed(futs):
            code, n, status = fut.result()
            done += 1
            total += n
            if status in st:
                st[status] += 1
            else:
                errs.append("%s:%s" % (code, status))
            if done % 100 == 0 or done == len(codes):
                el = time.time() - t0
                print("[%d/%d] +%d行 ok=%d empty=%d err=%d %.0fs %.1f/s"
                      % (done, len(codes), total, st["ok"], st["empty"], len(errs), el, done / max(el, 1)),
                      flush=True)
    print("[fetch_daily] DONE rows=%d ok=%d empty=%d query_err=%d err=%d elapsed=%.0fs"
          % (total, st["ok"], st["empty"], st["query_err"], len(errs), time.time() - t0), flush=True)
    if errs:
        print("  err sample:", errs[:10], flush=True)
        if st["ok"] == 0:
            print("  ⚠ 无一成功 ⇒ 先怀疑出口（不是个股问题）：查登录预检输出 / BS_PROXY 是否生效。",
                  flush=True)


if __name__ == "__main__":
    main()
