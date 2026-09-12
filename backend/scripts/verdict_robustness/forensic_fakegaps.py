#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
forensic: 旧库(不复权)的"假暴跌"事件量级 — 止损假象的根因候选

假设: Step6 在旧库(stock_history.db, close 不复权)上得到 "sl=0 +149.85% → sl=3 +633.06%"。
      不复权价在除权/除息日出现"假裂口下跌"(非真实亏损)。止损 sl=3% 会正好"避开"这些裂口,
      而持有腿要吃满裂口 → 止损看起来大幅改善收益。
      干净库(前复权)无裂口 → 止损只剩"砍在低点"的真实损失 → 贡献转负。

取证: 对同一 (code,date) 比较两库的日收益,
      假暴跌 = 旧库日收益比新库低 >= 3pp (即旧库凭空多出来的 >=3% 下跌)
"""
import sqlite3

OLD = "/root/sclaw/backend/data/stock_history.db"
NEW = "/root/sclaw/backend/data/clean_daily.db"

con = sqlite3.connect(":memory:")
con.execute("PRAGMA temp_store=FILE")
con.execute("PRAGMA cache_size=-200000")
con.execute("ATTACH DATABASE 'file:%s?mode=ro' AS o" % OLD)
con.execute("ATTACH DATABASE 'file:%s?mode=ro' AS n" % NEW)

print("[f] 建窗口视图 (LAG 求前收)...", flush=True)
con.execute("CREATE TEMP TABLE oret AS SELECT code,date,close,"
            " LAG(close) OVER (PARTITION BY code ORDER BY date) pc FROM o.stock_daily")
con.execute("CREATE TEMP TABLE nret AS SELECT code,date,close,"
            " LAG(close) OVER (PARTITION BY code ORDER BY date) pc FROM n.daily")
con.execute("CREATE INDEX ix_o ON oret(code,date)")
con.execute("CREATE INDEX ix_n ON nret(code,date)")
print("[f] 视图就绪", flush=True)


def one(sql, tag):
    c = con.execute(sql)
    r = c.fetchone()
    print("  %-46s %s" % (tag, r[0] if r else None), flush=True)
    return r[0] if r else None


base = ("(o.pc>0 AND n.pc>0 AND o.close>0 AND n.close>0)")

print("\n=== 可比样本 (两库同 code+date 且有前收) ===")
tot = one("SELECT count(*) FROM oret o JOIN nret n USING(code,date) WHERE " + base, "可比日收益总数")
print("\n=== 旧库凭空多出的下跌 (老收益 - 新收益 <= -x) ===")
for x in (0.20, 0.10, 0.05, 0.03, 0.02, 0.01):
    v = one("SELECT count(*) FROM oret o JOIN nret n USING(code,date) WHERE " + base +
            " AND (o.close/o.pc - n.close/n.pc) <= -%f" % x, "假跌幅 >= %.0f%%" % (x * 100))
print("\n=== 反向: 旧库凭空多出的上涨 (老-新 >= +x) ===")
for x in (0.03, 0.05, 0.10):
    one("SELECT count(*) FROM oret o JOIN nret n USING(code,date) WHERE " + base +
        " AND (o.close/o.pc - n.close/n.pc) >= +%f" % x, "假涨幅 >= %.0f%%" % (x * 100))

print("\n=== 口径影响: 止损3%在旧库上被误触发多少次 ===")
one("SELECT count(*) FROM oret o JOIN nret n USING(code,date) WHERE " + base +
    " AND (o.close/o.pc - n.close/n.pc) <= -0.03 AND (n.close/n.pc) > -0.03",
    "旧库假跌>=3% 而真实收益>-3% (纯误触发)")

print("\n=== 每年假跌>=3%事件数 ===")
for r in con.execute("SELECT substr(date,1,4) y, count(*) FROM oret o JOIN nret n USING(code,date) "
                     "WHERE " + base + " AND (o.close/o.pc - n.close/n.pc) <= -0.03 "
                     "GROUP BY y HAVING count(*)>0 ORDER BY y"):
    print("   %s  %d" % (r[0], r[1]))
print("\n[f] DONE")
