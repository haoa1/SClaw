#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Quantify caliber mixing in the SOURCE minute tables.

adj_audit.factor = clean_daily.qfq_close / source_last_bar_close(day).
If a source is genuinely RAW, factor==1.0 can only happen where no adjustment
applies at all (i.e. the anchor region). A large population of factor==1.0 rows
scattered across OLD dates means those rows came from an ALREADY-adjusted source.

The builder's factor method absorbs this either way (factor=1.0 = passthrough),
so output stays correct -- this measures the premise, not the product.
"""
import sqlite3
D = "/root/sclaw/backend/data"
for per, mdb in ((30, "clean_m30.db"), (60, "clean_m60.db")):
    c = sqlite3.connect("file:%s/%s?mode=ro" % (D, mdb), uri=True)
    tot = c.execute("select count(*) from adj_audit").fetchone()[0]
    one = c.execute("select count(*) from adj_audit where factor=1.0").fetchone()[0]
    dmax = c.execute("select max(date) from adj_audit").fetchone()[0]
    one_old = c.execute("select count(*) from adj_audit where factor=1.0 and date<?", (dmax,)).fetchone()[0]
    d_one = c.execute("select count(distinct date) from adj_audit where factor=1.0").fetchone()[0]
    d_all = c.execute("select count(distinct date) from adj_audit").fetchone()[0]
    near = c.execute("select count(*) from adj_audit where factor between 0.999 and 1.001").fetchone()[0]
    print("m%-2d  rows=%-9d  factor==1.0: %-8d (%.1f%%)  of which OLD(<%s): %d" % (
        per, tot, one, 100.0 * one / tot, dmax, one_old))
    print("      dates: %d total, %d have a factor==1.0 row;  factor within 0.1%% of 1.0: %d (%.1f%%)" % (
        d_all, d_one, near, 100.0 * near / tot))
    c.close()

print()
print("=== is stock_kline_30m really raw?  spot-check 001388 across the ex-date ===")
s = sqlite3.connect("file:%s/stock_history.db?mode=ro" % D, uri=True)
cd = sqlite3.connect("file:%s/clean_daily.db?mode=ro" % D, uri=True)
for tab in ("stock_kline_30m", "stock_kline_60m"):
    print("  -- %s --" % tab)
    for d in ("2026-07-15", "2026-07-16", "2026-07-17"):
        b = s.execute("select close from %s where code='001388' and substr(datetime,1,10)=? "
                      "order by datetime desc limit 1" % tab, (d,)).fetchone()
        q = cd.execute("select close from daily where code='001388' and date=?", (d,)).fetchone()
        print("     %s  src_last=%s   clean_daily(qfq)=%s" % (d, b[0] if b else None, q[0] if q else None))
s.close(); cd.close()
