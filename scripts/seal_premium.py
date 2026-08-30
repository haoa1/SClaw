#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""seal_premium.py v3 — 首封时间 → 次日溢价 统计 (板块分层 + 标准化指标)
指标解释:
- 次日开盘位置 = (次日开盘价 - 当日涨停价) / (当日涨停价 × 涨停幅度)
    = 次日开盘相对涨停价高开多少(单位: 个涨停板). 0=平开于涨停价, 1=次日直接涨停价开盘
- 次日收盘位置 = 同理用次日收盘价
- 次日再涨停: 次日收盘 >= 涨停价×(1+幅度)  (近似)
板块: 主板(10%) / 双创(创业板+科创板, 20%) 分开统计
"""
import sqlite3, argparse, time
from collections import defaultdict

DB = '/root/sclaw/data/stock_history.db'
M5_DB = '/root/sclaw/data/stock_5m.db'

def rate_of(code):
    if code.startswith(("30", "300", "301", "302", "688", "689")):
        return 0.20
    if code.startswith(("8", "4", "920")):
        return 0.30
    return 0.10

def is_lu_cp(cp, rate):
    if rate == 0.30:
        return 29.5 <= cp <= 31.0
    if rate == 0.20:
        return 19.8 <= cp <= 21.0
    return 9.8 <= cp <= 10.5

def compute_limit_up(close, cp, rate):
    if cp <= -99:
        return round(close, 2)
    pre = close / (1 + cp / 100.0)
    return round(pre * (1 + rate), 2)

def bucket_of(t):
    if t <= '09:40':
        return '09:35-09:40'
    if t <= '09:45':
        return '09:40-09:45'
    if t <= '10:00':
        return '09:45-10:00'
    if t <= '10:30':
        return '10:00-10:30'
    if t <= '11:30':
        return '10:30-11:30'
    if t <= '14:00':
        return '11:30-14:00'
    return '14:00-15:00'

ORDER = ['一字板', '09:35-09:40', '09:40-09:45', '09:45-10:00',
         '10:00-10:30', '10:30-11:30', '11:30-14:00', '14:00-15:00']

def show(title, buckets, yi):
    print(f"--- {title} ---")
    print(f"{'首封时段':<12}{'样本':>6}{'开盘位置':>9}{'收盘位置':>9}{'开盘>涨停价':>11}{'次日再涨停':>10}")
    print("-" * 62)
    if yi[0]:
        print(f"{'一字板':<12}{yi[0]:>6}{yi[1]/yi[0]:>8.2f}板")
    for k in ORDER[1:]:
        b = buckets.get(k)
        if not b or b['n'] == 0:
            print(f"{k:<12}{'—':>6}")
            continue
        print(f"{k:<12}{b['n']:>6}{b['pos_o']/b['n']:>8.2f}板{b['pos_c']/b['n']:>8.2f}板"
              f"{b['open_win']/b['n']*100:>10.1f}%{b['next_lu']/b['n']*100:>9.1f}%")
    tot = sum(b['n'] for b in buckets.values())
    if tot:
        po = sum(b['pos_o'] for b in buckets.values()) / tot
        pc = sum(b['pos_c'] for b in buckets.values()) / tot
        lu = sum(b['next_lu'] for b in buckets.values()) / tot * 100
        ow = sum(b['open_win'] for b in buckets.values()) / tot * 100
        print("-" * 62)
        print(f"{'盘中合计':<12}{tot:>6}{po:>8.2f}板{pc:>8.2f}板{ow:>10.1f}%{lu:>9.1f}%")
    print()

def main(start, end):
    t0 = time.time()
    conn = sqlite3.connect(DB); c = conn.cursor()
    m5c = sqlite3.connect(M5_DB).cursor()
    c.execute("CREATE INDEX IF NOT EXISTS idx_daily_date ON stock_daily(date)")
    conn.commit()

    dates = [r[0] for r in c.execute(
        "SELECT DISTINCT date FROM stock_daily WHERE date>=? AND date<=? ORDER BY date", (start, end))]
    nxt = {dates[i]: dates[i+1] for i in range(len(dates)-1)}

    rows = []
    for r in c.execute(
            """SELECT date, code, close, change_pct FROM stock_daily
               WHERE date>=? AND date<=? ORDER BY date""", (start, end)):
        date, code, close, cp = r
        if code.startswith("920"):
            continue
        rate = rate_of(code)
        if is_lu_cp(cp, rate):
            rows.append((date, code, close, cp, rate))
    print(f"沪深涨停事件: {len(rows)}  ({dates[0]} ~ {dates[-1]}, {len(dates)} 交易日)\n")

    # 按板块分: 10% vs 20%
    groups = {'主板10%': defaultdict(lambda: dict(n=0, pos_o=0.0, pos_c=0.0, open_win=0, next_lu=0)),
              '双创20%': defaultdict(lambda: dict(n=0, pos_o=0.0, pos_c=0.0, open_win=0, next_lu=0))}
    yi = {'主板10%': [0, 0.0], '双创20%': [0, 0.0]}
    no_seal = 0; no_next = 0
    for date, code, close, cp, rate in rows:
        limit_up = compute_limit_up(close, cp, rate)
        first = m5c.execute(
            "SELECT datetime, open FROM stock_kline_5m WHERE code=? AND substr(datetime,1,10)=? AND close>=? ORDER BY datetime LIMIT 1",
            (code, date, limit_up - 0.005)).fetchone()
        if first is None:
            no_seal += 1; continue
        dt, op = first
        st = dt[11:16]
        nxt_date = nxt.get(date)
        if nxt_date is None:
            no_next += 1; continue
        nr = c.execute("SELECT open, close FROM stock_daily WHERE date=? AND code=?",
                       (nxt_date, code)).fetchone()
        if nr is None:
            no_next += 1; continue
        open_n, close_n = nr[0], nr[1]
        # 标准化位置: (价 - 涨停价) / (涨停价 × 幅度)
        step = limit_up * rate
        pos_o = (open_n - limit_up) / step
        pos_c = (close_n - limit_up) / step
        gname = '双创20%' if rate >= 0.20 else '主板10%'
        if op >= limit_up - 0.005:
            yi[gname][0] += 1
            yi[gname][1] += pos_o
            continue
        b = groups[gname][bucket_of(st)]
        b['n'] += 1
        b['pos_o'] += pos_o
        b['pos_c'] += pos_c
        if open_n > limit_up:
            b['open_win'] += 1
        if close_n >= limit_up * (1 + rate) - 0.005:
            b['next_lu'] += 1

    print(f"无首封(5m缺): {no_seal}  无次日: {no_next}\n")
    for g in ('主板10%', '双创20%'):
        show(g, groups[g], yi[g])
    # 全市场合并
    allb = defaultdict(lambda: dict(n=0, pos_o=0.0, pos_c=0.0, open_win=0, next_lu=0))
    aly = [0, 0.0]
    for g in groups.values():
        for k, b in g.items():
            for key in ('n', 'pos_o', 'pos_c', 'open_win', 'next_lu'):
                allb[k][key] += b[key]
    for k in ('主板10%', '双创20%'):
        aly[0] += yi[k][0]; aly[1] += yi[k][1]
    show('全市场(含10%+20%)', allb, aly)
    print(f"用时 {time.time()-t0:.1f}s")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2026-05-28')
    ap.add_argument('--end', default='2026-08-27')
    a = ap.parse_args()
    main(a.start, a.end)
