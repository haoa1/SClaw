#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
涨停缩量回调策略回测 (用户定制 2026-08-22)
策略:
  D0 : 一根阳线涨停10% (仅主板, 排除20%板)
  回调: D1..Dk 不破D0最低点, 买入日成交量 < D0成交量×shrinkRatio (缩量)
  买入: 第k天 (buyDay∈{2,3}) 尾盘价(收盘)买入
  止损: 收盘跌破D0最低点 -> 当日收盘卖 (破大阳就走)
  止盈: 盘中触及 入场×(1+takeProfit%) -> 按止盈价卖
  时间止损: 持股 maxHoldDays 天 -> 收盘无条件卖
资金: 10000, 最多3仓, 按排名依次买入 (先第1余钱第2再第3)
成本: 佣金万2.5最低5元 + 印花税0.05% + 滑点0.1%
区间: 2022-04-20 ~ 2026-08-20, 分阶段统计, 重点看熊市
"""
import sqlite3, json, time, sys, csv, gc
from collections import defaultdict
import numpy as np
import pandas as pd

DB = '/root/sclaw/data/stock_history.db'
START, END = '2022-04-20', '2026-08-20'
INIT_CAP = 10000.0
MAX_POS = 3
LOT = 100
COMM_RATE, COMM_MIN = 0.00025, 5.0
STAMP = 0.0005
SLIP = 0.001

# 默认参数 (可调, 也是优化对象)
DEF_BUY_DAY = 3
DEF_TAKE_PROFIT = 12.0
DEF_MAX_HOLD = 3
DEF_SHRINK = 1.0

# ---------------- 数据加载 (内存优化: 逐股索引查询, 避免全表1.8G加载) ----------------
t0 = time.time()
print("Loading data (streaming per-stock)...", flush=True)
conn = sqlite3.connect(DB)
info = dict(conn.execute("SELECT code,name FROM stock_info").fetchall())

def is_mainboard(c):
    return c.startswith(('60', '00')) and len(c) == 6

codes = sorted({c for c in info if is_mainboard(c) and not info[c].startswith(('ST', '*ST', '退'))})
cal = [r[0] for r in conn.execute("SELECT DISTINCT date FROM stock_daily ORDER BY date")]
date_to_idx = {d: i for i, d in enumerate(cal)}
n_days = len(cal)
print(f"Main-board stocks: {len(codes)}, Days: {n_days} ({cal[0]}~{cal[-1]})  [{time.time()-t0:.1f}s]", flush=True)

def is_lu(close, prev_close):
    if prev_close <= 0:
        return False
    return (close - prev_close) / prev_close * 100 >= 9.8

# 预计算每只股票的 bar 索引与数组 (逐股查询, 内存峰值 ~单股)
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
        'di': di,
        'open': arr[:, 0],
        'high': arr[:, 1],
        'low': arr[:, 2],
        'close': arr[:, 3],
        'vol': arr[:, 4],
    }
conn.close()
print(f"Loaded {len(stock_bars)} stocks [{time.time()-t0:.1f}s]", flush=True)

# ---------------- 信号检测 ----------------
def build_signal_rows(code, sb):
    """对每个涨停日i (D0), 预计算 D1..D3 的走势特征"""
    o, h, l, c, v = sb['open'], sb['high'], sb['low'], sb['close'], sb['vol']
    n = len(c)
    rows = []
    lu_idx = []
    for i in range(1, n):
        if is_lu(c[i], c[i-1]) and c[i] > o[i]:
            lu_idx.append(i)
    for i in lu_idx:
        if i + 3 >= n:
            continue
        d0_low = l[i]
        d0_close = c[i]
        d0_vol = v[i]
        min_low_2 = min(l[i+1], l[i+2])
        min_low_3 = min(l[i+1], l[i+2], l[i+3])
        vr2 = v[i+2] / d0_vol if d0_vol > 0 else 9.9
        vr3 = v[i+3] / d0_vol if d0_vol > 0 else 9.9
        lu_b2 = is_lu(c[i+2], c[i+1])
        lu_b3 = is_lu(c[i+3], c[i+2])
        rows.append({
            'i': i, 'd0_low': d0_low, 'd0_close': d0_close, 'd0_vol': d0_vol,
            'min_low_2': min_low_2, 'min_low_3': min_low_3,
            'vr2': vr2, 'vr3': vr3, 'lu_b2': lu_b2, 'lu_b3': lu_b3,
            'buy2_idx': i+2, 'buy3_idx': i+3,
            'c2': c[i+2], 'c3': c[i+3], 'o_i': o[i],
        })
    return rows

print("Precomputing limit-up rows...", flush=True)
all_d0 = {}
for code, sb in stock_bars.items():
    rows = build_signal_rows(code, sb)
    if rows:
        all_d0[code] = rows
print(f"Stocks with limit-up days: {len(all_d0)} [{time.time()-t0:.1f}s]", flush=True)

# ---------------- 信号生成(按参数) ----------------
def gen_signals(buy_day, shrink_ratio):
    sig_by_day = defaultdict(list)
    for code, rows in all_d0.items():
        name = info.get(code, code)
        for r in rows:
            if buy_day == 2:
                if r['min_low_2'] < r['d0_low']:
                    continue
                if r['vr2'] >= shrink_ratio:
                    continue
                if r['lu_b2']:
                    continue
                buy_idx, vr, entry = r['buy2_idx'], r['vr2'], r['c2']
            else:
                if r['min_low_3'] < r['d0_low']:
                    continue
                if r['vr3'] >= shrink_ratio:
                    continue
                if r['lu_b3']:
                    continue
                buy_idx, vr, entry = r['buy3_idx'], r['vr3'], r['c3']
            score = 50
            if vr < 0.6: score += 15
            elif vr < 0.8: score += 10
            elif vr < 1.0: score += 5
            if r['d0_close'] / r['o_i'] > 1.06: score += 10
            if entry > r['d0_low'] * 1.05: score += 10
            score = min(100, int(score))
            di = stock_bars[code]['di'][buy_idx]
            sig_by_day[di].append((di, code, name, score, r['d0_low'], entry))
    out = {}
    for di, lst in sig_by_day.items():
        best = {}
        for s in lst:
            if s[1] not in best or s[3] > best[s[1]][3]:
                best[s[1]] = s
        out[di] = sorted(best.values(), key=lambda x: -x[3])
    return out

# ---------------- 成本 ----------------
def buy_cost(amount):
    return max(COMM_MIN, amount * COMM_RATE) + amount * SLIP

def sell_cost(amount):
    return max(COMM_MIN, amount * COMM_RATE) + amount * STAMP + amount * SLIP

# ---------------- 回测引擎 ----------------
def run_backtest(signals_by_day, take_profit, max_hold):
    cash = INIT_CAP
    positions = []
    equity_curve = []
    trades = []
    slot = INIT_CAP / MAX_POS
    first_di = min(signals_by_day.keys()) if signals_by_day else n_days

    for di in range(first_di, n_days):
        to_sell = []
        for pos in positions:
            code = pos['code']
            sb = stock_bars[code]
            mask = np.where(sb['di'] == di)[0]
            if len(mask) == 0:
                continue
            k = mask[0]
            high, close = sb['high'][k], sb['close'][k]
            days_held = di - pos['entry_di']
            tp_price = pos['entry_price'] * (1 + take_profit / 100)
            reason = None
            sell_price = None
            if high >= tp_price:
                reason = 'take_profit'
                sell_price = tp_price
            elif close < pos['d0_low']:
                reason = 'stop_loss'
                sell_price = close
            elif days_held >= max_hold:
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
                'buy_date': cal[pos['entry_di']],
                'sell_date': cal[di],
                'buy_price': round(pos['entry_price'], 2),
                'sell_price': round(sell_price, 2),
                'qty': pos['qty'],
                'hold_days': di - pos['entry_di'],
                'net': round(net, 2),
                'ret_pct': round(net / pos['cost_basis'] * 100, 2),
                'reason': reason,
                'entry_di': pos['entry_di'],
            })
            positions.remove(pos)

        if di in signals_by_day:
            held = {p['code'] for p in positions}
            for sig in signals_by_day[di]:
                if len(positions) >= MAX_POS:
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
                    'cost_basis': amount + cost,
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

# ---------------- 指标 ----------------
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
    avg_hold = np.mean([t['hold_days'] for t in trades]) if trades else 0
    eq = np.array([e for _, e in equity_curve], float)
    peak = np.maximum.accumulate(eq)
    dd = (peak - eq) / peak
    max_dd = float(np.max(dd)) * 100 if len(dd) else 0
    rets = np.diff(eq) / eq[:-1]
    sharpe = float(np.mean(rets) / np.std(rets) * np.sqrt(252)) if len(rets) > 1 and np.std(rets) > 0 else 0
    calmar = total_ret / max_dd if max_dd > 0 else (total_ret if total_ret > 0 else 0)
    years = len(equity_curve) / 244
    annual = ((1 + total_ret / 100) ** (1 / years) - 1) * 100 if years > 0 else 0
    return {
        'label': label,
        'trades': len(trades), 'total_ret': round(total_ret, 2), 'annual': round(annual, 2),
        'max_dd': round(max_dd, 2), 'win_rate': round(win_rate, 1),
        'profit_factor': round(profit_factor, 2), 'avg_ret': round(avg_ret, 2),
        'avg_hold': round(avg_hold, 1), 'sharpe': round(sharpe, 2), 'calmar': round(calmar, 2),
    }

SEGMENTS = [
    ('2022熊市', '2022-04-20', '2022-12-31'),
    ('2023震荡', '2023-01-01', '2023-12-31'),
    ('2024初股灾', '2024-01-01', '2024-02-29'),
    ('2024修复', '2024-03-01', '2024-08-31'),
    ('2024-25牛市', '2024-09-01', '2025-08-31'),
    ('2025-26震荡', '2025-09-01', '2026-08-20'),
]

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

# ---------------- 主流程 ----------------
def run_config(buy_day, take_profit, max_hold, shrink):
    sigs = gen_signals(buy_day, shrink)
    trades, eq = run_backtest(sigs, take_profit, max_hold)
    return trades, eq

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'baseline'
    if mode == 'baseline':
        print("\n========== BASELINE (默认参数) ==========", flush=True)
        print(f"buyDay={DEF_BUY_DAY} takeProfit={DEF_TAKE_PROFIT}% maxHold={DEF_MAX_HOLD} shrink={DEF_SHRINK}", flush=True)
        trades, eq = run_config(DEF_BUY_DAY, DEF_TAKE_PROFIT, DEF_MAX_HOLD, DEF_SHRINK)
        m = metrics(trades, eq)
        print(json.dumps(m, ensure_ascii=False, indent=2), flush=True)
        print("\n-- 分阶段 --", flush=True)
        for k, v in segment_stats(trades).items():
            print(f"  {k}: {v}", flush=True)
        with open('/root/sclaw/data/bt_limitup_baseline_trades.csv', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=['code','name','buy_date','sell_date','buy_price','sell_price','qty','hold_days','net','ret_pct','reason','entry_di'])
            w.writeheader()
            w.writerows(trades)
        print(f"\nTrades saved: {len(trades)}", flush=True)
    elif mode == 'grid':
        print("\n========== GRID SEARCH ==========", flush=True)
        results = []
        grid_t0 = time.time()
        configs = []
        for bd in (2, 3):
            for tp in (8, 10, 12, 15):
                for mh in (2, 3, 4):
                    for sr in (0.8, 1.0, 1.2):
                        configs.append((bd, tp, mh, sr))
        print(f"Total configs: {len(configs)}", flush=True)
        for idx, (bd, tp, mh, sr) in enumerate(configs):
            trades, eq = run_config(bd, tp, mh, sr)
            m = metrics(trades, eq, f"bd{bd}_tp{tp}_mh{mh}_sr{sr}")
            results.append(((bd, tp, mh, sr), m, trades, eq))
            print(f"[{idx+1}/{len(configs)}] {m['label']}: ret={m['total_ret']}% dd={m['max_dd']}% win={m['win_rate']}% n={m['trades']} calmar={m['calmar']}", flush=True)
        print(f"\nGrid done in {time.time()-grid_t0:.1f}s", flush=True)
        results.sort(key=lambda x: -x[1]['calmar'])
        print("\n========== TOP 10 (按卡玛比率) ==========", flush=True)
        for cfg, m, _, _ in results[:10]:
            print(f"  {m['label']}: ret={m['total_ret']}% ann={m['annual']}% dd={m['max_dd']}% win={m['win_rate']}% pf={m['profit_factor']} sharpe={m['sharpe']} calmar={m['calmar']} n={m['trades']}", flush=True)
        best = results[0]
        print("\n========== 最优参数 ==========", flush=True)
        bd, tp, mh, sr = best[0]
        print(f"  buyDay={bd} takeProfit={tp}% maxHold={mh} shrink={sr}", flush=True)
        print(f"  metrics: {json.dumps({k: v for k, v in best[1].items() if k != 'label'}, ensure_ascii=False)}", flush=True)
        print("\n-- 最优分阶段 --", flush=True)
        for k, v in segment_stats(best[2]).items():
            print(f"  {k}: {v}", flush=True)
        with open('/root/sclaw/data/bt_limitup_best_trades.csv', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=['code','name','buy_date','sell_date','buy_price','sell_price','qty','hold_days','net','ret_pct','reason','entry_di'])
            w.writeheader()
            w.writerows(best[2])
        print(f"\nBest trades saved: {len(best[2])}", flush=True)
