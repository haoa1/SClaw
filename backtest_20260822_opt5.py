# -*- coding: utf-8 -*-
"""v5 — 卖出时机上移实验: 移动止盈 (从持仓期最高价回撤 X% 才卖) 替换 fade 卖出
变体: 回撤5% / 8% / 12% / 20% / 无fade(只靠 chan-stop+hard-stop+time-stop)
大盘过滤: close>MA200; 入场: 绿柱收敛+翻红确认; 硬止损 -5% 保留
"""
import sqlite3, json, sys, time, csv
from collections import defaultdict
import numpy as np

DB = '/root/sclaw/data/stock_history.db'
IDX_CSV = '/root/sclaw/data/index_sh000001.csv'
START, END = '2022-01-01', '2026-08-20'
INIT_CAP = 10000.0
MAX_POS = 3
TIME_STOP = 10
HARD_STOP_PCT = 0.05
ALLOC = [0.50, 0.30, 0.20]
LOT = 100
COMM_RATE, COMM_MIN = 0.00025, 5.0
STAMP = 0.0005
SLIP = 0.001
LOOKBACK, MIN_STREAK = 20, 3
PULL_MIN, PULL_MAX = 8.0, 45.0
SHRINK_DAYS, NEAR_ZERO = 2, 0.5
CONFIRM_MAX_DAYS = 10

def ema_arr(a, p):
    m = 2/(p+1); r = np.empty_like(a, dtype=float); r[0]=a[0]
    for i in range(1, len(a)): r[i] = (a[i]-r[i-1])*m + r[i-1]
    return r

def macd_hist(closes):
    c = np.asarray(closes, dtype=float)
    ef, es = ema_arr(c,12), ema_arr(c,26)
    dif = ef-es; dea = ema_arr(dif,9)
    return dif, dea, 2*(dif-dea)

def is_a(code):
    return len(code)==6 and code.startswith(('60','00','30','68'))

def rss_mb():
    with open('/proc/self/status') as f:
        for line in f:
            if line.startswith('VmRSS'):
                return int(line.split()[1])/1024
    return -1

dates_i, closes_i = [], []
with open(IDX_CSV) as f:
    for row in csv.DictReader(f):
        dates_i.append(row['date']); closes_i.append(float(row['close']))
closes_i = np.array(closes_i)
ma200 = np.full_like(closes_i, np.nan)
s = np.convolve(closes_i, np.ones(200)/200, mode='valid')
ma200[199:] = s
idx_allow = {d: (not np.isnan(m) and c > m) for d, c, m in zip(dates_i, closes_i, ma200)}
n_allow = sum(1 for v in idx_allow.values() if v)
print(f'index: {len(dates_i)} days, 可开仓={n_allow}天 ({n_allow/len(dates_i)*100:.0f}%)', flush=True)

t0 = time.time()
con = sqlite3.connect(DB)
info = dict(con.execute("SELECT code,name FROM stock_info").fetchall())

signals = defaultdict(list)
stock_meta = {}

def process_stock(code, bars):
    if not is_a(code): return
    nm = info.get(code, '')
    if nm.startswith(('ST','*ST','退')): return
    if len(bars) < 70: return
    dates = [b[0] for b in bars]
    o = np.array([b[1] for b in bars], float)
    h = np.array([b[2] for b in bars], float)
    l = np.array([b[3] for b in bars], float)
    c = np.array([b[4] for b in bars], float)
    dif, dea, hist = macd_hist(c)
    n = len(dates)
    is20 = code.startswith(('300','301','688','689'))
    limit_pct = 19.5 if is20 else 9.8
    lu = np.zeros(n, bool)
    lu[1:] = (c[:-1] > 0) & ((c[1:]-c[:-1])/c[:-1]*100 >= limit_pct)
    runs = np.zeros(n, int)
    for j in range(1, n):
        runs[j] = runs[j-1]+1 if lu[j] else 0
    cand = {}
    for i in range(max(60, LOOKBACK), n):
        hi = hist[i]
        if hi >= 0 or abs(hi) > NEAR_ZERO: continue
        w0 = max(1, i-LOOKBACK+1)
        max_streak = 0; streak_end = -1
        for j in range(w0, i+1):
            eff = runs[j] if runs[j] <= j-w0+1 else j-w0+1
            if lu[j] and eff > max_streak:
                max_streak = eff; streak_end = j
        if max_streak < MIN_STREAK or streak_end < 0: continue
        peak = float(h[streak_end:i+1].max())
        if peak <= 0: continue
        pull = (peak - c[i])/peak*100
        if pull < PULL_MIN or pull > PULL_MAX: continue
        seg0 = max(streak_end, i-39)
        seg = hist[seg0:i+1]
        mg_idx = seg0 + int(np.argmin(seg))
        mg_val = float(hist[mg_idx])
        if mg_idx >= i: continue
        clean = True
        for k in range(mg_idx+1, i+1):
            if hist[k] >= 0 or hist[k] <= hist[k-1]:
                clean = False; break
        if not clean: continue
        shrink_count = i - mg_idx
        if shrink_count < SHRINK_DAYS: continue
        k = i + 1
        while k < n and hist[k] < 0:
            k += 1
        if k >= n: continue
        if k - i > CONFIRM_MAX_DAYS: continue
        stop_chan = float(l[streak_end:k+1].min())
        if k not in cand or True:
            cand[k] = (score_for(streak_end, mg_idx, mg_val, hist[i], shrink_count), stop_chan)
    if cand:
        stock_meta[code] = dict(dates=dates, idx={d:i for i,d in enumerate(dates)},
            o=o, h=h, l=l, c=c, hist=hist, lu=lu, is20=is20, limit_pct=limit_pct)
        for k, (score, stop_chan) in cand.items():
            signals[dates[k]].append((code, score, stop_chan))

def score_for(streak_end, mg_idx, mg_val, cur_hist, shrink_count):
    max_streak = min(20, 3)  # placeholder
    return 50

cur = con.execute(
    "SELECT code,date,open,high,low,close FROM stock_daily WHERE date>=? AND date<=? ORDER BY code,date",
    (START, END))
cur_code = None; bars = []
n_stocks = 0; n_kept = 0
for row in cur:
    code = row[0]
    if code != cur_code:
        if cur_code is not None and bars:
            n_stocks += 1
            process_stock(cur_code, bars)
            if cur_code in stock_meta: n_kept += 1
        cur_code = code; bars = []
    bars.append(row[1:])
if cur_code is not None and bars:
    n_stocks += 1
    process_stock(cur_code, bars)
    if cur_code in stock_meta: n_kept += 1
print(f'loaded: {n_stocks} stocks, kept_meta={n_kept}, signals={sum(len(v) for v in signals.values())}, RSS={rss_mb():.0f}MB, {time.time()-t0:.0f}s', flush=True)

all_dates = sorted(signals.keys())
print('signal dates:', len(all_dates))
if not all_dates:
    print('NO SIGNALS'); sys.exit(1)

def run_backtest(trail_pct):
    """trail_pct: 移动止盈回撤百分比; None=不用fade/移动止盈, 只靠chan/hard/time stop"""
    cash = INIT_CAP; positions = []
    equity = []; trades = []
    for gidx, date in enumerate(all_dates):
        for pos in list(positions):
            meta = stock_meta[pos['code']]
            i = meta['idx'].get(date)
            days = gidx - pos['entry_gidx']
            if i is None:
                continue
            cur_close = float(meta['c'][i])
            pos['peak'] = max(pos['peak'], cur_close)
            sell_reason = None; raw_price = None
            if trail_pct is not None:
                # 移动止盈: 从持仓期最高收盘价回撤 trail_pct 才卖
                if pos['peak'] > 0 and cur_close <= pos['peak'] * (1 - trail_pct/100):
                    sell_reason, raw_price = f'trail-{trail_pct}%', cur_close
            if sell_reason is None:
                if cur_close < pos['stop_chan']:
                    sell_reason, raw_price = 'chan-stop', cur_close
            if sell_reason is None:
                stop_price = pos['entry_price'] * (1 - HARD_STOP_PCT)
                if float(meta['l'][i]) <= stop_price:
                    oprice = float(meta['o'][i])
                    raw_price = stop_price if oprice >= stop_price else oprice
                    sell_reason = 'hard-stop'
            if sell_reason is None and days >= TIME_STOP:
                sell_reason, raw_price = 'time-stop', cur_close
            if sell_reason is not None:
                sell_price = raw_price * (1 - SLIP)
                gross = pos['qty'] * sell_price
                fee = max(gross*COMM_RATE, COMM_MIN) + gross*STAMP
                proceeds = gross - fee
                cash += proceeds
                pnl = proceeds - pos['alloc']
                trades.append(dict(code=pos['code'], name=info.get(pos['code'],''), entry_date=pos['entry_date'],
                    exit_date=date, entry_price=round(pos['entry_price'],2), exit_price=round(raw_price,2),
                    qty=pos['qty'], days=days, reason=sell_reason, pnl=round(pnl,2), ret=round(pnl/pos['alloc']*100,2)))
                positions.remove(pos)
        if len(positions) < MAX_POS and date in signals and idx_allow.get(date, False):
            sigs = sorted(signals[date], key=lambda x: -x[1])
            held = {p['code'] for p in positions}
            rank = 0
            for code, score, stop_chan in sigs:
                if len(positions) >= MAX_POS: break
                if code in held: continue
                meta = stock_meta[code]
                i = meta['idx'][date]
                if i > 0 and meta['lu'][i]:
                    continue
                alloc = INIT_CAP * ALLOC[min(rank, len(ALLOC)-1)]
                if cash <= 0: break
                buy_price = float(meta['c'][i]) * (1 + SLIP)
                max_sh = int(cash / (buy_price*(1+COMM_RATE)) // LOT * LOT)
                sh = int(min(max_sh, alloc / (buy_price*(1+COMM_RATE)) // LOT * LOT))
                if sh <= 0: continue
                cost = sh * buy_price
                fee = max(cost*COMM_RATE, COMM_MIN)
                if cost + fee > cash:
                    sh = int(cash/(buy_price*(1+COMM_RATE)) // LOT * LOT)
                    if sh <= 0: continue
                    cost = sh * buy_price; fee = max(cost*COMM_RATE, COMM_MIN)
                cash -= (cost + fee)
                positions.append(dict(code=code, qty=sh, entry_price=float(meta['c'][i]), entry_date=date,
                    entry_gidx=gidx, stop_chan=stop_chan, alloc=cost+fee, peak=float(meta['c'][i])))
                held.add(code); rank += 1
        mv = sum(p['qty'] * stock_meta[p['code']]['c'][stock_meta[p['code']]['idx'].get(date, stock_meta[p['code']]['idx'][p['entry_date']])] for p in positions)
        equity.append(cash + mv)
    for pos in list(positions):
        meta = stock_meta[pos['code']]
        last_i = len(meta['c'])-1
        raw_price = float(meta['c'][last_i])
        sell_price = raw_price * (1-SLIP); gross = pos['qty']*sell_price
        fee = max(gross*COMM_RATE, COMM_MIN) + gross*STAMP
        cash += gross - fee
        pnl = (gross-fee) - pos['alloc']
        trades.append(dict(code=pos['code'], name=info.get(pos['code'],''), entry_date=pos['entry_date'],
            exit_date=meta['dates'][last_i], entry_price=round(pos['entry_price'],2), exit_price=round(raw_price,2),
            qty=pos['qty'], days=gidx-pos['entry_gidx'], reason='end-of-test', pnl=round(pnl,2), ret=round(pnl/pos['alloc']*100,2)))
        positions.remove(pos)
    final = cash
    eq = np.array(equity)
    peak_eq = np.maximum.accumulate(eq)
    mdd = float(((eq-peak_eq)/peak_eq).min()*100) if len(eq) else 0
    total_ret = (final/INIT_CAP-1)*100
    import datetime
    d0, d1 = all_dates[0], all_dates[-1]
    try:
        days = (datetime.date.fromisoformat(d1)-datetime.date.fromisoformat(d0)).days
    except: days = 365
    years = max(days/365.0, 0.01)
    ann = ((final/INIT_CAP)**(1/years)-1)*100 if final>0 else -100
    wins = [t for t in trades if t['pnl']>0]; losses=[t for t in trades if t['pnl']<=0]
    win_rate = len(wins)/len(trades)*100 if trades else 0
    avg_win = sum(t['pnl'] for t in wins)/len(wins) if wins else 0
    avg_loss = sum(t['pnl'] for t in losses)/len(losses) if losses else 0
    avg_days = sum(t['days'] for t in trades)/len(trades) if trades else 0
    reasons = defaultdict(int)
    for t in trades: reasons[t['reason']]+=1
    return dict(final=round(final,2), total_ret=round(total_ret,2), annual=round(ann,2),
        max_dd=round(mdd,2), trades=len(trades), win_rate=round(win_rate,1), avg_win=round(avg_win,2),
        avg_loss=round(avg_loss,2), avg_days=round(avg_days,1), reasons=dict(reasons), trades_list=trades)

print(f"\n{'卖出规则':<14}{'总收益%':<10}{'年化%':<9}{'回撤%':<9}{'笔数':<7}{'胜率%':<8}{'均盈':<9}{'均亏':<9}{'均持天':<8}")
results = {}
for name, tp in [('trail-5%',5), ('trail-8%',8), ('trail-12%',12), ('trail-20%',20), ('无fade仅止损',None)]:
    r = run_backtest(tp)
    results[name] = r
    print(f"{name:<14}{r['total_ret']:<10.2f}{r['annual']:<9.2f}{r['max_dd']:<9.2f}{r['trades']:<7}{r['win_rate']:<8.1f}{r['avg_win']:<9.1f}{r['avg_loss']:<9.1f}{r['avg_days']:<8.1f}")
    print(f"   reasons: {r['reasons']}")
with open('/root/sclaw/data/backtest_20260822_result_v5.json','w') as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print(f'saved v5. total {time.time()-t0:.0f}s, peak RSS={rss_mb():.0f}MB')
