#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定位 clean_daily 内部的「基准跳变」点。

思路: 计算 ratio(t) = clean_close(t) / baostock_close(t)。
  若两源各自内部一致, ratio 应随 t **平滑**变化(缓慢漂移), 且跳变只发生在除权日附近。
  若 ratio 出现**台阶式跳变**(日内不变、跨日突变), 说明 clean_daily 在该日
  切换了复权基准 => 库是拼接的, 且拼接处产生虚假收益(这正是 |日收益|>10% 的来源)。
"""
import os
import sqlite3
import sys

sys.path.insert(0, "/root/sclaw/backend/scripts")
from bs_proxy import install_socks_proxy

install_socks_proxy(os.environ.get("BS_PROXY", "127.0.0.1:17891"))
import baostock as bs

bs.login()
WIN = ("2020-01-01", "2023-12-31")
cdb = sqlite3.connect("file:/root/sclaw/backend/data/clean_daily.db?mode=ro", uri=True)

for sym, code in [("sh.600000", "600000"), ("sz.000001", "000001")]:
    rs = bs.query_history_k_data_plus(
        sym, "date,close", start_date=WIN[0], end_date=WIN[1], frequency="d", adjustflag="2"
    )
    bmap = {}
    while rs.next():
        d, c = rs.get_row_data()
        if c:
            bmap[d] = float(c)
    cmap = {
        d: c
        for d, c in cdb.execute(
            "select date,close from daily where code=? and date between ? and ? order by date",
            (code, WIN[0], WIN[1]),
        )
        if c
    }
    common = sorted(set(bmap) & set(cmap))
    print(f"\n=== {sym}  可比日={len(common)} ===")
    ratios = [(d, cmap[d] / bmap[d]) for d in common]
    jumps = []
    for i in range(1, len(ratios)):
        d0, r0 = ratios[i - 1]
        d1, r1 = ratios[i]
        if abs(r1 - r0) / r0 > 0.005:          # ratio 跳变 >0.5%
            jumps.append((d1, r0, r1, (r1 / r0 - 1) * 100))
    print(f"  ratio 起={ratios[0][1]:.4f} 止={ratios[-1][1]:.4f}")
    print(f"  ratio 台阶跳变(>0.5%) 次数 = {len(jumps)}")
    for d, r0, r1, pc in jumps[:20]:
        print(f"    {d}  ratio {r0:.4f} -> {r1:.4f}   ({pc:+.2f}%)")

bs.logout()
