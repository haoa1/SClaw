#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""daily_replay.py — 全市场日线快速回放 (4年/1055交易日, 全市场5500+只)
用 stock_daily 近似打板策略:
  买入: 当日盘中涨停(非一字, open<close)且换手<5%且≤2连板, 当日≤5只, 单票20%现金, 买入价=收盘涨停价
  卖出: 次日开盘价×0.98 (C3规则), 佣金0.025%min5 + 印花税0.05%
近似说明: 日线无法知道首封时间, 以"非一字涨停"近似10:30前可买(偏乐观);
         一字板(open=close)买不进排除; ST(5%板)/北交所(30%板)被涨停阈值天然排除。
用法: python3 daily_replay.py [--start 2022-04-20] [--end 2026-08-24] [--capital 10000]
      [--max-per-day 5] [--min-open-ratio 0.0]  # min-open-ratio=开盘价/涨停价下限, 0=任意盘中封板, 0.99=接近一字
"""
import sqlite3, argparse, time
from collections import defaultdict

DB = '/root/sclaw/data/stock_history.db'
M5_DB = '/root/sclaw/data/stock_5m.db'

def rate_of(code):
    """板块涨停幅度: 创业板(30)/科创(688/689)=20%, 北交所(8/4)=30%, 主板=10%"""
    if code.startswith(("30", "300", "301", "302", "688", "689")):
        return 0.20
    if code.startswith(("8", "4", "920")):
        return 0.30
    return 0.10

def is_limit_up(cp):
    """涨停判定: 10%板(cp 9.8~10.5) 或 20%板(19.8~21.0); ST(5%)/北交所(30%)/新股首日天然排除"""
    return (9.8 <= cp <= 10.5) or (19.8 <= cp <= 21.0)

def first_seal_time(m5c, code, date, limit_up, eps=0.005):
    """用真实 5m 数据定位首次封板时间 (close>=limit_up-eps)。返回 'HH:MM' 或 None。
    与 seal_report.py 口径一致。"""
    row = m5c.execute(
        "SELECT datetime, close FROM stock_kline_5m WHERE code=? AND substr(datetime,1,10)=? AND close>=? ORDER BY datetime LIMIT 1",
        (code, date, limit_up - eps)).fetchone()
    if row is None:
        return None
    return row[0][11:16]

def compute_limit_up(close, cp, rate):
    """从当日收盘价+涨跌幅 反推涨停价: pre_close=close/(1+cp/100), limit_up=round(pre*(1+rate),2)"""
    if cp <= -99:
        return round(close, 2)
    pre = close / (1 + cp / 100.0)
    return round(pre * (1 + rate), 2)

def replay(start, end, capital, max_per_day, min_open_ratio, verbose=False,
           use_5m=False, cutoff="15:00"):
    t0 = time.time()
    conn = sqlite3.connect(DB)
    c = conn.cursor()
    m5c = None
    m5_dates = set()
    if use_5m:
        m5c = sqlite3.connect(M5_DB).cursor()
        m5_dates = {r[0] for r in m5c.execute("SELECT DISTINCT substr(datetime,1,10) FROM stock_kline_5m")}
    # 按 date 查询需要 date 索引 (主键是 code,date)
    c.execute("CREATE INDEX IF NOT EXISTS idx_daily_date ON stock_daily(date)")
    conn.commit()
    dates = [r[0] for r in c.execute(
        "SELECT DISTINCT date FROM stock_daily WHERE date>=? AND date<=? ORDER BY date", (start, end))]
    mode = f"5m首封≤{cutoff}" if use_5m else "日线非一字近似"
    print(f"回放 {len(dates)} 个交易日 ({dates[0]} ~ {dates[-1]}), 初始资金 {capital}, 买入模式: {mode}")

    cash = float(capital)
    holdings = {}          # code -> {qty, buy_price, cost, buy_date, boards}
    trades = []            # dict(date, code, side, price, qty, pnl)
    up_state = {}          # code -> 连续涨停数 (截至前一交易日)
    daily_equity = []
    day_buys = defaultdict(int)

    for di, date in enumerate(dates):
        # ===== 1. 卖出: 持仓在当日开盘 ×0.98 =====
        if holdings:
            placeholders = ','.join('?' * len(holdings))
            rows = c.execute(
                f"SELECT code,open FROM stock_daily WHERE date=? AND code IN ({placeholders})",
                [date] + list(holdings.keys())).fetchall()
            for code, op in rows:
                h = holdings.pop(code)
                sell_p = op * 0.98
                amt = sell_p * h['qty']
                fee = max(amt * 0.00025, 5.0) + amt * 0.0005   # 佣金+印花税
                cash += amt - fee
                pnl = (amt - fee) - h['cost']
                trades.append(dict(date=date, code=code, side='sell', price=round(sell_p, 3),
                                   qty=h['qty'], pnl=round(pnl, 2), boards=h['boards'],
                                   days=(di - h['day'])))
                if verbose: print(f"  S {date} {code} 卖{sell_p} qty{h['qty']} pnl{pnl:+.0f}")

        # ===== 2. 买入: 非一字涨停 + 换手<5% + ≤2连板 =====
        rows = c.execute(
            """SELECT code,open,high,low,close,change_pct,turnover_rate FROM stock_daily
               WHERE date=? AND ((change_pct>=9.8 AND change_pct<=10.5) OR (change_pct>=19.8 AND change_pct<=21.0))
                 AND open<close AND turnover_rate<5.0 ORDER BY turnover_rate""", (date,)).fetchall()
        candidates = []
        for r in rows:
            code, open_, close, cp, tr = r[0], r[1], r[4], r[5], r[6]
            if min_open_ratio > 0 and open_ < close * min_open_ratio:
                continue  # 开盘未接近涨停 → 可能下午才封板, 排除
            boards = up_state.get(code, 0) + 1
            if boards > 2:
                continue
            # ---- 5m 真实首封时间过滤 (替换"非一字"近似) ----
            if use_5m:
                if date not in m5_dates:
                    pass  # 5m 未覆盖该日 → 回退日线近似
                else:
                    limit_up = compute_limit_up(close, cp, rate_of(code))
                    st = first_seal_time(m5c, code, date, limit_up)
                    if st is None:
                        continue  # 5m 覆盖但该股无首封 → 排除
                    if cutoff != "15:00" and st > cutoff:
                        continue  # 首封时间晚于 cutoff → 排除
            candidates.append((code, open_, close, boards, tr))
        for code, open_, close, boards, tr in candidates[:max_per_day]:
            if cash < close * 100 + 5:
                continue
            qty = int((cash * 0.2) / (close * 100)) * 100
            if qty < 100:
                continue
            amt = qty * close
            fee = max(amt * 0.00025, 5.0)
            if cash < amt + fee:
                qty = int((cash - 5) / (close * 100)) * 100
                if qty < 100: continue
                amt = qty * close; fee = max(amt * 0.00025, 5.0)
            cash -= amt + fee
            holdings[code] = dict(qty=qty, buy_price=close, cost=amt + fee,
                                  buy_date=date, boards=boards, day=di)
            day_buys[date] += 1
            trades.append(dict(date=date, code=code, side='buy', price=close,
                               qty=qty, pnl=0, boards=boards))
            if verbose: print(f"  B {date} {code} 买{close} qty{qty} 板{boards} 换手{tr}%")

        # ===== 3. 日终估值 =====
        mv = 0.0
        if holdings:
            placeholders = ','.join('?' * len(holdings))
            rows = c.execute(
                f"SELECT code,close FROM stock_daily WHERE date=? AND code IN ({placeholders})",
                [date] + list(holdings.keys())).fetchall()
            for code, cl in rows:
                mv += holdings[code]['qty'] * cl
        daily_equity.append((date, round(cash + mv, 2)))

        # ===== 4. 更新连板状态 =====
        up_state = {r[0]: up_state.get(r[0], 0) + 1 for r in rows}

    # ===== 期末挂起持仓: 按最后收盘价估值 =====
    for code, h in holdings.items():
        row = c.execute("SELECT close FROM stock_daily WHERE code=? AND date<=? ORDER BY date DESC LIMIT 1",
                        (code, end)).fetchone()
        val = h['qty'] * (row[0] if row else h['buy_price'])
        pnl = val - h['cost']
        trades.append(dict(date=end, code=code, side='hold', price=round(val / h['qty'], 3),
                           qty=h['qty'], pnl=round(pnl, 2), boards=h['boards'], days=-1))
    conn.close()

    # ===== 统计 =====
    sells = [t for t in trades if t['side'] == 'sell']
    holds = [t for t in trades if t['side'] == 'hold']
    n_buy = sum(1 for t in trades if t['side'] == 'buy')
    wins = [t for t in sells if t['pnl'] > 0]
    losses = [t for t in sells if t['pnl'] <= 0]
    total_pnl = sum(t['pnl'] for t in sells) + sum(t['pnl'] for t in holds)
    final = daily_equity[-1][1] if daily_equity else capital
    years = len(dates) / 244.0
    ann = (final / capital) ** (1 / years) - 1 if final > 0 and years > 0 else 0
    # 最大回撤
    peak, mdd = capital, 0.0
    for _, eq in daily_equity:
        peak = max(peak, eq)
        mdd = max(mdd, (peak - eq) / peak)
    avg_win = sum(t['pnl'] for t in wins) / len(wins) if wins else 0
    avg_loss = sum(t['pnl'] for t in losses) / len(losses) if losses else 0
    hold_days = [t['days'] for t in sells if t['days'] > 0]

    print("=" * 62)
    print(f"期间: {dates[0]} ~ {dates[-1]}  ({len(dates)} 交易日, {years:.1f} 年)")
    print(f"参数: 单日≤{max_per_day}只, 开盘≥涨停价×{min_open_ratio}, 换手<5%, ≤2连板, 20%仓位, 次日开盘×0.98")
    print("=" * 62)
    print(f"初始资金      : {capital:>12,.0f}")
    print(f"期末总资产    : {final:>12,.0f}  ({final/capital:+.1%})")
    print(f"年化收益率    : {ann:>12.1%}")
    print(f"最大回撤      : {mdd:>12.1%}")
    print(f"买入笔数      : {n_buy:>12}")
    print(f"卖出笔数      : {len(sells):>12}   (期末挂起 {len(holds)})")
    print(f"胜率          : {len(wins)/len(sells):>12.1%}  ({len(wins)}胜/{len(losses)}负)")
    print(f"平均盈利/亏损 : {avg_win:>8.0f} / {avg_loss:+.0f}")
    print(f"盈亏比        : {abs(avg_win/avg_loss) if avg_loss else 0:>12.2f}")
    if hold_days:
        print(f"平均持仓天数  : {sum(hold_days)/len(hold_days):>12.1f}")
    print(f"期末总盈亏    : {total_pnl:>12,.0f}")
    # 年度分解
    yearly = defaultdict(lambda: [0, 0.0])
    for t in sells:
        y = t['date'][:4]
        yearly[y][0] += 1
        yearly[y][1] += t['pnl']
    print("年度分解(卖出的已实现盈亏):")
    for y in sorted(yearly):
        print(f"  {y}: {yearly[y][0]:>4}笔  {yearly[y][1]:>+10,.0f}")
    return dict(final=final, ann=ann, mdd=mdd, n_buy=n_buy, n_sell=len(sells),
                winrate=len(wins)/len(sells) if sells else 0, total_pnl=total_pnl,
                trades=trades, daily_equity=daily_equity)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2022-04-20')
    ap.add_argument('--end', default='2026-08-24')
    ap.add_argument('--capital', type=float, default=10000)
    ap.add_argument('--max-per-day', type=int, default=5)
    ap.add_argument('--min-open-ratio', type=float, default=0.0,
                    help='开盘价≥涨停价×ratio 才买入 (0=任意盘中封板, 0.99≈早盘秒板)')
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--use-5m', action='store_true',
                    help='用真实5m首封时间过滤买入 (需 --start/--end 落在5m窗口 08-03~08-26)')
    ap.add_argument('--cutoff', default='15:00',
                    help='首封时间≤cutoff 才买入 (如 10:30)。默认15:00=不限。需配合 --use-5m')
    args = ap.parse_args()
    if args.use_5m:
        # 保持 start/end 默认但提示只在5m窗口有效
        if args.cutoff == '15:00':
            print("提示: --use-5m 但未设 --cutoff, 仅要求5m可定位首封, 不限制时间")
    replay(args.start, args.end, args.capital, args.max_per_day, args.min_open_ratio, args.verbose,
           use_5m=args.use_5m, cutoff=args.cutoff)
