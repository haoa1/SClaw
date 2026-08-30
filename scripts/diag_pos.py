#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 诊断: pos_o > 1 板的样本 — 验证 compute_limit_up 是否偏低
import sqlite3
DB = '/root/sclaw/data/stock_history.db'
M5_DB = '/root/sclaw/data/stock_5m.db'
conn = sqlite3.connect(DB); c = conn.cursor()
m5c = sqlite3.connect(M5_DB).cursor()

def compute_limit_up(close, cp):
    if cp <= -99:
        return round(close, 2)
    pre = close / (1 + cp / 100.0)
    return round(pre, 2)

dates = [r[0] for r in c.execute("SELECT DISTINCT date FROM stock_daily WHERE date BETWEEN '2026-05-28' AND '2026-08-27' ORDER BY date")]
nxt = {dates[i]: dates[i+1] for i in range(len(dates)-1)}

bad = []
for date in dates:
    nxt_date = nxt.get(date)
    if not nxt_date:
        continue
    rows = c.execute("""SELECT date, code, close, change_pct FROM stock_daily
        WHERE date=? AND ((change_pct>=9.8 AND change_pct<=10.5) OR (change_pct>=19.8 AND change_pct<=21.0))""",
        (date,)).fetchall()
    for d, code, close, cp in rows:
        if code.startswith("920"):
            continue
        limit_up = compute_limit_up(close, cp)
        nr = c.execute("SELECT open, close, change_pct FROM stock_daily WHERE date=? AND code=?", (nxt_date, code)).fetchone()
        if not nr:
            continue
        open_n, close_n, cp_n = nr
        if open_n <= limit_up:
            continue
        # 次日反推 pre_close
        pre_n = close_n / (1 + cp_n / 100.0) if cp_n > -99 else close_n
        nxt_limit_up = round(pre_n * (1 + (0.20 if code.startswith(("30","300","301","302","688","689")) else 0.10)), 2)
        pos_o = (open_n - limit_up) / (limit_up * 0.10)
        if pos_o > 1.2:
            bad.append((date, code, close, cp, limit_up, open_n, nxt_limit_up, pos_o, open_n/nxt_limit_up))

print(f"pos_o>1.2 样本数: {len(bad)}")
print(f"{'date':<12}{'code':<8}{'close':>8}{'cp%':>8}{'limit_up':>9}{'open_n':>9}{'nxt_lu':>9}{'pos_o':>7}{'open/nxt_lu':>10}")
for r in bad[:20]:
    print(f"{r[0]:<12}{r[1]:<8}{r[2]:>8.2f}{r[3]:>8.4f}{r[4]:>9.2f}{r[5]:>9.2f}{r[6]:>9.2f}{r[7]:>7.2f}{r[8]:>9.2%}")
