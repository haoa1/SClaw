#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""backtest_6dim_v2.py — 六维复合选股回测 v2 (爆款收紧版)
在v1基础上收紧(相对v1 -93%的教训):
  [1] 绿柱临界: 相对判定 |hist_now| <= 0.35*|hist_peak| (从峰值收缩>=65%), 连续>=2天向0靠近, 未翻红
  [2] 缩量:     vol <= 0.9 * 前20日均量
  [3] MA:       close > MA5 且 close > MA10
  [4] 结构:     不处60日高位 + 20日内有过涨停(爆款基因)
  [5] 大盘相对强度: 个股5日 >= 全市场中位5日
  [6] RSI:      40~58 且 回升
买卖: 信号日收盘买, 次日开盘卖, 本金10000, 买Top3
"""
import sqlite3
import time
import json
import numpy as np
import pandas as pd

DB = '/root/sclaw/data/stock_history.db'
INIT_CAP = 10000.0
LOT = 100
COMM_RATE, COMM_MIN = 0.00025, 5.0
STAMP = 0.0005
SLIP = 0.001
TOP_N = 3
SHRINK_MIN = 2
NEAR_FRAC = 0.35
VOL_RATIO_MAX = 0.9
POSITION_HIGH60 = 0.95
RSI_LO, RSI_HI = 40.0, 58.0
LU_WINDOW = 20
LU_MIN = 8.0
START_DATE = '2022-01-01'

SEGMENTS = [
    ('2022熊市', '2022-01-01', '2022-12-31'),
    ('2023震荡', '2023-01-01', '2023-12-31'),
    ('2024初股灾', '2024-01-01', '2024-02-29'),
    ('2024修复', '2024-03-01', '2024-08-31'),
    ('2024-25牛市', '2024-09-01', '2025-08-31'),
    ('2025-26震荡', '2025-09-01', '2026-08-26'),
]


def get_codes(conn):
    info = dict(conn.execute("SELECT code,name FROM stock_info").fetchall())

    def is_stock(c):
        if len(c) != 6 or not c.isdigit():
            return False
        if not c.startswith(('60', '00', '30', '68')):
            return False
        nm = info.get(c, '')
        if nm.startswith(('ST', '*ST', '退')):
            return False
        return True

    codes = sorted([c for c in info if is_stock(c)])
    cal = sorted({r[0] for r in conn.execute("SELECT DISTINCT date FROM stock_daily ORDER BY date")})
    d2i = {d: i for i, d in enumerate(cal)}
    return codes, cal, d2i


def stock_rows(conn, code):
    return conn.execute(
        "SELECT date,open,close,volume,turnover_rate FROM stock_daily WHERE code=? ORDER BY date",
        (code,)
    ).fetchall()


def pass_breadth(conn, codes, cal, d2i):
    t0 = time.time()
    n = len(cal)
    ret_lists = [[] for _ in range(n)]
    for c in codes:
        rows = stock_rows(conn, c)
        if len(rows) < 5:
            continue
        for k in range(1, len(rows)):
            d, o, cl, v, t = rows[k]
            prev = rows[k - 1][2]
            if prev > 0:
                ret_lists[d2i[d]].append((cl / prev - 1.0) * 100.0)
    breadth = np.full(n, np.nan)
    for di in range(n):
        if ret_lists[di]:
            breadth[di] = float(np.median(ret_lists[di]))
    mkt5 = np.full(n, np.nan)
    for i in range(5, n):
        w = breadth[i - 4:i + 1]
        if np.isfinite(w).sum() >= 4:
            mkt5[i] = float(np.nansum(w))
    print(f"breadth done [{time.time()-t0:.1f}s]", flush=True)
    return mkt5


def macd_hist(s):
    ema12 = s.ewm(span=12, adjust=False).mean()
    ema26 = s.ewm(span=26, adjust=False).mean()
    dif = ema12 - ema26
    dea = dif.ewm(span=9, adjust=False).mean()
    return (dif - dea) * 2.0


def rsi14(s):
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    ag = gain.ewm(alpha=1.0 / 14, min_periods=14, adjust=False).mean()
    al = loss.ewm(alpha=1.0 / 14, min_periods=14, adjust=False).mean()
    rs = ag / al.replace(0.0, np.nan)
    return 100.0 - 100.0 / (1.0 + rs)


def green_shrink(hist, j):
    """绿柱临界: 未翻红, 已过峰值, 连续>=2天向0靠近, 相对收缩>=65%"""
    if j < 8:
        return None
    if hist[j] >= 0:
        return None
    window = hist[j - 6:j + 1]
    argmin = j - 6 + int(np.argmin(window))
    if argmin > j - SHRINK_MIN:
        return None
    for k in range(argmin + 1, j + 1):
        if hist[k] <= hist[k - 1]:
            return None
    peak = abs(hist[argmin])
    if peak <= 1e-9:
        return None
    if abs(hist[j]) > NEAR_FRAC * peak:
        return None
    return j - argmin


def pass_signals(conn, codes, cal, d2i, mkt5):
    t0 = time.time()
    n = len(cal)
    events = []
    for c in codes:
        rows = stock_rows(conn, c)
        if len(rows) < 30:
            continue
        close = np.array([r[2] for r in rows], dtype=np.float64)
        open_ = np.array([r[1] for r in rows], dtype=np.float64)
        vol = np.array([r[3] for r in rows], dtype=np.float64)
        turn = np.array([r[4] if r[4] is not None else 0.0 for r in rows], dtype=np.float64)
        di_arr = np.array([d2i[r[0]] for r in rows], dtype=np.int32)
        s = pd.Series(close)
        hist = macd_hist(s).to_numpy()
        rsi = rsi14(s).to_numpy()
        ma5 = s.rolling(5).mean().to_numpy()
        ma10 = s.rolling(10).mean().to_numpy()
        ma20 = s.rolling(20).mean().to_numpy()
        m = len(close)
        ret5 = np.full(m, np.nan)
        for i in range(5, m):
            if close[i - 5] > 0:
                ret5[i] = (close[i] / close[i - 5] - 1.0) * 100.0
        high60 = np.full(m, np.nan)
        for i in range(59, m):
            high60[i] = np.max(close[i - 59:i + 1])
        # 20日内最大单日涨幅 (爆款基因)
        maxret20 = np.zeros(m)
        for i in range(LU_WINDOW + 1, m):
            prev = close[i - LU_WINDOW:i]
            seg = close[i - LU_WINDOW + 1:i + 1]
            r = (seg / prev - 1.0) * 100.0
            maxret20[i] = float(np.max(r)) if len(r) else 0.0

        for j in range(30, m):
            sd = green_shrink(hist, j)
            if sd is None:
                continue
            avg_vol = float(np.mean(vol[j - 20:j - 4]))
            if avg_vol <= 0 or vol[j] > VOL_RATIO_MAX * avg_vol:
                continue
            if np.isnan(ma5[j]) or close[j] <= ma5[j]:
                continue
            if np.isnan(ma10[j]) or close[j] <= ma10[j]:
                continue
            if np.isnan(high60[j]) or close[j] > POSITION_HIGH60 * high60[j]:
                continue
            if np.isnan(rsi[j]) or not (RSI_LO <= rsi[j] <= RSI_HI):
                continue
            if j < 1 or np.isnan(rsi[j - 1]) or rsi[j] <= rsi[j - 1]:
                continue
            # 爆款基因: 20日内有涨停级拉升
            if maxret20[j] < LU_MIN:
                continue
            dj = di_arr[j]
            if dj >= n or np.isnan(ret5[j]) or np.isnan(mkt5[dj]):
                continue
            rel = ret5[j] - mkt5[dj]
            if rel < 0:
                continue
            score = 0.0
            score += min(sd, 5) / 5.0 * 25
            score += max(0.0, 1.0 - abs(hist[j]) / (NEAR_FRAC * abs(hist[np.argmin(hist[j - 6:j + 1]) + j - 6]))) * 20
            vol_r = vol[j] / avg_vol
            score += max(0.0, (VOL_RATIO_MAX - vol_r) / VOL_RATIO_MAX) * 15
            score += min(max(rel / 5.0, 0.0), 1.0) * 20
            if not np.isnan(ma20[j]) and close[j] > ma20[j]:
                score += 10
            if j > 0 and close[j] > close[j - 1]:
                score += 5
            if 2 <= turn[j] <= 12:
                score += 5
            if j + 1 >= m:
                continue
            sell_px = open_[j + 1]
            sell_di = di_arr[j + 1]
            if sell_px <= 0 or sell_di <= dj:
                continue
            events.append((dj, score, c, close[j], sell_px, sell_di))
    print(f"signals done: {len(events)} events [{time.time()-t0:.1f}s]", flush=True)
    return events


def backtest(events, cal):
    t0 = time.time()
    n = len(cal)
    start_idx = next(i for i, d in enumerate(cal) if d >= START_DATE)
    by_day = {}
    for ev in events:
        dj = ev[0]
        if dj < start_idx:
            continue
        by_day.setdefault(dj, []).append(ev)
    cash = INIT_CAP
    pos = []
    trades = []
    eq_records = []

    for i in range(start_idx, n):
        proceeds = 0.0
        new_pos = []
        for code, qty, buy_px, sell_px, sell_di in pos:
            if sell_di == i:
                gross = qty * sell_px
                comm = max(gross * COMM_RATE, COMM_MIN)
                stamp = gross * STAMP
                slip = gross * SLIP
                proceeds += gross - comm - stamp - slip
                trades.append({'code': code, 'buy_di': i - 1, 'sell_di': i,
                               'buy_px': buy_px, 'sell_px': sell_px,
                               'ret_pct': (sell_px - buy_px) / buy_px * 100.0})
            else:
                new_pos.append((code, qty, buy_px, sell_px, sell_di))
        pos = new_pos
        cash += proceeds

        cands = by_day.get(i, [])
        cands.sort(key=lambda x: -x[1])
        holding = {p[0] for p in pos}
        buys = []
        for ev in cands:
            if len(buys) >= TOP_N:
                break
            if ev[2] in holding:
                continue
            buys.append(ev)
        if buys:
            alloc = cash / len(buys)
        else:
            alloc = 0.0
        for dj, score, code, buy_px, sell_px, sell_di in buys:
            if buy_px <= 0:
                continue
            qty = int(alloc / buy_px / LOT) * LOT
            if qty < LOT:
                continue
            cost = qty * buy_px
            comm = max(cost * COMM_RATE, COMM_MIN)
            slip = cost * SLIP
            total = cost + comm + slip
            if total > cash:
                qty = int((cash - comm - slip) / buy_px / LOT) * LOT
                if qty < LOT:
                    continue
                cost = qty * buy_px
                comm = max(cost * COMM_RATE, COMM_MIN)
                slip = cost * SLIP
                total = cost + comm + slip
            cash -= total
            pos.append((code, qty, buy_px, sell_px, sell_di))

        eq = cash + sum(q * p for (_, q, p, _, _) in pos)
        eq_records.append((i, eq))
    print(f"backtest done [{time.time()-t0:.1f}s]", flush=True)
    return eq_records, trades


def metrics(eq_records, trades, cal):
    eq = np.array([e for _, e in eq_records], dtype=np.float64)
    dates = [cal[i] for i, _ in eq_records]
    total_ret = (eq[-1] / INIT_CAP - 1.0) * 100.0
    years = len(eq) / 245.0
    cagr = ((eq[-1] / INIT_CAP) ** (1.0 / years) - 1.0) * 100.0 if years > 0 else 0.0
    peak = np.maximum.accumulate(eq)
    dd = (eq - peak) / peak * 100.0
    max_dd = float(dd.min())
    wins = [t for t in trades if t['ret_pct'] > 0]
    losses = [t for t in trades if t['ret_pct'] <= 0]
    win_rate = len(wins) / len(trades) * 100.0 if trades else 0.0
    avg_win = float(np.mean([t['ret_pct'] for t in wins])) if wins else 0.0
    avg_loss = float(np.mean([t['ret_pct'] for t in losses])) if losses else 0.0
    gross_win = sum(t['ret_pct'] for t in wins)
    gross_loss = abs(sum(t['ret_pct'] for t in losses))
    pf = gross_win / gross_loss if gross_loss > 0 else float('inf')
    dr = np.diff(eq) / eq[:-1] * 100.0
    sharpe = float(np.mean(dr) / np.std(dr) * np.sqrt(245)) if len(dr) > 1 and np.std(dr) > 0 else 0.0
    return {
        'total_ret': total_ret, 'cagr': cagr, 'max_dd': max_dd,
        'win_rate': win_rate, 'avg_win': avg_win, 'avg_loss': avg_loss,
        'profit_factor': pf, 'sharpe': sharpe, 'trades': len(trades),
        'final_equity': float(eq[-1]), 'start': dates[0], 'end': dates[-1],
    }, dates


def segment_stats(eq_records, trades, cal):
    eq_map = dict(eq_records)
    seg = {}
    for name, d0, d1 in SEGMENTS:
        i0 = next((i for i, d in enumerate(cal) if d >= d0), None)
        i1 = next((i for i, d in enumerate(cal) if d > d1), len(cal))
        if i0 is None:
            continue
        e0 = eq_map.get(i0)
        e1 = eq_map.get(i1 - 1 if i1 > 0 else 0)
        if e0 is None or e1 is None:
            continue
        seg_trades = [t for t in trades if d0 <= cal[t['sell_di']] <= d1]
        ret = (e1 / e0 - 1.0) * 100.0
        eqs = np.array([eq_map[i] for i in range(i0, i1) if i in eq_map])
        peak = np.maximum.accumulate(eqs)
        dd = float(((eqs - peak) / peak * 100.0).min()) if len(eqs) else 0.0
        seg[name] = {
            'ret': ret, 'max_dd': dd, 'n_trades': len(seg_trades),
            'win_rate': (sum(1 for t in seg_trades if t['ret_pct'] > 0) / len(seg_trades) * 100.0) if seg_trades else 0.0,
        }
    return seg


def main():
    print("=== 六维复合选股回测 v2 (爆款收紧版) ===", flush=True)
    conn = sqlite3.connect(DB)
    codes, cal, d2i = get_codes(conn)
    mkt5 = pass_breadth(conn, codes, cal, d2i)
    events = pass_signals(conn, codes, cal, d2i, mkt5)
    eq_records, trades = backtest(events, cal)
    m, dates = metrics(eq_records, trades, cal)
    seg = segment_stats(eq_records, trades, cal)
    conn.close()

    print("\n===== 总览 =====")
    print(f"区间: {m['start']} ~ {m['end']}  ({len(eq_records)}个交易日)")
    print(f"总收益: {m['total_ret']:.2f}%  年化: {m['cagr']:.2f}%  最大回撤: {m['max_dd']:.2f}%")
    print(f"胜率: {m['win_rate']:.1f}%  平均盈: {m['avg_win']:.2f}%  平均亏: {m['avg_loss']:.2f}%")
    print(f"盈亏比: {m['profit_factor']:.2f}  夏普: {m['sharpe']:.2f}  交易数: {m['trades']}")
    print(f"期末权益: {m['final_equity']:.2f}")

    print("\n===== 分段表现 (含熊市) =====")
    for name, s in seg.items():
        print(f"{name:14s} 收益 {s['ret']:8.2f}%  最大回撤 {s['max_dd']:7.2f}%  交易 {s['n_trades']:4d}  胜率 {s['win_rate']:.1f}%")

    st = sorted(trades, key=lambda t: -t['ret_pct'])
    print("\n===== 最佳/最差各5笔 =====")
    for t in st[:5]:
        print(f"  {t['code']} 买{cal[t['buy_di']]}@{t['buy_px']:.2f} 卖{cal[t['sell_di']]}@{t['sell_px']:.2f}  {t['ret_pct']:+.2f}%")
    print("  ...")
    for t in st[-5:]:
        print(f"  {t['code']} 买{cal[t['buy_di']]}@{t['buy_px']:.2f} 卖{cal[t['sell_di']]}@{t['sell_px']:.2f}  {t['ret_pct']:+.2f}%")

    with open('/root/sclaw/data/backtest_6dim_v2_result.json', 'w') as f:
        json.dump({'metrics': m, 'segments': seg}, f, ensure_ascii=False, indent=2)
    print("\nsaved -> data/backtest_6dim_v2_result.json")


if __name__ == '__main__':
    main()
