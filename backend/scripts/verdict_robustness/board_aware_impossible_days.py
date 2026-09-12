#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""(A) 分板块统计 clean_daily 中「不可能日收益」(涨跌停上限) 的行数;
(B) 抽查 baostock 的历史深度 (重建 clean_daily 是否可行)。
"""
import os
import sqlite3
import sys

DB = "/root/sclaw/backend/data/clean_daily.db"


def board(code):
    if code.startswith(("688", "689")):
        return "科创板", 0.20
    if code.startswith(("300", "301")):
        return "创业板", 0.20
    if code.startswith(("8", "4", "920")):
        return "北交所", 0.30
    return "主板", 0.10


con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
rows = con.execute("select code, date, close from daily order by code, date").fetchall()
prev_code, prev_close, prev_date = None, None, None
bad = {"主板": 0, "创业板": 0, "科创板": 0, "北交所": 0}
tot = 0
worst = []
for code, date, close in rows:
    if code == prev_code and prev_close and close and prev_close > 0:
        r = close / prev_close - 1
        b, lim = board(code)
        tot += 1
        if abs(r) > lim + 0.005:
            bad[b] += 1
            if len(worst) < 8:
                worst.append((code, date, round(r * 100, 2), b))
    prev_code, prev_close, prev_date = code, close, date

print("总相邻日样本:", tot)
for k, v in bad.items():
    print(f"  不可能日收益({k}): {v}")
print("  合计:", sum(bad.values()))
print("  样例:", worst)

# --- (B) baostock 历史深度 ---
sys.path.insert(0, "/root/sclaw/backend/scripts")
from bs_proxy import install_socks_proxy  # noqa: E402
install_socks_proxy(os.environ.get("BS_PROXY", "127.0.0.1:17891"))
import baostock as bs  # noqa: E402

lg = bs.login()
print("\nbaostock login:", lg.error_code)
if lg.error_code == "0":
    for sym in ("sh.600000", "sz.000001", "sh.600519"):
        rs = bs.query_history_k_data_plus(sym, "date,close", start_date="1990-01-01",
                                          end_date="2000-12-31", frequency="d", adjustflag="2")
        n = 0
        first = last = None
        while rs.next():
            r = rs.get_row_data()
            n += 1
            first = first or r[0]
            last = r[0]
        print(f"  {sym} 1990-2000: rows={n} {first} ~ {last} (err={rs.error_code})")
    bs.logout()
