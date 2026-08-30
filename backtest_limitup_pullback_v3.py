#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backtest_limitup_pullback_v3.py — 涨停缩量回调策略 · 情绪状态机版
============================================================
v3 新增 (2026-08-23, 基于 v2 +108.57% 调优):
  情绪状态机: 当 5日市场breadth均线(bma5) <= 0 (弱势环境) 时,
             额外要求 昨日涨停股今日平均涨幅 > 0 (打板情绪不亏钱才做多);
             当 bma5 > 0 (强势环境) 时, 不做溢价过滤, 让利润奔跑。
  效果: 2025-26震荡段亏损 -3594 → -2039 (减半), 其他盈利段基本不受损,
        全局 +10252 → +11362 (+11%), 且牛市段不再被误杀(一刀切prem会伤牛市)。
  教训: 统一情绪过滤会误伤牛市段; 环境依赖(状态机)过滤才是正解。

v2 基线 (2026-08-22, +108.57% / 年化18.8% / 回撤28.3% / pf1.46):
  信号:   涨停日(D0) → 之后3天不破D0低点、第3天缩量(vr<1.0)、且非连续涨停 → 第3天收盘买入
  市场:   仅当 5日全市场中位涨跌幅(breath)均线 > -0.5% 才允许买入 (周期过滤, 熊市空仓)
  止损:   跌破 max(D0低点, 买入价×0.91) 离场
  止盈:   新高(≥买入价×1.05)后收盘回撤15% → 移动止盈离场
  时间:   持有满40天离场
  仓位:   最多同时3只, 每只 1/3 仓位, 100股整数倍

用法:
  python3 backtest_limitup_pullback_v3.py          # 全量回测 + 分段统计
  python3 backtest_limitup_pullback_v3.py signal   # 只输出今日信号股

调优历程 (v1→v9):
  1. 短止盈截断赢家 → 改 15% 移动止盈(回撤触发) 让利润奔跑
  2. 时间止损太短 → 40天 (25%以上单靠时间出场仍盈利)
  3. 熊市强做 → 5日市场breadth(全市场中位涨跌幅)>-0.5% 过滤 (胜负手)
  4. 追高限制(dist) 试过 → 反而砍掉大赢家, 不采用
  v10-v12: 情绪网格(bma×溢价×炸板率) 60组合 + 环境依赖状态机 7变体
"""
import sqlite3
import sys
import time
from collections import defaultdict, Counter

import numpy as np

DB = '/root/sclaw/data/stock_history.db'
INIT_CAP = 10000.0
MAX_POS = 3
LOT = 100
COMM_RATE, COMM_MIN = 0.00025, 5.0
STAMP = 0.0005
SLIP = 0.001

# ---- 最终参数 ----
BUY_DAY = 3          # D0后第N天买入
SHRINK_RATIO = 1.0   # 第N天量比 < 1.0 (缩量)
BREADTH_MA = 5       # 市场breadth均线周期
BREADTH_THR = -0.5   # breadth均线阈值(%)
TRAIL_PCT = 15       # 移动止盈回撤幅度(%)
STOP_PCT = 9         # 硬止损距入场价(%)
MAX_HOLD = 40        # 最大持有天数
# ---- v3 情绪状态机 ----
EMOTION_ON = True    # True=启用: bma<=0时要求昨日涨停股今日溢价>0

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

    # ---- 市场 breadth (全市场中位涨跌幅) ----
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

    # ---- 情绪: 昨日涨停股今日平均涨幅 (买入日收盘可知, 无未来函数) ----
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
    prem = np.full(n_days, np.nan)   # prem[di] = 昨日(di-1)涨停股今日(di)平均涨幅
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
    return info, cal, date_to_idx, stock_bars, bma, prem, is_lu


def build_signals(info, cal, stock_bars, bma, prem, is_lu):
    """返回 dict: di -> [(di, code, name, score, d0_low, entry)]"""
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
            # v3 情绪状态机: 弱势环境(bma<=0)且情绪低迷(昨日涨停股今日平均亏损) → 放弃
            if EMOTION_ON and bma[di] <= 0:
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


def run_backtest(signals_by_day, cal, stock_bars):
    n_days = len(cal)
    cash = INIT_CAP
    positions = []
    equity_curve = []
    trades = []
    slot = INIT_CAP / MAX_POS
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
    info, cal, _, stock_bars, bma, prem, is_lu = load_data()
    print("Building signals...", flush=True)
    sigs = build_signals(info, cal, stock_bars, bma, prem, is_lu)
    print(f"Signal days: {len(sigs)}", flush=True)

    if len(sys.argv) > 1 and sys.argv[1] == 'signal':
        # 输出最近3个交易日的信号股
        from datetime import datetime
        today = datetime.now().strftime('%Y-%m-%d')
        keys = sorted(sigs.keys())
        recent = [k for k in keys if cal[k] >= (datetime.now() - __import__('datetime').timedelta(days=7)).strftime('%Y-%m-%d')]
        if not recent and keys:
            recent = keys[-3:]
        print(f"\n== 最近信号 (截至 {cal[keys[-1]] if keys else '无'}) ==", flush=True)
        for k in recent:
            print(f"\n{cal[k]} ({len(sigs[k])}只):", flush=True)
            for s in sigs[k][:10]:
                print(f"  {s[1]} {s[2]} score={s[3]} 买入价≈{s[5]:.2f} (D0低点 {s[4]:.2f})", flush=True)
        return

    print("Running backtest...", flush=True)
    trades, eq = run_backtest(sigs, cal, stock_bars)
    m = metrics(trades, eq, 'FINAL')
    print("\n========== 最终结果 ==========", flush=True)
    print(m, flush=True)
    print("\n-- 分段 --", flush=True)
    for k, v in segment_stats(trades).items():
        print("  {}: {}".format(k, v), flush=True)
    print("\n-- 卖出原因 --", flush=True)
    print("  {}".format(dict(Counter(t['reason'] for t in trades))), flush=True)
    print("\n-- 盈利 TOP5 --", flush=True)
    for t in sorted(trades, key=lambda x: -x['net'])[:5]:
        print("  {} {} 买{} 卖{} +{}元 ({}%) {}".format(t['code'], t['name'], t['buy_date'], t['sell_date'], t['net'], t['ret_pct'], t['reason']), flush=True)
    print("-- 亏损 TOP5 --", flush=True)
    for t in sorted(trades, key=lambda x: x['net'])[:5]:
        print("  {} {} 买{} 卖{} {}元 ({}%) {}".format(t['code'], t['name'], t['buy_date'], t['sell_date'], t['net'], t['ret_pct'], t['reason']), flush=True)
    import csv
    with open('/root/sclaw/data/bt_limitup_best_trades.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['code', 'name', 'buy_date', 'sell_date', 'buy_price', 'sell_price', 'qty', 'hold_days', 'net', 'ret_pct', 'reason'])
        w.writeheader()
        for t in trades:
            w.writerow(t)
    print("\n交易已保存 -> /root/sclaw/data/bt_limitup_best_trades.csv ({}笔)".format(len(trades)), flush=True)


if __name__ == '__main__':
    main()
