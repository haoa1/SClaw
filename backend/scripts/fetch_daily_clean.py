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
  python3 fetch_daily_clean.py [--start 2022-01-01] [--workers 8] [--limit N]
"""
import argparse
import os
import sqlite3
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

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

_bst = {"bs": None, "conn": None}


def _init():
    import baostock as bs
    bs.login()
    _bst["bs"] = bs
    conn = sqlite3.connect(OUT_DB, timeout=60)
    conn.executescript(DDL)
    conn.commit()
    _bst["conn"] = conn


def _to_sym(code):
    if code.startswith(("6", "9")):
        return "sh." + code
    if code.startswith(("4", "8")):
        return "bj." + code
    return "sz." + code


def worker(code, start, end):
    bs = _bst["bs"]
    conn = _bst["conn"]
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
    a = ap.parse_args()
    end = a.end or time.strftime("%Y-%m-%d")

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

    print("[fetch_daily] start=%s end=%s workers=%d 股票池=%d" % (a.start, end, a.workers, len(codes)), flush=True)
    t0 = time.time()
    st = {"ok": 0, "empty": 0, "query_err": 0}
    errs, total, done = [], 0, 0
    with ProcessPoolExecutor(max_workers=a.workers, initializer=_init) as ex:
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


if __name__ == "__main__":
    main()
