#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bt_v4_exp.py — v4 单变量实验: 过滤状态化 × 仓位状态化 交叉对比
================================================================
一次 load_data (含 state 判定), 4 配置:
  cfg0: 过滤v3     × 仓位v3     (基线, 应复现 v3 +119.67%)
  cfg1: 过滤状态化 × 仓位v3     (只改过滤)
  cfg2: 过滤v3     × 仓位状态化 (只改仓位)
  cfg3: 过滤状态化 × 仓位状态化 (v4 原版)
过滤状态化: 牛=放开情绪过滤 / 震荡=v3 / 熊=prem>0.5 严格
仓位状态化: 牛=max_pos2 slot=cash/2 / 震荡=max_pos3 / 熊=max_pos4
"""
import sqlite3
import sys
import time
import csv as _csv
from collections import defaultdict, Counter

import numpy as np

DB = '/root/sclaw/data/stock_history.db'
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

# 状态仓位: 牛加仓2只 / 震荡3只(v3) / 熊减仓分散4只
STATE_POS = {'牛': 2, '震荡': 3, '熊': 4, '预热': 1}
# 状态情绪: 牛放开 / 震荡v3 / 熊严格
STATE_PREM_THR = {'牛': None, '震荡': 0.0, '熊': 0.5, '预热': None}

SEGMENTS = [
    ('2022熊市', '2022-04-20', '2022-12-31'),
    ('2023震荡', '2023-01-01', '2023-12-31'),
    ('2024初股灾', '2024-01-01', '2024-02-29'),
    ('2024修复', '2024-03-01', '2024-08-31'),
    ('2024-25牛市', '2024-09-01', '2025-08-31'),
    ('2025-26震荡', '2025-09-01', '2026-08-20'),
]


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
    for sb in stock_bars.values():
        c = sb['close']
        r = np.diff(c) / c[:-1] * 100
        for k in range(len(r)):
            di = sb['di'][k + 1]
            if 0 <= di < n_days:
                ret_lists[di].append(r[k])
    breadth = np.full(n_days, np.nan)
    for di in range(n_days):
        if ret_lists[di]:
            breadth[di] = float(np.median(ret_lists[di]))
    bma = np.full(n_days, np.nan)
    for di in range(BREADTH_MA, n_days):
        w = breadth[di - BREADTH_MA + 1:di + 1]
        if np.isfinite(w).sum() >= max(3, BREADTH_MA // 2):
            bma[di] = float(np.nanmean(w))
    print(f"breadth done [{time.time()-t0:.1f}s]", flush=True)

    # ---- 状态判定 ----
    adv = np.full(n_days, np.nan)
    for di in range(n_days):
        if ret_lists[di]:
            adv[di] = np.mean([1.0 if x > 0 else 0.0 for x in ret_lists[di]])
    adv10 = np.full(n_days, np.nan)
    for di in range(n_days):
        w = adv[max(0, di - 9):di + 1]
        if np.isfinite(w).sum() >= 6:
            adv10[di] = float(np.nanmean(w))
    idx_close = {}
    with open('/root/sclaw/data/index_sh000001.csv', encoding='utf-8') as f:
        for r in _csv.DictReader(f):
            idx_close[r['date']] = float(r['close'])
    idx_by_di = np.full(n_days, np.nan)
    for d, c in idx_close.items():
        if d in date_to_idx:
            idx_by_di[date_to_idx[d]] = c
    idx20 = np.full(n_days, np.nan)
    idx60 = np.full(n_days, np.nan)
    for di in range(n_days):
        w20 = idx_by_di[max(0, di - 19):di + 1]
        if np.isfinite(w20).sum() >= 15:
            idx20[di] = float(np.nanmean(w20))
        w60 = idx_by_di[max(0, di - 59):di + 1]
        if np.isfinite(w60).sum() >= 45:
            idx60[di] = float(np.nanmean(w60))
    state = np.full(n_days, '预热', dtype=object)
    for di in range(n_days):
        i20, i60, a10 = idx20[di], idx60[di], adv10[di]
        if not (np.isfinite(i20) and np.isfinite(i60) and np.isfinite(a10)):
            state[di] = '预热'
        elif i20 >= i60 and a10 > 0.50:
            state[di] = '牛'
        elif i20 < i60 and a10 < 0.45:
            state[di] = '熊'
        else:
            state[di] = '震荡'
    print(f"state done {dict(Counter(state.tolist()))} [{time.time()-t0:.1f}s]", flush=True)

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
            prev_c = sb['close'][k-1] if k > 0 else None
            if prev_c and prev_c > 0:
                rets.append((sb['close'][k] - prev_c) / prev_c * 100)
        prem[di] = float(np.mean(rets)) if rets else np.nan
    print(f"emotion done [{time.time()-t0:.1f}s]", flush=True)
    return info, cal, date_to_idx, stock_bars, bma, prem, is_lu, state


def build_signals(info, cal, stock_bars, bma, prem, is_lu, state, emotion_mode):
    """emotion_mode: 'v3'=全部用v3情绪过滤 / 'state'=牛off·震荡v3·熊strict"""
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
            # ---- 情绪过滤 ----
            if emotion_mode == 'state':
                thr = STATE_PREM_THR[state[di]]
                if thr is None:
                    pass  # 牛/预热: 放开
                elif bma[di] <= 0:
                    p = prem[di] if di < len(prem) else np.nan
                    if not np.isfinite(p) or p <= thr:
                        continue
            else:  # v3: EMOTION_ON=True 时 bma<=0 且 prem<=0 放弃
                if bma[di] <= 0:
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


def run_backtest(signals_by_day, cal, stock_bars, state, pos_mode):
    n_days = len(cal)
    cash = INIT_CAP
    positions = []
    equity_curve = []
    trades = []
    first_di = min(signals_by_day.keys()) if signals_by_day else n_days

    for di in range(first_di, n_days):
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

        if pos_mode == 'state':
            max_pos = STATE_POS[state[di]]
        else:
            max_pos = 3
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
                slot = INIT_CAP / 3 if pos_mode == 'v3' else cash / max_pos
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


def metrics(trades, equity_curve, label=''):
    if not trades:
        return {'label': label, 'trades': 0}
    total_ret = (equity_curve[-1][1] - INIT_CAP) / INIT_CAP * 100
    wins = [t for t in trades if t['net'] > 0]
    losses = [t for t in trades if t['net'] <= 0]
    win_rate = len(wins) / len(trades) * 100
    gross_win = sum(t['net'] for t in wins)
    gross_loss = abs(sum(t['net'] for t in losses))
    profit_factor = gross_win / gross_loss if gross_loss > 0 else 99.0
    avg_ret = np.mean([t['ret_pct'] for t in trades]) if trades else 0
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
        'label': label, 'trades': len(trades), 'total_ret': round(total_ret, 2),
        'annual': round(annual, 2), 'max_dd': round(max_dd, 2), 'win_rate': round(win_rate, 1),
        'profit_factor': round(profit_factor, 2), 'avg_ret': round(avg_ret, 2),
        'sharpe': round(sharpe, 2), 'calmar': round(calmar, 2),
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
            'trades': len(seg),
            'win_rate': round(len(wins) / len(seg) * 100, 1),
            'avg_ret': round(np.mean([t['ret_pct'] for t in seg]), 2),
            'sum_net': round(sum(t['net'] for t in seg), 0),
        }
    return out


def main():
    info, cal, _, stock_bars, bma, prem, is_lu, state = load_data()
    cfgs = [
        ('cfg0 基线(过滤v3×仓位v3)', 'v3', 'v3'),
        ('cfg1 只改过滤(state×v3)', 'state', 'v3'),
        ('cfg2 只改仓位(v3×state)', 'v3', 'state'),
        ('cfg3 v4原版(state×state)', 'state', 'state'),
    ]
    results = []
    for label, emode, pmode in cfgs:
        print(f"\n===== {label} =====", flush=True)
        sigs = build_signals(info, cal, stock_bars, bma, prem, is_lu, state, emode)
        print(f"  signal days: {len(sigs)}", flush=True)
        trades, eq = run_backtest(sigs, cal, stock_bars, state, pmode)
        m = metrics(trades, eq, label)
        print(f"  {m}", flush=True)
        seg = segment_stats(trades)
        print("  seg:", {k: f"{v.get('sum_net',0):+.0f}({v.get('trades',0)}笔)" for k, v in seg.items()}, flush=True)
        # 按买入日状态
        st_of_date = {cal[i]: state[i] for i in range(len(cal))}
        grp = defaultdict(list)
        for t in trades:
            grp[st_of_date.get(t['buy_date'], '?')].append(t)
        byst = {}
        for st in ['牛', '震荡', '熊']:
            rs = grp.get(st, [])
            if rs:
                wins = sum(1 for t in rs if t['net'] > 0)
                byst[st] = f"{len(rs)}笔{len(rs) and wins/len(rs)*100:.0f}%{sum(t['net'] for t in rs):+.0f}"
        print("  by_state:", byst, flush=True)
        results.append({'label': label, 'metrics': m, 'seg': seg, 'by_state': byst})

    print("\n\n================ 汇总对比 ================", flush=True)
    for r in results:
        m = r['metrics']
        print(f"{r['label']:28s} 笔数{m['trades']:4d} 收益{m['total_ret']:+8.2f}% 年化{m['annual']:+7.2f}% 回撤{m['max_dd']:6.2f}% 胜率{m['win_rate']:5.1f}% PF{m['profit_factor']:5.2f}", flush=True)


if __name__ == '__main__':
    main()
