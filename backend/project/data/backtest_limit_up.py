#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
缠论绿柱收敛爆款回调回测 (用户定制 v1.1.2 逻辑)
- 入场: 20日≥3连板 + 回调8~45% + MACD绿柱从峰值连续≥2天向0靠近、未翻红、|hist|≤0.5
- 买入: 信号当天收盘价 (2:30 买入)
- 卖出: 触发当天收盘价 (2:30)
  * 缠论止损: 收盘跌破绿柱见顶日最低价
  * 硬止损: -4%
  * 时间止损: 10个交易日
- 策略1(绿柱收敛版): 持有=hist逐根递增; 翻红后(B)继续持有直到柱值不再上升
- 策略2(红柱主升版): 翻红后红柱逐根比较,后一根>前一根才持有,≤前一根卖出
- 资金: 10000, 最多3仓, 按排名顺序买(先第1,余钱第2,再第3)
"""
import sqlite3, math, json
from collections import defaultdict
import pandas as pd
import numpy as np

DB = '/root/sclaw/data/stock_history.db'

def ema_arr(arr, p):
    r = np.empty(len(arr))
    m = 2.0 / (p + 1)
    r[0] = arr[0]
    for i in range(1, len(arr)):
        r[i] = (arr[i] - r[i-1]) * m + r[i-1]
    return r

def macd_hist(closes):
    closes = np.asarray(closes, dtype=float)
    ef = ema_arr(closes, 12)
    es = ema_arr(closes, 26)
    dif = ef - es
    dea = ema_arr(dif, 9)
    hist = 2 * (dif - dea)
    return hist

def is_limit_up(close, prev_close, code):
    if prev_close <= 0:
        return False
    is20 = code[:3] in ('300', '301', '688', '689')
    limit_pct = 19.5 if is20 else 9.8
    return (close - prev_close) / prev_close * 100 >= limit_pct

def find_signals(code, highs, lows, closes):
    """返回 [(j, score, maxStreak, pullback, chanStopPrice, entryPrice, luToday), ...]"""
    n = len(closes)
    if n < 60:
        return []
    lookback = 20
    min_streak = 3
    pull_min, pull_max = 8.0, 45.0
    shrink_days = 2
    near_zero = 0.5

    hist = macd_hist(closes)

    lu = [False] * n
    for i in range(1, n):
        lu[i] = is_limit_up(closes[i], closes[i-1], code)

    signals = []
    for j in range(60, n):
        start_idx = max(1, j + 1 - lookback)
        max_streak = 0
        cur = 0
        streak_end = -1
        for i in range(start_idx, j + 1):
            if lu[i]:
                cur += 1
                if cur > max_streak:
                    max_streak = cur
                    streak_end = i
            else:
                cur = 0
        if max_streak < min_streak or streak_end < 0:
            continue

        peak = closes[streak_end]
        for i in range(streak_end, j + 1):
            if highs[i] > peak:
                peak = highs[i]
        cur_price = closes[j]
        pullback = (peak - cur_price) / peak * 100 if peak > 0 else 0
        if pullback < pull_min or pullback > pull_max:
            continue

        seg_start = max(streak_end, j - 39)
        max_green_idx = -1
        max_green_val = 0.0
        for i in range(seg_start, j + 1):
            if hist[i] < max_green_val:
                max_green_val = hist[i]
                max_green_idx = i
        if max_green_idx < 0:
            continue

        cur_hist = hist[j]
        if cur_hist >= 0:
            continue
        if abs(cur_hist) > near_zero:
            continue

        shrink_count = 0
        clean = True
        for i in range(max_green_idx + 1, j + 1):
            if hist[i] >= 0:
                clean = False
                break
            if hist[i] > hist[i-1]:
                shrink_count += 1
            else:
                clean = False
                break
        if not clean:
            continue
        if shrink_count < shrink_days:
            continue

        shrink_ratio = abs((cur_hist - max_green_val) / max_green_val) if max_green_val != 0 else 0
        score = 40
        score += min(20, max_streak * 3)
        score += min(15, shrink_count * 4)
        score += min(15, round(shrink_ratio * 15))
        if max_streak >= 5:
            score += 5
        if cur_hist > -0.1:
            score += 5
        score = min(100, round(score))

        chan_stop = lows[max_green_idx]
        lu_today = lu[j]
        signals.append((j, score, max_streak, round(pullback, 1), chan_stop, closes[j], lu_today))

    return signals

# ---------------- 数据加载 ----------------
print("Loading data...", flush=True)
conn = sqlite3.connect(DB)
info_df = pd.read_sql("SELECT code, name, market FROM stock_info", conn)
daily_df = pd.read_sql("SELECT code, date, high, low, close FROM stock_daily", conn)
conn.close()

def is_stock_code(c):
    return c[:1] in ('0', '3', '6') and len(c) == 6

info_df = info_df[info_df['code'].apply(is_stock_code)]
info_df = info_df[~info_df['name'].str.contains('ST|退', na=False)]
valid_codes = set(info_df['code'].tolist())
daily_df = daily_df[daily_df['code'].isin(valid_codes)]

cal = sorted(daily_df['date'].unique())
date_to_idx = {d: i for i, d in enumerate(cal)}
n_days = len(cal)
print(f"Stocks: {len(valid_codes)}, Days: {n_days} ({cal[0]} ~ {cal[-1]})", flush=True)

name_map = info_df.set_index('code')['name'].to_dict()
stock_data = {}
for code, grp in daily_df.groupby('code'):
    grp = grp.sort_values('date')
    stock_data[code] = {
        'di': np.array([date_to_idx[d] for d in grp['date']]),
        'close': grp['close'].values.astype(float),
        'high': grp['high'].values.astype(float),
        'low': grp['low'].values.astype(float),
        'name': name_map.get(code, code)
    }
print(f"Loaded {len(stock_data)} stocks", flush=True)

# ---------------- 信号计算 ----------------
print("Computing signals...", flush=True)
all_signals = []
for code, sd in stock_data.items():
    sigs = find_signals(code, sd['high'], sd['low'], sd['close'])
    for (j, score, streak, pullback, chan_stop, entry_price, lu_today) in sigs:
        di = sd['di'][j]
        all_signals.append((di, code, sd['name'], score, streak, pullback, chan_stop, entry_price, lu_today))

all_signals.sort(key=lambda x: (x[0], -x[3]))
print(f"Total signals: {len(all_signals)}", flush=True)

signals_by_day = defaultdict(list)
for s in all_signals:
    signals_by_day[s[0]].append(s)

# ---------------- 回测引擎 ----------------
COST_COMMISSION = 0.00025
COST_MIN_COMMISSION = 5.0
COST_STAMP = 0.0005
COST_SLIPPAGE = 0.001
INIT_CASH = 10000.0
MAX_POS = 3
SLOT = INIT_CASH / MAX_POS
HARD_STOP = 0.04
TIME_STOP = 10

def buy_cost(amount):
    return max(COST_MIN_COMMISSION, amount * COST_COMMISSION) + amount * COST_SLIPPAGE

def sell_cost(amount):
    return max(COST_MIN_COMMISSION, amount * COST_COMMISSION) + amount * COST_STAMP + amount * COST_SLIPPAGE

def run_backtest(strategy):
    cash = INIT_CASH
    positions = []
    equity_curve = []
    trades = []
    first_signal_di = min(signals_by_day.keys()) if signals_by_day else n_days

    for di in range(first_signal_di, n_days):
        # 1) 卖出
        to_sell = []
        for pos in positions:
            code = pos['code']
            sd = stock_data[code]
            mask = np.where(sd['di'] == di)[0]
            if len(mask) == 0:
                continue
            k = mask[0]
            close = sd['close'][k]
            hist = macd_hist(sd['close'][:k+1])
            cur_hist = hist[-1]
            prev_hist = hist[-2] if len(hist) >= 2 else cur_hist
            days_held = di - pos['entry_di']

            reason = None
            if close < pos['chan_stop']:
                reason = 'chan_stop'
            elif close <= pos['hard_stop']:
                reason = 'hard_stop'
            elif days_held >= TIME_STOP:
                reason = 'time_stop'
            elif strategy == 1:
                if cur_hist <= prev_hist:
                    reason = 'hist_flat_or_down'
            elif strategy == 2:
                if pos['turned_red']:
                    if cur_hist <= prev_hist:
                        reason = 'red_flat_or_down'
                else:
                    if cur_hist >= 0:
                        pos['turned_red'] = True
            if reason:
                to_sell.append((pos, close, reason))
            else:
                pos['hist_last'] = cur_hist

        for pos, close, reason in to_sell:
            amount = pos['qty'] * close
            sell_val = amount - sell_cost(amount)
            cash += sell_val
            net = sell_val - pos['cost_basis']
            trades.append({
                'code': pos['code'], 'name': pos['name'],
                'buy_di': pos['entry_di'], 'buy_date': cal[pos['entry_di']],
                'buy_price': round(pos['entry_price'], 2),
                'sell_di': di, 'sell_date': cal[di],
                'sell_price': round(close, 2),
                'qty': pos['qty'],
                'hold_days': di - pos['entry_di'],
                'net_pnl': round(net, 2),
                'ret_pct': round(net / pos['cost_basis'] * 100, 2),
                'reason': reason
            })
            positions.remove(pos)

        # 2) 买入 (按排名)
        if di in signals_by_day:
            sigs = signals_by_day[di]
            held_codes = {p['code'] for p in positions}
            for sig in sigs:
                if len(positions) >= MAX_POS:
                    break
                di_s, code, name, score, streak, pullback, chan_stop, entry_price, lu_today = sig
                if code in held_codes:
                    continue
                if lu_today:
                    continue
                if cash < 1000:
                    break
                budget = min(cash, SLOT)
                qty = int(budget / entry_price / 100) * 100
                if qty <= 0:
                    continue
                amount = qty * entry_price
                cost = buy_cost(amount)
                if amount + cost > cash:
                    continue
                cash -= amount + cost
                pos = {
                    'code': code, 'name': name, 'qty': qty,
                    'entry_di': di_s, 'entry_price': entry_price,
                    'chan_stop': chan_stop, 'hard_stop': entry_price * (1 - HARD_STOP),
                    'hist_last': None, 'turned_red': False,
                    'cost_basis': amount + cost
                }
                positions.append(pos)
                held_codes.add(code)

        # 3) 净值
        mv = 0.0
        for p in positions:
            sd = stock_data[p['code']]
            mask = np.where(sd['di'] == di)[0]
            if len(mask):
                mv += p['qty'] * sd['close'][mask[0]]
            else:
                mv += p['qty'] * p['entry_price']
        equity_curve.append(cash + mv)

    # 清仓
    final_di = n_days - 1
    for pos in list(positions):
        code = pos['code']
        sd = stock_data[code]
        mask = np.where(sd['di'] <= final_di)[0]
        close = sd['close'][mask[-1]] if len(mask) else pos['entry_price']
        amount = pos['qty'] * close
        sell_val = amount - sell_cost(amount)
        cash += sell_val
        net = sell_val - pos['cost_basis']
        trades.append({
            'code': code, 'name': pos['name'],
            'buy_di': pos['entry_di'], 'buy_date': cal[pos['entry_di']],
            'buy_price': round(pos['entry_price'], 2),
            'sell_di': final_di, 'sell_date': cal[final_di],
            'sell_price': round(close, 2),
            'qty': pos['qty'],
            'hold_days': final_di - pos['entry_di'],
            'net_pnl': round(net, 2),
            'ret_pct': round(net / pos['cost_basis'] * 100, 2),
            'reason': 'end'
        })
    equity_curve.append(cash)

    return equity_curve, trades

def compute_metrics(equity_curve, trades, strategy_name):
    eq = np.array(equity_curve)
    final = eq[-1]
    total_ret = (final / INIT_CASH - 1) * 100
    first_di = min(signals_by_day.keys()) if signals_by_day else 0
    eq_dates_n = len(eq)
    years = eq_dates_n / 252
    cagr = ((final / INIT_CASH) ** (1 / years) - 1) * 100 if years > 0 and final > 0 else 0
    peak = np.maximum.accumulate(eq)
    dd = (eq - peak) / peak * 100
    max_dd = dd.min()
    wins = [t for t in trades if t['net_pnl'] > 0]
    losses = [t for t in trades if t['net_pnl'] <= 0]
    win_rate = len(wins) / len(trades) * 100 if trades else 0
    gross_win = sum(t['net_pnl'] for t in wins)
    gross_loss = abs(sum(t['net_pnl'] for t in losses))
    profit_factor = gross_win / gross_loss if gross_loss > 0 else float('inf')
    avg_hold = np.mean([t['hold_days'] for t in trades]) if trades else 0
    avg_ret = np.mean([t['ret_pct'] for t in trades]) if trades else 0
    by_year = {}
    for t in trades:
        y = t['buy_date'][:4]
        by_year.setdefault(y, {'n': 0, 'pnl': 0.0, 'win': 0})
        by_year[y]['n'] += 1
        by_year[y]['pnl'] += t['net_pnl']
        if t['net_pnl'] > 0:
            by_year[y]['win'] += 1

    print(f"\n===== {strategy_name} =====")
    print(f"最终净值: {final:.0f} | 总收益: {total_ret:.2f}% | 年化: {cagr:.2f}%")
    print(f"最大回撤: {max_dd:.2f}% | 交易次数: {len(trades)} | 胜率: {win_rate:.1f}%")
    print(f"盈亏比(profit factor): {profit_factor:.2f} | 平均持仓天数: {avg_hold:.1f} | 平均单笔收益: {avg_ret:.2f}%")
    print("分年度:")
    for y in sorted(by_year.keys()):
        d = by_year[y]
        wr = d['win'] / d['n'] * 100 if d['n'] else 0
        print(f"  {y}: {d['n']}笔 盈亏{d['pnl']:+.0f} 胜率{wr:.0f}%")
    return {'name': strategy_name, 'final': final, 'total_ret': total_ret, 'cagr': cagr,
            'max_dd': max_dd, 'trades': len(trades), 'win_rate': win_rate,
            'profit_factor': profit_factor, 'avg_hold': avg_hold, 'avg_ret': avg_ret,
            'by_year': by_year}

print("\n######## 策略1: 绿柱收敛版(翻红后B继续持有) ########", flush=True)
eq1, trades1 = run_backtest(1)
m1 = compute_metrics(eq1, trades1, "策略1 绿柱收敛版")

print("\n######## 策略2: 红柱主升版 ########", flush=True)
eq2, trades2 = run_backtest(2)
m2 = compute_metrics(eq2, trades2, "策略2 红柱主升版")

with open('/root/sclaw/backend/project/data/backtest_trades_s1.json', 'w') as f:
    json.dump(trades1, f, ensure_ascii=False, indent=1, default=json_default)
with open('/root/sclaw/backend/project/data/backtest_trades_s2.json', 'w') as f:
    json.dump(trades2, f, ensure_ascii=False, indent=1, default=json_default)

print("\nDone. 交易明细已保存: backtest_trades_s1.json / backtest_trades_s2.json")
