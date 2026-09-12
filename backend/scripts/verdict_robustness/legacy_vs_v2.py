# -*- coding: utf-8 -*-
"""Is legacy stock_daily RAW while v2 daily is ADJUSTED?
Compare on a known ex-dividend date (600000, July each year)."""
import sqlite3

leg = sqlite3.connect('file:/root/sclaw/backend/data/stock_history.db?mode=ro', uri=True)
v2  = sqlite3.connect('file:/root/sclaw/backend/data/clean_daily.db?mode=ro', uri=True)

Q = "select date,open,high,low,close from {t} where code=? and date>=? and date<=? order by date"


def show(code, d0, d1):
    L = leg.execute(Q.format(t='stock_daily'), (code, d0, d1)).fetchall()
    V = v2 .execute(Q.format(t='daily'),       (code, d0, d1)).fetchall()
    print("=" * 78)
    print("code=%s  window %s .. %s   legacy_n=%d  v2_n=%d" % (code, d0, d1, len(L), len(V)))
    print("%-12s %12s %12s %12s" % ("date", "legacy_close", "v2_close", "ratio L/V"))
    for a, b in zip(L, V):
        print("%-12s %12.4f %12.4f %12.6f" % (a[0], a[4], b[4], a[4] / b[4]))
    print()
    print("legacy close %%: ", ["%.3f" % ((L[i][4] / L[i-1][4] - 1) * 100) for i in range(1, len(L))])
    print("v2     close %%: ", ["%.3f" % ((V[i][4] / V[i-1][4] - 1) * 100) for i in range(1, len(V))])
    print()


show('600000', '2020-07-15', '2020-07-30')
show('000001', '2020-07-08', '2020-07-20')

# global shape
print("=" * 78)
print("legacy stock_daily rows:", leg.execute("select count(*) from stock_daily").fetchone()[0])
print("v2     daily rows      :", v2 .execute("select count(*) from daily").fetchone()[0])
print("legacy date range:", leg.execute("select min(date),max(date) from stock_daily").fetchone())
print("v2     date range:", v2 .execute("select min(date),max(date) from daily").fetchone())
print("legacy distinct codes:", leg.execute("select count(distinct code) from stock_daily").fetchone()[0])
print("v2     distinct codes:", v2 .execute("select count(distinct code) from daily").fetchone()[0])
