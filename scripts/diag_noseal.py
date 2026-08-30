#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 诊断: 日线涨停但 5m 未定位首封的样本, limit_up vs 5m max(close) 差值
import sqlite3
from collections import Counter
DB = '/root/sclaw/data/stock_history.db'
M5_DB = '/root/sclaw/data/stock_5m.db'
conn = sqlite3.connect(DB); c = conn.cursor()
m5c = sqlite3.connect(M5_DB).cursor()

def compute_limit_up(close, cp):
    if cp <= -99:
        return round(close, 2)
    pre = close / (1 + cp / 100.0)
    return round(pre, 2)

rows = c.execute("""SELECT date, code, close, change_pct FROM stock_daily
   WHERE date BETWEEN '2026-08-10' AND '2026-08-20'
     AND ((change_pct>=9.8 AND change_pct<=10.5) OR (change_pct>=19.8 AND change_pct<=21.0))
   ORDER BY date""").fetchall()
no = []
for date, code, close, cp in rows:
    lu = compute_limit_up(close, cp)
    mx = m5c.execute("SELECT MAX(close) FROM stock_kline_5m WHERE code=? AND substr(datetime,1,10)=?",
                     (code, date)).fetchone()[0]
    if mx is None or mx < lu - 0.005:
        no.append((date, code, close, cp, lu, mx, (lu - 0.005) - (mx or 0)))
print(f"样本 {len(rows)}, 无首封 {len(no)}")
d = Counter()
for r in no:
    diff = r[6]
    if diff >= 1:
        d['>=1元'] += 1
    elif diff >= 0.5:
        d['0.5~1元'] += 1
    elif diff >= 0.1:
        d['0.1~0.5元'] += 1
    elif diff >= 0.01:
        d['0.01~0.1元'] += 1
    elif diff > 0:
        d['<0.01元'] += 1
    else:
        d['==0'] += 1
print("差值分布:", dict(d))
print("--- 抽样 8 个 ---")
for r in no[:8]:
    print(f"  {r[0]} {r[1]} close={r[2]} cp={r[3]}% limit_up={r[4]} 5m_max={r[5]}")
