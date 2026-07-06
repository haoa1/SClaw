#!/usr/bin/env python3
"""Sniper Limit-Up Accelerated Simulator (Backtest + Simulated Trading)
   在历史数据上快速回测打板策略
"""
import json, time, sys, os
import requests
from datetime import datetime, timedelta
from collections import defaultdict

SESSION = requests.Session()
SESSION.trust_env = False
HEADERS = {'User-Agent': 'Mozilla/5.0'}
NO_PROXY = {'http': '', 'https': ''}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, '..', '..', '..'))

# Import scoring functions from the pipeline
sys.path.insert(0, SCRIPT_DIR)
from sniper_limit_up import safe_float, safe_int, score_first_board

DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
os.makedirs(DATA_DIR, exist_ok=True)

PORTFOLIO_FILE = os.path.join(DATA_DIR, 'simulated_portfolio.json')
TRADES_FILE = os.path.join(DATA_DIR, 'simulated_trades.json')

# Transaction costs (A-share market)
# 印花税: 0.05% sell-side only (减半后)
# 佣金: 万2.5 each way, min 5 RMB
# 过户费: 万0.1 each way
DEFAULT_COSTS = {
    'commission_rate': 0.00025,   # 万2.5
    'min_commission': 5.0,        # 最低5元
    'stamp_duty_rate': 0.0005,    # 0.05% sell only
    'transfer_fee_rate': 0.00001, # 万0.1
    'initial_capital': 10000.0,   # 本金1万
}

def _get(url, params=None, timeout=15):
    return SESSION.get(url, params=params, timeout=timeout,
                       proxies=NO_PROXY, headers=HEADERS)

def get_stock_list(max_pages=5):
    """Get all A-share stock list (paginate through both SH and SZ)"""
    all_stocks = []
    for node in ['hs_a', 'sh_a']:
        for page in range(1, max_pages + 1):
            try:
                r = _get('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
                         params={'page': str(page), 'num': '100', 'sort': 'code',
                                 'asc': '1', 'node': node})
                stocks = json.loads(r.text)
                if not stocks:
                    break
                all_stocks.extend(stocks)
                if len(stocks) < 100:
                    break
            except:
                break
    # Deduplicate by code
    seen = set()
    unique = []
    for s in all_stocks:
        c = s.get('code', '')
        if c not in seen:
            seen.add(c)
            unique.append(s)
    return unique

def get_klines(code, exchange='sh', days=500):
    """Get historical K-line data from Tencent API"""
    tq_code = f'{exchange}{code}'
    url = f'http://ifzq.gtimg.cn/appstock/app/fqkline/get?param={tq_code},day,,,{days},qfq'
    try:
        r = _get(url)
        data = r.json()
        stock_data = data.get('data', {}).get(tq_code, {})
        klines = stock_data.get('qfqday') or stock_data.get('day', [])
        
        rows = []
        for k in klines:
            if len(k) >= 6:
                rows.append({
                    'date': k[0][:10],
                    'open': safe_float(k[1]),
                    'close': safe_float(k[2]),
                    'high': safe_float(k[3]),
                    'low': safe_float(k[4]),
                    'volume': safe_int(k[5]),
                })
        return rows
    except Exception as e:
        return []

def detect_limit_ups(klines, threshold=9.5):
    """Find limit-up events in K-line data"""
    events = []
    for i, row in enumerate(klines):
        if i > 0:
            prev_close = klines[i-1]['close']
            if prev_close > 0:
                pct = (row['close'] - prev_close) / prev_close * 100
                if pct >= threshold:
                    # Next day data for exit
                    next_open = klines[i+1]['open'] if i+1 < len(klines) else None
                    next_close = klines[i+1]['close'] if i+1 < len(klines) else None
                    next_high = klines[i+1]['high'] if i+1 < len(klines) else None
                    next_low = klines[i+1]['low'] if i+1 < len(klines) else None
                    
                    events.append({
                        'entry_date': row['date'],
                        'entry_price': row['close'],
                        'change_pct': round(pct, 2),
                        'volume': row['volume'],
                        'next_open': next_open,
                        'next_close': next_close,
                        'next_high': next_high,
                        'next_low': next_low,
                    })
    return events

def calc_transaction_costs(buy_amount, sell_amount, costs=None):
    """Calculate A-share transaction costs for a round trip trade"""
    c = {**DEFAULT_COSTS, **(costs or {})}
    buy_commission = max(buy_amount * c['commission_rate'], c['min_commission'])
    buy_transfer = buy_amount * c['transfer_fee_rate']
    sell_commission = max(sell_amount * c['commission_rate'], c['min_commission'])
    sell_stamp = sell_amount * c['stamp_duty_rate']
    sell_transfer = sell_amount * c['transfer_fee_rate']
    total = buy_commission + buy_transfer + sell_commission + sell_stamp + sell_transfer
    return round(total, 2)

def calc_position_size(capital, entry_price):
    """Calculate how many shares to buy with given capital (100-share lots)"""
    if entry_price <= 0 or capital <= 0:
        return 0, 0.0
    # Min 1 lot (100 shares), max floor(capital / entry_price / 100) * 100
    shares = int(capital / entry_price / 100) * 100
    if shares < 100:
        return 0, 0.0  # Not enough to buy 1 lot
    cost = round(shares * entry_price, 2)
    return shares, cost

def calculate_trade_result(event, entry_strategy='close', exit_strategy='next_open',
                           include_costs=False, capital=None, costs=None):
    """
    Calculate trade P&L based on entry/exit rules
    entry_strategy: 'close' (buy at limit-up price)
    exit_strategy: 'next_open', 'next_close', 'next_high', 'next_low'
    include_costs: if True, subtract transaction costs and use position sizing
    capital: available capital for position sizing (used if include_costs)
    """
    entry = event['entry_price']
    
    if exit_strategy == 'next_open':
        exit_price = event['next_open']
    elif exit_strategy == 'next_close':
        exit_price = event['next_close']
    elif exit_strategy == 'next_high':
        exit_price = event['next_high']
    elif exit_strategy == 'next_low':
        exit_price = event['next_low']
    else:
        exit_price = event['next_open']
    
    if entry is None or exit_price is None or entry == 0:
        return None
    
    if include_costs and capital:
        c = {**DEFAULT_COSTS, **(costs or {})}
        shares, buy_cost = calc_position_size(capital, entry)
        if shares == 0:
            return {
                'entry_price': round(entry, 3),
                'exit_price': round(exit_price, 3),
                'pnl_pct': 0.0,
                'net_pnl_pct': 0.0,
                'win': False,
                'shares': 0,
                'buy_cost': 0.0,
                'sell_proceeds': 0.0,
                'costs': 0.0,
                'net_pnl': 0.0,
                'skipped': True,
                'skip_reason': 'insufficient capital for 1 lot',
            }
        
        sell_proceeds = round(shares * exit_price, 2)
        trade_costs = calc_transaction_costs(buy_cost, sell_proceeds, costs)
        net_pnl = round(sell_proceeds - buy_cost - trade_costs, 2)
        gross_pnl_pct = (sell_proceeds - buy_cost) / buy_cost * 100
        net_pnl_pct = round((sell_proceeds - buy_cost - trade_costs) / buy_cost * 100, 2)
        
        return {
            'entry_price': round(entry, 3),
            'exit_price': round(exit_price, 3),
            'shares': shares,
            'buy_cost': buy_cost,
            'sell_proceeds': sell_proceeds,
            'costs': trade_costs,
            'gross_pnl': round(sell_proceeds - buy_cost, 2),
            'net_pnl': net_pnl,
            'pnl_pct': round(gross_pnl_pct, 2),
            'net_pnl_pct': net_pnl_pct,
            'win': net_pnl > 0,
        }
    else:
        # Simple percentage calculation (no costs)
        pnl_pct = (exit_price - entry) / entry * 100
        return {
            'entry_price': round(entry, 3),
            'exit_price': round(exit_price, 3),
            'pnl_pct': round(pnl_pct, 2),
            'win': pnl_pct > 0,
        }

def simulate_portfolio(all_events, exit_strategy='next_open', costs=None):
    """
    Simulate a real portfolio: chronological trades with compounding
    Returns portfolio history and final stats
    """
    c = {**DEFAULT_COSTS, **(costs or {})}
    capital = c['initial_capital']
    
    # Sort events chronologically (oldest first)
    sorted_events = sorted(all_events, key=lambda e: e['entry_date'])
    
    portfolio = []
    skipped = 0
    total_costs_paid = 0.0
    
    for e in sorted_events:
        result = calculate_trade_result(e, exit_strategy=exit_strategy,
                                        include_costs=True, capital=capital, costs=costs)
        if result:
            e['trade'] = result
            if result.get('skipped'):
                skipped += 1
                continue
            
            capital += result['net_pnl']
            total_costs_paid += result.get('costs', 0)
            
            portfolio.append({
                'date': e['entry_date'],
                'code': e['code'],
                'name': e['name'],
                'entry_price': result['entry_price'],
                'exit_price': result['exit_price'],
                'shares': result['shares'],
                'buy_cost': result['buy_cost'],
                'sell_proceeds': result['sell_proceeds'],
                'costs': result['costs'],
                'net_pnl': result['net_pnl'],
                'net_pnl_pct': result['net_pnl_pct'],
                'balance': round(capital, 2),
            })
    
    initial = c['initial_capital']
    final_balance = round(capital, 2)
    total_return = round((final_balance - initial) / initial * 100, 2)
    
    # Calculate max drawdown
    peak = initial
    max_dd = 0.0
    for p in portfolio:
        if p['balance'] > peak:
            peak = p['balance']
        dd = (peak - p['balance']) / peak * 100
        if dd > max_dd:
            max_dd = round(dd, 2)
    
    net_pnls = [p['net_pnl_pct'] for p in portfolio]
    wins = [p for p in portfolio if p['net_pnl'] > 0]
    losses = [p for p in portfolio if p['net_pnl'] <= 0]
    
    return {
        'initial_capital': initial,
        'final_balance': final_balance,
        'total_return_pct': total_return,
        'total_pnl': round(final_balance - initial, 2),
        'total_trades': len(portfolio),
        'skipped_trades': skipped,
        'wins': len(wins),
        'losses': len(losses),
        'win_rate': round(len(wins) / len(portfolio) * 100, 1) if portfolio else 0,
        'avg_net_pnl': round(sum(net_pnls) / len(net_pnls), 2) if net_pnls else 0,
        'max_net_win': round(max(net_pnls), 2) if net_pnls else 0,
        'max_net_loss': round(min(net_pnls), 2) if net_pnls else 0,
        'total_costs': round(total_costs_paid, 2),
        'max_drawdown_pct': max_dd,
        'exit_strategy': exit_strategy,
        'costs_config': c,
        'monthly_pnl': None,
        'trades': portfolio,
    }

def run_simulation(stock_limit=50, exit_strategy='next_open', verbose=True,
                   portfolio_mode=False, costs=None):
    """
    Run accelerated simulation over historical data
    portfolio_mode: if True, simulate real portfolio with position sizing and costs
    """
    print(f"{'='*60}")
    if portfolio_mode:
        c = {**DEFAULT_COSTS, **(costs or {})}
        print(f"📊 狙击涨停板 - 实盘模拟 (本金{c['initial_capital']:.0f}元)")
    else:
        print(f"📊 狙击涨停板 - 加速模拟盘")
    print(f"{'='*60}")
    print(f"退出策略: {exit_strategy}")
    if portfolio_mode:
        print(f"交易成本: 佣金万2.5(最低5元) 印花税0.05% 过户费万0.1")
        print(f"初始本金: {c['initial_capital']:.0f}元")
    print(f"股票数量: {stock_limit}")
    print()
    
    # Step 1: Get stock list
    print("[1/4] 获取股票列表...")
    stocks = get_stock_list()
    
    filtered = []
    for s in stocks:
        name = s.get('name', '')
        symbol = s.get('symbol', '')
        if any(kw in name for kw in ['退', 'ST', '*ST']):
            continue
        if symbol.startswith('bj'):
            continue
        filtered.append(s)
    
    print(f"  全市场: {len(stocks)} → 过滤后: {len(filtered)}")
    
    if stock_limit < len(filtered):
        filtered = filtered[:stock_limit]
    
    # Step 2: Get K-line data
    print(f"[2/4] 获取K线数据 ({len(filtered)}只)...")
    
    all_events = []
    stock_count = 0
    total = len(filtered)
    start_time = time.time()
    
    for s in filtered:
        code = s['code']
        symbol = s['symbol']
        exchange = 'sh' if symbol.startswith('sh') else 'sz'
        
        klines = get_klines(code, exchange)
        if not klines:
            continue
        
        threshold = 19.0 if code.startswith('30') or code.startswith('68') else 9.5
        events = detect_limit_ups(klines, threshold)
        
        for e in events:
            e['code'] = code
            e['name'] = s.get('name', '')
            e['exchange'] = exchange
            result = calculate_trade_result(e, exit_strategy=exit_strategy)
            if result:
                e['trade'] = result
                all_events.append(e)
        
        stock_count += 1
        if stock_count % 20 == 0 and verbose:
            elapsed = time.time() - start_time
            rate = stock_count / elapsed if elapsed > 0 else 0
            print(f"  {stock_count}/{total} ({stock_count/total*100:.0f}%) - {rate:.1f} stocks/s - {len(all_events)} events")
    
    elapsed = time.time() - start_time
    print(f"  完成: {stock_count}只股票, {len(all_events)}个涨停事件, 耗时{elapsed:.1f}s")
    
    if portfolio_mode and all_events:
        print(f"\n[3/4] 模拟实盘交易...")
        portfolio = simulate_portfolio(all_events, exit_strategy=exit_strategy, costs=costs)
        
        print(f"\n[4/4] 实盘模拟结果")
        print(f"{'='*60}")
        p = portfolio
        print(f"💰 初始本金:  {p['initial_capital']:.0f}元")
        print(f"💰 最终资产:  {p['final_balance']:.2f}元")
        print(f"📈 总收益率:  {p['total_return_pct']:+.2f}%")
        print(f"📉 最大回撤:  {p['max_drawdown_pct']:.2f}%")
        print(f"📊 总盈亏:    {p['total_pnl']:+.2f}元")
        print(f"💸 总交易成本: {p['total_costs']:.2f}元")
        print(f"🎯 总交易:    {p['total_trades']}笔 (跳过{p['skipped_trades']}笔)")
        print(f"📋 胜率:      {p['win_rate']}% ({p['wins']}胜/{p['losses']}负)")
        print(f"📋 平均净盈:  每笔{p['avg_net_pnl']:+.2f}%")
        print(f"  最大单笔盈利: {p['max_net_win']:+.2f}%")
        print(f"  最大单笔亏损: {p['max_net_loss']:+.2f}%")
        
        if p['trades']:
            sorted_trades = sorted(p['trades'], key=lambda t: t['net_pnl_pct'])
            print()
            print("🔴 最差5笔:")
            for t in sorted_trades[:5]:
                print(f"  {t['date']} {t['name']}({t['code']}) {t['shares']}股 "
                      f"买{t['entry_price']:.2f}→卖{t['exit_price']:.2f} "
                      f"净利{t['net_pnl']:+.2f} ({t['net_pnl_pct']:+.2f}%)")
            print("🟢 最佳5笔:")
            for t in sorted_trades[-5:]:
                print(f"  {t['date']} {t['name']}({t['code']}) {t['shares']}股 "
                      f"买{t['entry_price']:.2f}→卖{t['exit_price']:.2f} "
                      f"净利{t['net_pnl']:+.2f} ({t['net_pnl_pct']:+.2f}%)")
            
            from collections import defaultdict
            monthly = defaultdict(list)
            for t in p['trades']:
                month = t['date'][:7]
                monthly[month].append(t['net_pnl'])
            print("\n📅 月度盈亏:")
            total_months = 0
            win_months = 0
            for m in sorted(monthly.keys()):
                pnls = monthly[m]
                month_total = sum(pnls)
                print(f"  {m}: {'+' if month_total >= 0 else ''}{month_total:.0f}元 ({len(pnls)}笔)")
                total_months += 1
                if month_total > 0:
                    win_months += 1
            print(f"  月度胜率: {win_months}/{total_months} ({win_months/total_months*100:.0f}%)")
        
        return portfolio
    else:
        print(f"\n[3/4] 分析结果...")
        return _analyze_events(all_events, exit_strategy, stock_count)

def _analyze_events(all_events, exit_strategy, stock_count):
    """Analyze collected trade events and print results"""
    wins = [e for e in all_events if e.get('trade', {}).get('win')]
    losses = [e for e in all_events if not e.get('trade', {}).get('win')]
    
    if all_events:
        pnls = [e['trade']['pnl_pct'] for e in all_events if e.get('trade')]
        avg_pnl = sum(pnls) / len(pnls) if pnls else 0
        
        stock_freq = defaultdict(int)
        for e in all_events:
            stock_freq[e['name']] += 1
        top_stocks = sorted(stock_freq.items(), key=lambda x: -x[1])[:10]
        
        monthly = defaultdict(list)
        for e in all_events:
            month = e['entry_date'][:7]
            t = e.get('trade', {})
            if t:
                monthly[month].append(t['pnl_pct'])
        
        monthly_stats = {}
        for m, pnls in sorted(monthly.items()):
            monthly_stats[m] = {
                'count': len(pnls),
                'avg': round(sum(pnls)/len(pnls), 2),
                'win_rate': round(len([p for p in pnls if p > 0]) / len(pnls) * 100, 1),
            }
        
        sorted_by_pnl = sorted(all_events, key=lambda e: e.get('trade', {}).get('pnl_pct', 0))
        worst_pnl = sorted_by_pnl[0]['trade']['pnl_pct'] if sorted_by_pnl else 0
        best_pnl = sorted_by_pnl[-1]['trade']['pnl_pct'] if sorted_by_pnl else 0
        
        results = {
            'total_events': len(all_events),
            'wins': len(wins),
            'losses': len(losses),
            'win_rate': round(len(wins) / len(all_events) * 100, 1) if all_events else 0,
            'avg_pnl': round(avg_pnl, 2),
            'max_win': round(best_pnl, 2),
            'max_loss': round(worst_pnl, 2),
            'exit_strategy': exit_strategy,
            'stock_count': stock_count,
            'date_range': f"{all_events[-1]['entry_date']} ~ {all_events[0]['entry_date']}" if all_events else '',
            'top_stocks': top_stocks[:5],
            'monthly': monthly_stats,
        }
    else:
        results = {'error': 'no events found'}
    
    print(f"\n[4/4] 结果")
    print(f"{'='*60}")
    
    if 'error' not in results:
        r = results
        print(f"总交易次数: {r['total_events']}")
        print(f"胜率: {r['win_rate']}% ({r['wins']}胜/{r['losses']}负)")
        print(f"平均盈亏: {r['avg_pnl']:+.2f}%")
        print(f"最大盈利: {r['max_win']:+.2f}%")
        print(f"最大亏损: {r['max_loss']:+.2f}%")
        print(f"数据区间: {r['date_range']}")
        print(f"退出策略: {r['exit_strategy']}")
        print()
        print("月度表现:")
        print(f"{'月份':<8} {'次数':<6} {'均值':<8} {'胜率':<6}")
        print("-"*30)
        for m, s in sorted(r.get('monthly', {}).items()):
            print(f"{m:<8} {s['count']:<6} {s['avg']:+.2f}%  {s['win_rate']}%")
        
        if all_events:
            sorted_events = sorted(all_events, key=lambda e: e.get('trade', {}).get('pnl_pct', 0))
            print()
            print("🔴 最差5笔交易:")
            for e in sorted_events[:5]:
                t = e.get('trade', {})
                print(f"  {e['entry_date']} {e['name']}({e['code']}) entry={t.get('entry_price','?'):.3f} -> {t.get('exit_price','?'):.3f} PnL={t.get('pnl_pct',0):+.2f}%")
            print("🟢 最佳5笔交易:")
            for e in sorted_events[-5:]:
                t = e.get('trade', {})
                print(f"  {e['entry_date']} {e['name']}({e['code']}) entry={t.get('entry_price','?'):.3f} -> {t.get('exit_price','?'):.3f} PnL={t.get('pnl_pct',0):+.2f}%")
            import random
            print("🎲 随机5笔:")
            for e in random.sample(all_events, min(5, len(all_events))):
                t = e.get('trade', {})
                print(f"  {e['entry_date']} {e['name']}({e['code']}) entry={t.get('entry_price','?'):.3f} -> {t.get('exit_price','?'):.3f} PnL={t.get('pnl_pct',0):+.2f}%")
        
        print()
        print("最频繁涨停股:")
        for name, count in r.get('top_stocks', []):
            print(f"  {name}: {count}次")
    
    return results

def save_results(results):
    """Save simulation results"""
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, 'backtest_result.json')
    with open(path, 'w') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\n结果已保存: {path}")
    return path

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Sniper Limit-Up Accelerated Simulator')
    parser.add_argument('--stocks', type=int, default=100, help='Number of stocks to simulate (default: 100)')
    parser.add_argument('--exit', choices=['next_open', 'next_close', 'next_high', 'next_low'],
                       default='next_open', help='Exit strategy')
    parser.add_argument('--save', action='store_true', help='Save results to file')
    parser.add_argument('--portfolio', action='store_true', help='Portfolio mode: simulate with costs and position sizing')
    parser.add_argument('--capital', type=float, default=10000.0, help='Initial capital for portfolio mode (default: 10000)')
    args = parser.parse_args()
    
    costs = None
    if args.portfolio:
        costs = {**DEFAULT_COSTS, 'initial_capital': args.capital}
    
    results = run_simulation(stock_limit=args.stocks, exit_strategy=args.exit,
                             portfolio_mode=args.portfolio, costs=costs)
    
    if args.save:
        save_results(results)
