#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""375 个 v2「不可能日」归因：上市首日无涨跌幅 / 长期停牌复牌 / 真复权错误"""
import sqlite3, datetime

V2 = "/root/sclaw/backend/data/clean_daily_v2.db"
con = sqlite3.connect(":memory:")
con.execute("ATTACH DATABASE 'file:%s?mode=ro' AS v" % V2)

def limit(code):
    if code.startswith(("300", "301", "688", "689")):
        return 20.0
    if code.startswith(("4", "8", "92")):     # 北交所
        return 30.0
    return 10.0

q = """
select code, date, close,
       lag(close) over (partition by code order by date) as pc,
       lag(date)  over (partition by code order by date) as pd,
       row_number() over (partition by code order by date)     as rn
from v.daily
"""
bad = []
allrows = 0
for code, date, close, pc, pd, rn in con.execute(q):
    allrows += 1
    if pc is None or pc <= 0:
        continue
    chg = (close - pc) / pc * 100.0
    if abs(chg) > limit(code) + 2.0:
        gap = None
        try:
            gap = (datetime.date.fromisoformat(date) - datetime.date.fromisoformat(pd)).days
        except Exception:
            pass
        bad.append((code, date, pd, pc, close, chg, gap, rn))

print("v2 行数 =", allrows)
print("超板级限幅(+2pp)的不可能日 =", len(bad))
print()

ipo_first = sum(1 for b in bad if b[7] == 1)
ipo_early = sum(1 for b in bad if b[7] is not None and b[7] <= 5)
long_susp = sum(1 for b in bad if b[6] is not None and b[6] > 20)
print("  ① rn==1（该股首行，上市首日无涨跌幅）        =", ipo_first)
print("  ② rn<=5（上市前 5 个交易日）                =", ipo_early)
print("  ③ 距上一交易日 >20 天（长期停牌后复牌）      =", long_susp)
print()

explained = set()
for b in bad:
    if b[7] == 1 or (b[6] is not None and b[6] > 20):
        explained.add((b[0], b[1]))
rest = [b for b in bad if (b[0], b[1]) not in explained]
print("  三者合计已归因 =", len(explained), " 其余待判 =", len(rest))
print()
print("== 其余样例（按 |chg| 降序，取 25）==")
rest.sort(key=lambda x: -abs(x[5]))
for code, date, pd, pc, close, chg, gap, rn in rest[:25]:
    n = con.execute("select count(*) from v.daily where code=?", (code,)).fetchone()[0]
    print("  %-8s %s -> %s  gap=%sd  rn=%-5d %8.2f -> %8.2f  %+7.1f%%  (行数=%d)"
          % (code, pd, date, gap, rn, pc, close, chg, n))

# 板块分布
from collections import Counter
c = Counter()
for b in rest:
    code = b[0]
    if code.startswith(("300", "301")): c["创业板"] += 1
    elif code.startswith(("688", "689")): c["科创板"] += 1
    elif code.startswith(("4", "8", "92")): c["北交所"] += 1
    else: c["主板"] += 1
print()
print("其余板块分布:", dict(c))
