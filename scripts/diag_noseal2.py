#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断修复后 2182 个无首封的构成: 按代码前缀分布"""
import sqlite3
from collections import Counter

DB = '/root/sclaw/data/stock_history.db'
M5_DB = '/root/sclaw/data/stock_5m.db'

def rate_of(code):
    if code.startswith(("30","300","301","302","688","689")): return 0.20
    if code.startswith(("8","4","920")): return 0.30
    return 0.10

def is_lu_cp(cp, rate):
    if rate == 0.30: return 29.5 <= cp <= 31.0
    if rate == 0.20: return 19.8 <= cp <= 21.0
    return 9.8 <= cp <= 10.5

def compute_limit_up(close, cp, rate):
    if cp <= -99: return round(close, 2)
    pre = close / (1 + cp / 100.0)
    return round(pre * (1 + rate), 2)

conn = sqlite3.connect(DB); c = conn.cursor()
m5c = sqlite3.connect(M5_DB).cursor()

prefix_cnt = Counter()
samples = {}
m5exists = Counter()   # 前缀 -> 该股当日5m是否存在
m5max_close = Counter()
tot = 0
for r in c.execute("SELECT date, code, close, change_pct FROM stock_daily WHERE date>='2026-05-28' AND date<='2026-08-27'"):
    date, code, close, cp = r
    if code.startswith("920"): continue
    rate = rate_of(code)
    if not is_lu_cp(cp, rate): continue
    tot += 1
    lu = compute_limit_up(close, cp, rate)
    first = m5c.execute("SELECT 1 FROM stock_kline_5m WHERE code=? AND substr(datetime,1,10)=? AND close>=? ORDER BY datetime LIMIT 1",
                        (code, date, lu-0.005)).fetchone()
    if first is None:
        pre = code[:2]
        prefix_cnt[pre] += 1
        # 5m 是否有该股当日数据?
        mx = m5c.execute("SELECT MAX(close) FROM stock_kline_5m WHERE code=? AND substr(datetime,1,10)=?", (code, date)).fetchone()
        m5exists[pre] += 1 if mx[0] is not None else 0
        m5max_close[pre] = mx[0] if mx[0] is not None else -1
        if pre not in samples:
            samples[pre] = (date, code, close, cp, lu, mx[0])

print(f"涨停事件总数(排920): {tot}")
print(f"无首封总数: {sum(prefix_cnt.values())}")
print("\n按前缀分布 (无首封数 / 其中5m当日有数据):")
for pre, n in prefix_cnt.most_common(20):
    print(f"  {pre}: {n:>5}  (5m有数据: {m5exists[pre]})")
print("\n样例 (date code close cp% limit_up 5m_max_close):")
for pre, s in sorted(samples.items()):
    print(f"  {pre}: {s}")
