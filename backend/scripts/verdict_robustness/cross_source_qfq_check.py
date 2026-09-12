#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨源 qfq 一致性检验: baostock(adjustflag=2) vs clean_daily(Tencent qfq)。

为什么要测: clean_daily 是 Tencent 前复权库。若把 baostock 的前复权行 INSERT 进去,
就是把两个源的复权基准拼在一起 —— 而 2026-09-11 的取证结论正是「多源拼接库不可信」。
本脚本给出可判定的数字: 同 code 同 date 的 close 相对差。

判据: 相对差 <0.5% -> 可拼; >2% -> 不可拼(基准不同, 拼接即制造隐性裂缝)。
"""
import os
import sqlite3
import sys

sys.path.insert(0, "/root/sclaw/backend/scripts")
from bs_proxy import install_socks_proxy

install_socks_proxy(os.environ.get("BS_PROXY", "127.0.0.1:17891"))
import baostock as bs

lg = bs.login()
print("login:", lg.error_code, getattr(lg, "error_msg", ""))
if lg.error_code != "0":
    sys.exit(2)

CODES = [("sh.600000", "600000"), ("sz.000001", "000001"), ("sz.300750", "300750")]
WIN = ("2020-06-01", "2023-12-31")

cdb = sqlite3.connect("file:/root/sclaw/backend/data/clean_daily.db?mode=ro", uri=True)

print(f"\n窗口 {WIN[0]} ~ {WIN[1]}")
for sym, code in CODES:
    rs = bs.query_history_k_data_plus(
        sym, "date,close", start_date=WIN[0], end_date=WIN[1], frequency="d", adjustflag="2"
    )
    if rs.error_code != "0":
        print(f"{sym} query_err={rs.error_code}")
        continue
    diffs = []
    while rs.next():
        d, c = rs.get_row_data()
        if not c:
            continue
        row = cdb.execute(
            "select close from daily where code=? and date=?", (code, d)
        ).fetchone()
        if not row or not row[0]:
            continue
        diffs.append((d, float(c), row[0], abs(float(c) - row[0]) / row[0]))
    if not diffs:
        print(f"{sym}: 无可比行")
        continue
    rels = sorted(x[3] for x in diffs)
    mx = max(diffs, key=lambda x: x[3])
    print(f"{sym} n={len(diffs):5d}  中位相对差={rels[len(rels)//2]*100:7.4f}%  "
          f"P95={rels[int(len(rels)*0.95)]*100:7.4f}%  最大={mx[3]*100:7.4f}%  @ {mx[0]} "
          f"(bs={mx[1]:.3f} vs clean={mx[2]:.3f})")

bs.logout()
