#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v4 状态依赖参数变体对比 — 一次加载数据, 循环跑多个参数组合"""
import sqlite3
import time
from collections import defaultdict, Counter
import numpy as np
import csv

DB = '/root/sclaw/data/stock_history.db'
IDX_CSV = '/root/sclaw/data/index_sh000001.csv'
INIT_CAP = 10000.0
LOT = 100
COMM_RATE, COMM_MIN = 0.00025, 5.0
STAMP = 0.0005
SLIP = 0.001
BUY_DAY = 3
SHRINK_RATIO = 1.0
BREADTH_MA = 5
BREADTH_THR = -0.5
TRAIL_PCT = 15
STOP_PCT = 9
MAX_HOLD = 40

SEGMENTS = [
    ('2022熊市', '2022-04-20', '2022-12-31'),
    ('2023震荡', '2023-01-01', '2023-12-31'),
    ('2024初股灾', '2024-01-01', '2024-02-29'),
    ('2024修复', '2024-03-01', '2024-08-31'),
    ('2024-25牛市', '2024-09-01', '2025-08-31'),
    ('2025-26震荡', '2025-09-01', '2026-08-20'),
]

# 变体定义: 状态 -> (emotion_on, max_pos, slot_frac)
VARIANTS = {
    # 当前 v4: 牛放开过滤+集中, 熊轻仓
    'V4A': {'牛': (False, 2, 0.50), '震荡': (True, 3, 1/3), '熊': (True, 3, 0.25)},
    # V4B: 只集中仓位, 所有状态保留情绪过滤 (最保守)
    'V4B': {'牛': (True, 2, 0.50), '震荡': (True, 3, 1/3), '熊': (True, 3, 0.25)},
    # V4C: 牛放开过滤, 但不集中仓位
    'V4C': {'牛': (False, 3, 1/3), '震荡': (True, 3, 1/3), '熊': (True, 3, 0.25)},
    # V4D: 只熊轻仓, 其余完全 v3
    'V4D': {'牛': (True, 3, 1/3), '震荡': (True, 3, 1/3), '熊': (True, 3, 0.25)},
    # V4E: 牛集中+熊轻仓, 震荡也收一点 (震荡 0.3)
    'V4E': {'牛': (True, 2, 0.50), '震荡': (True, 3, 0.30), '熊': (True, 3, 0.20)},
}


def load_data():
    t0 = time.time()
    print("Loading...", flush=True)
    conn = sqlite3.connect(DB)
    info = dict(conn.execute("SELECT code,name FROM stock_info").fetchall())

    def is_mainboard(c):
        return c.startswith(('60', '00')) and len(c) == 6

    codes = sorted({c for c in info if is_mainboard(c) and not info[c].startswith(('ST', '*ST', '退'))})
    cal = [r[0] for r in conn.execute("SELECT DISTINCT date FROM stock_daily ORDER BY date")]
    date_to_idx = {d: i for i, d in enumerate(cal)}
    n_days = len(cal)

    def is_lu(close, prev_close):
        if prev_close <= 0:
            return False
        return (close - prev_close) / prev_close * 100 >= 9.8

    stock_bars = {}
    for code in codes:
        rows = conn.execute(
            "SELECT date,open,high,low,close,volume FROM stock_daily WHERE code=? ORDER BY date", (code,)
        ).fetchall()
        if len(rows) < 5:
            continue
        di = np.array([date_to_idx[d] for d, *_ in rows], dtype=np.int32)
        arr = np.array([r[1:] for r in rows], dtype=np.float64)
        stock_bars[code] = {
            'di': di, 'open': arr[:, 0], 'high': arr[:, 1],
            'low': arr[:, 2], 'close': arr[:, 3], 'vol': arr[:, 4],
        }
    conn.close()
    print(f"Loaded {len(stock_bars)} stocks [{time.time()-t0:.1f}s]", flush=True)

    ret_lists = [[] for _ in range(n_days)]
    adv_lists = [[] for _ in range(n_days)]
    for sb in stock_bars.values():
        c = sb['close']
        r = np.diff(c) / c[:-1] * 100
        for k in range(len(r)):
            di = sb['di'][k + 1]
            if 0 <= di < n_days:
                ret_lists[di].append(r[k])
                adv_lists[di].append(1 if r[k] > 0 else 0)
    breadth = np.full(n_days, np.nan)
    adv_ratio = np.full(n_days, np.nan)
    for di in range(n_days):
        if ret_lists[di]:
            breadth[di] = float(np.median(ret_lists[di]))
            adv_ratio[di] = sum(adv_lists[di]) / len(adv_lists[di])
    bma = np.full(n_days, np.nan)
    for di in range(BREADTH_MA, n_days):
        w = breadth[di - BREADTH_MA + 1:di + 1]
        if np.isfinite(w).sum() >= max(3, BREADTH_MA // 2):
            bma[di] = float(np.nanmean(w))
    print(f"breadth done [{time.time()-t0:.1f}s]", flush=True)

    # 状态判定器
    idx_close = {}
    with open(IDX_CSV, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            idx_close[r['date']] = float(r['close'])
    idx_dates = sorted(idx_close)
    idx_series = [idx_close[d] for d in idx_dates]

    def rolling_ma(dates_list, arr, win, min_valid):
        out = {}
        for i, d in enumerate(dates_list):
            if i + 1 < win:
                continue
            window = arr[i + 1 - win:i + 1]
            vals = [x for x in window if x is not None]
            if len(vals) >= min_valid:
                out[d] = sum(vals) / len(vals)
        return out

    idx20 = rolling_ma(idx_dates, idx_series, 20, 15)
    idx60 = rolling_ma(idx_dates, idx_series, 60, 45)
    adv_series = [adv_ratio[i] for i in range(n_days)]
    adv10 = rolling_ma(cal, adv_series, 10, 6)

    state = ['预热'] * n_days
    for di, d in enumerate(cal):
        i20, i60 = idx20.get(d), idx60.get(d)
        a10 = adv10.get(d)
        if i20 is None or i60 is None or a10 is None:
            state[di] = '预热'
        elif i20 >= i60 and a10 > 0.50:
            state[di] = '牛'
        elif i20 < i60 and a10 < 0.45:
            state[di] = '熊'
        else:
            state[di] = '震荡'
    print("state done", flush=True)

    # 情绪 prem
    lu_codes_by_day = defaultdict(list)
    for code, sb in stock_bars.items():
        c = sb['close']
        n = len(c)
        prev_close = None
        for k in range(n):
            di = sb['di'][k]
            if di < 0 or di >= n_days:
                continue
            if prev_close is not None and prev_close > 0 and is_lu(c[k], prev_close):
                lu_codes_by_day[di].append(code)
            prev_close = c[k]
    prem = np.full(n_days, np.nan)
    for di in range(1, n_days):
        codes_prev = lu_codes_by_day[di - 1]
        if not codes_prev:
            continue
        rets = []
        for code in codes_prev:
            sb = stock_bars[code]
            mask = np.where(sb['di'] == di)[0]
            if len(mask) == 0:
                continue
            k = mask[0]
            prev_c = sb['close'][k - 1] if k > 0 else None
            if prev_c and prev_c > 0:
                rets.append((sb['close'][k] - prev_c) / prev_c * 100)
        prem[di] = float(np.mean(rets)) if rets else np.nan
    print(f"emotion done [{time.time()-t0:.1f}s]", flush=True)
    return info, cal, stock_bars, bma, prem, is_lu, state


def build_signals(info, cal, stock_bars, bma, prem, is_lu, state, state_params):
    sig_by_day = defaultdict(list)
    for code, sb in stock_bars.items():
        name = info.get(code, code)
        o, h, l, c, v = sb['open'], sb['high'], sb['low'], sb['close'], sb['vol']
        n = len(c)
        lu_idx = [i for i in range(1, n) if is_lu(c[i], c[i - 1]) and c[i] > o[i]]
        for i in lu_idx:
            if i + BUY_DAY >= n:
                continue
            d0_low = l[i]
            d0_vol = v[i]
            min_low_3 = min(l[i + 1], l[i + 2], l[i + 3])
            vr3 = v[i + 3] / d0_vol if d0_vol > 0 else 9.9
            lu_b3 = is_lu(c[i + 3], c[i + 2])
            if min_low_3 < d0_low:
                continue
            if vr3 >= SHRINK_RATIO:
                continue
            if lu_b3:
                continue
            buy_idx, entry = i + BUY_DAY, c[i + BUY_DAY]
            di = sb['di'][buy_idx]
            if not np.isfinite(bma[di]) or bma[di] <= BREADTH_THR:
                continue
            st = state[di]
            emotion_on = state_params.get(st, (True, 3, 1/3))[0]
            if emotion_on and bma[di] <= 0:
                p = prem[di] if di < len(prem) else np.nan
                if not np.isfinite(p) or p <= 0:
                    continue
            score = 50
            if vr3 < 0.6: score += 15
            elif vr3 < 0.8: score += 10
            elif vr3 < 1.0: score += 5
            if entry > d0_low * 1.05: score += 10
            score = min(100, int(score))
            sig_by_day[di].append((di, code, name, score, d0_low, entry))
    out = {}
    for di, lst in sig_by_day.items():
        best = {}
        for s in lst:
            if s[1] not in best or s[3] > best[s[1]][3]:
                best[s[1]] = s
        out[di] = sorted(best.values(), key=lambda x: -x[3])
    return out


def buy_cost(amount):
    return max(COMM_MIN, amount * COMM_RATE) + amount * SLIP


def sell_cost(amount):
    return max(COMM_MIN, amount * COMM_RATE) + amount * STAMP + amount * SLIP


def run_backtest(signals_by_day, cal, stock_bars, state, state_params):
    n_days = len(cal)
    cash = INIT_CAP
    positions = []
    equity_curve = []
    trades = []
    first_di = min(signals_by_day.keys()) if signals_by_day else n_days

    for di in range(first_di, n_days):
        st = state[di]
        max_pos = state_params.get(st, (True, 3, 1/3))[1]
        slot = INIT_CAP * state_params.get(st, (True, 3, 1/3))[2]

        to_sell = []
        for pos in positions:
            sb = stock_bars[pos['code']]
            mask = np.where(sb['di'] == di)[0]
            if len(mask) == 0:
                continue
            k = mask[0]
            high, close = sb['high'][k], sb['close'][k]
            days_held = di - pos['entry_di']
            reason = None
            sell_price = None
            pos['max_high'] = max(pos['max_high'], high)
            stop_line = max(pos['d0_low'], pos['entry_price'] * (1 - STOP_PCT / 100))
            if pos['max_high'] >= pos['entry_price'] * 1.05 and close < pos['max_high'] * (1 - TRAIL_PCT / 100):
                reason = 'trail_stop'
                sell_price = close
            elif close < stop_line:
                reason = 'stop_loss'
                sell_price = close
            elif days_held >= MAX_HOLD:
                reason = 'time_stop'
                sell_price = close
            if reason:
                to_sell.append((pos, sell_price, reason))

        for pos, sell_price, reason in to_sell:
            amount = pos['qty'] * sell_price
            net_val = amount - sell_cost(amount)
            cash += net_val
            net = net_val - pos['cost_basis']
            trades.append({
                'code': pos['code'], 'name': pos['name'],
                'buy_date': cal[pos['entry_di']], 'sell_date': cal[di],
                'buy_price': round(pos['entry_price'], 2),
                'sell_price': round(sell_price, 2),
                'qty': pos['qty'], 'hold_days': di - pos['entry_di'],
                'net': round(net, 2), 'ret_pct': round(net / pos['cost_basis'] * 100, 2),
                'reason': reason,
            })
            positions.remove(pos)

        if di in signals_by_day:
            held = {p['code'] for p in positions}
            for sig in signals_by_day[di]:
                if len(positions) >= max_pos:
                    break
                _, code, name, score, d0_low, entry = sig
                if code in held:
                    continue
                if cash < 1000:
                    break
                budget = min(cash, slot)
                qty = int(budget / entry / LOT) * LOT
                if qty <= 0:
                    continue
                amount = qty * entry
                cost = buy_cost(amount)
                if amount + cost > cash:
                    continue
                cash -= amount + cost
                positions.append({
                    'code': code, 'name': name, 'qty': qty,
                    'entry_di': di, 'entry_price': entry, 'd0_low': d0_low,
                    'cost_basis': amount + cost, 'max_high': entry,
                })
                held.add(code)

        equity = cash
        for p in positions:
            sb = stock_bars[p['code']]
            mask = np.where(sb['di'] == di)[0]
            if len(mask) > 0:
                equity += p['qty'] * sb['close'][mask[0]]
        equity_curve.append((cal[di], equity))

    return trades, equity_curve


def metrics(trades, equity_curve):
    if not trades:
        return {'trades': 0}
    total_ret = (equity_curve[-1][1] - INIT_CAP) / INIT_CAP * 100
    wins = [t for t in trades if t['net'] > 0]
    losses = [t for t in trades if t['net'] <= 0]
    win_rate = len(wins) / len(trades) * 100
    gross_win = sum(t['net'] for t in wins)
    gross_loss = abs(sum(t['net'] for t in losses))
    profit_factor = gross_win / gross_loss if gross_loss > 0 else 99.0
    eq = np.array([e for _, e in equity_curve], float)
    peak = np.maximum.accumulate(eq)
    dd = (peak - eq) / peak
    max_dd = float(np.max(dd)) * 100 if len(dd) else 0
    rets = np.diff(eq) / eq[:-1]
    sharpe = float(np.mean(rets) / np.std(rets) * np.sqrt(252)) if len(rets) > 1 and np.std(rets) > 0 else 0
    years = len(equity_curve) / 244
    annual = ((1 + total_ret / 100) ** (1 / years) - 1) * 100 if years > 0 else 0
    calmar = total_ret / max_dd if max_dd > 0 else (total_ret if total_ret > 0 else 0)
    return {
        'trades': len(trades), 'total_ret': round(float(total_ret), 2),
        'annual': round(float(annual), 2), 'max_dd': round(float(max_dd), 2),
        'win_rate': round(float(win_rate), 1), 'profit_factor': round(float(profit_factor), 2),
        'sharpe': round(float(sharpe), 2), 'calmar': round(float(calmar), 2),
    }


def segment_stats(trades):
    out = {}
    for name, s, e in SEGMENTS:
        seg = [t for t in trades if s <= t['buy_date'] <= e]
        if not seg:
            out[name] = {'trades': 0}
            continue
        wins = [t for t in seg if t['net'] > 0]
        out[name] = {
            'trades': len(seg), 'win_rate': round(len(wins) / len(seg) * 100, 1),
            'sum_net': round(sum(t['net'] for t in seg), 0),
        }
    return out


def state_stats(trades, state, cal):
    idx_map = {d: i for i, d in enumerate(cal)}
    out = {}
    for st in ['牛', '震荡', '熊']:
        seg = []
        for t in trades:
            di = idx_map.get(t['buy_date'])
            if di is not None and state[di] == st:
                seg.append(t)
        if not seg:
            out[st] = {'trades': 0}
            continue
        wins = [t for t in seg if t['net'] > 0]
        out[st] = {
            'trades': len(seg), 'win_rate': round(len(wins) / len(seg) * 100, 1),
            'sum_net': round(sum(t['net'] for t in seg), 0),
        }
    return out


def main():
    info, cal, stock_bars, bma, prem, is_lu, state = load_data()
    print("Running variants...", flush=True)
    results = []
    for vname, sp in VARIANTS.items():
        sigs = build_signals(info, cal, stock_bars, bma, prem, is_lu, state, sp)
        trades, eq = run_backtest(sigs, cal, stock_bars, state, sp)
        m = metrics(trades, eq)
        seg = segment_stats(trades)
        st = state_stats(trades, state, cal)
        results.append((vname, m, seg, st))
        print(f"\n{'='*60}\n{vname}: {m}", flush=True)
        print(f"  分段: " + " ".join(f"{k}:{v.get('sum_net',0):+.0f}({v.get('trades',0)})" for k, v in seg.items()), flush=True)
        print(f"  状态: " + " ".join(f"{k}:{v.get('sum_net',0):+.0f}({v.get('trades',0)})" for k, v in st.items()), flush=True)

    print("\n\n========== 汇总对比 ==========", flush=True)
    print(f"{'var':<6}{'笔':>5}{'总收益':>9}{'年化':>8}{'回撤':>8}{'胜率':>7}{'PF':>6}{'Sharpe':>8}{'Calmar':>8}", flush=True)
    for vname, m, seg, st in results:
        print(f"{vname:<6}{m['trades']:>5}{m['total_ret']:>8.1f}%{m['annual']:>7.1f}%{m['max_dd']:>7.1f}%{m['win_rate']:>6.1f}%{m['profit_factor']:>6.2f}{m['sharpe']:>8.2f}{m['calmar']:>8.2f}", flush=True)


if __name__ == '__main__':
    main()
