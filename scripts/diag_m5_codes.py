#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""查 5m 库各日期 code 前缀覆盖分布"""
import sqlite3
from collections import Counter
c = sqlite3.connect("/root/sclaw/data/stock_5m.db").cursor()

for day in ("2026-05-28", "2026-08-03", "2026-08-04", "2026-08-27"):
    pre = Counter()
    for r in c.execute("SELECT DISTINCT code FROM stock_kline_5m WHERE substr(datetime,1,10)=?", (day,)):
        pre[r[0][:2]] += 1
    print(f"=== {day} 覆盖 code 前缀分布 (共{sum(pre.values())}只) ===")
    for k, v in sorted(pre.items()):
        print(f"  {k}: {v}")

print("=== 300721 5m 范围 ===")
print(c.execute("SELECT MIN(datetime), MAX(datetime), COUNT(*) FROM stock_kline_5m WHERE code='300721'").fetchone())
print("=== 000001 5m 范围 ===")
print(c.execute("SELECT MIN(datetime), MAX(datetime), COUNT(*) FROM stock_kline_5m WHERE code='000001'").fetchone())
print("=== 600000 5m 范围 ===")
print(c.execute("SELECT MIN(datetime), MAX(datetime), COUNT(*) FROM stock_kline_5m WHERE code='600000'").fetchone())
