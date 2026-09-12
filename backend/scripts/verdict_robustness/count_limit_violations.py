#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""clean_daily 涨跌幅上限违反统计（纯库内自证，无需外部数据）。

A股日涨跌幅限制: 主板/中小板 ±10%, 创业板(300)/科创板(688) ±20%(2020-08后),
北交所 ±30%。新股首日/复牌等无限制情形是少数。

故: 主板/中小板出现 |日收益| > 10.5% 的行 => 高度可疑(除权未复权/基准跳变)。
本脚本按板块分桶统计, 给出量化证据。
"""
import sqlite3
from collections import Counter

c = sqlite3.connect("file:/root/sclaw/backend/data/clean_daily.db?mode=ro", uri=True)

LIMIT = {"main": 0.105, "gem_star": 0.205, "bj": 0.31}


def board(code):
    if code.startswith(("300", "301", "688", "689")):
        return "gem_star"
    if code.startswith(("4", "8")):
        return "bj"
    return "main"


prev = {}
viol = Counter()
total = Counter()
worst = []

rows = c.execute(
    "select code,date,close from daily where date >= '2020-01-01' and close is not null "
    "order by code,date"
)
for code, d, cl in rows:
    b = board(code)
    total[b] += 1
    p = prev.get(code)
    if p and p > 0:
        r = abs(cl / p - 1)
        if r > LIMIT[b]:
            viol[b] += 1
            if b == "main" and len(worst) < 15:
                worst.append((code, d, p, cl, (cl / p - 1) * 100))
    prev[code] = cl

print("=== 2020+ 涨跌幅上限违反统计 ===")
for b in ("main", "gem_star", "bj"):
    if total[b]:
        print(f"  {b:9s} 行数={total[b]:>9,}  违反={viol[b]:>7,}  ({viol[b]/total[b]*100:.4f}%)")

print("\n主板 |日收益|>10.5% 样例 (code date prev close ret%):")
for code, d, p, cl, r in worst:
    print(f"  {code} {d}  {p:.2f} -> {cl:.2f}   {r:+.2f}%")
