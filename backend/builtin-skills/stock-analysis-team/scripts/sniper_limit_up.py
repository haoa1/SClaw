#!/usr/bin/env python3
"""
Sniper Limit-Up Stock Selection Engine
基于<狙击涨停板>(曹达) 选股策略
"""

import argparse
import json
import sys
import re
import time
from datetime import datetime, timedelta
from collections import defaultdict

import requests
import pandas as pd
import numpy as np

SESSION = requests.Session()
SESSION.trust_env = False
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn'}
NO_PROXY = {'http': '', 'https': ''}

CONFIG = {
    'target_market_cap_min': 3e8,
    'target_market_cap_max': 7e8,
    'max_price': 30,
    'limit_pool_size': 7,
}


def _get(url, params=None, timeout=15):
    return SESSION.get(url, params=params, timeout=timeout,
                       proxies=NO_PROXY, headers=HEADERS)


def safe_float(v, default=0.0):
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def safe_int(v, default=0):
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return default


# ============================
# 1. Market Sentiment Scanner
# ============================
def scan_market_sentiment(max_stocks=100):
    """Scan market sentiment: limit-up/down counts, sentiment score"""
    result = {
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'total_limit_up': 0,
        'total_limit_down': 0,
        'total_stocks': 0,
        'first_boards': 0,
        'consecutive_2': 0,
        'consecutive_3plus': 0,
        'limit_up_candidates': [],
        'sentiment_score': 0,
        'up_down_ratio': 0,
    }

    try:
        r = _get('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
                 params={'page': '1', 'num': str(max_stocks), 'sort': 'changepercent',
                         'asc': '0', 'node': 'hs_a', '_s_r_a': 'page'})
        stocks = json.loads(r.text)
        result['total_stocks'] = len(stocks)

        limit_up_stocks = []

        for s in stocks:
            change_pct = safe_float(s.get('changepercent', '0'))
            symbol = s.get('symbol', '')
            code = s.get('code', '')
            name = s.get('name', '')
            price = safe_float(s.get('trade', '0'))
            turnover = safe_float(s.get('turnoverratio', '0'))
            market_cap = safe_float(s.get('mktcap', '0')) * 1e4

            # Filter: skip ST/delisting stocks and new IPOs
            if any(kw in name for kw in ['退', 'ST', '*ST', 'SST', 'N']):
                continue
            if change_pct > 50:
                continue  # new IPO spike

            # Determine exchange-specific limit threshold
            if symbol.startswith('bj'):
                limit_threshold = 28.0  # BJ 30% limit
            elif symbol.startswith('sz') and (code.startswith('30') or code.startswith('00')):
                if code.startswith('30'):
                    limit_threshold = 19.0  # ChiNext 20% limit
                else:
                    limit_threshold = 9.5  # SZ main board 10% limit
            elif symbol.startswith('sh') and code.startswith('68'):
                limit_threshold = 19.0  # STAR 20% limit
            else:
                limit_threshold = 9.5  # Main board 10% limit

            if change_pct >= limit_threshold:
                result['total_limit_up'] += 1
                limit_up_stocks.append({
                    'symbol': symbol,
                    'code': code,
                    'name': name,
                    'price': price,
                    'change_pct': change_pct,
                    'turnover': turnover,
                    'market_cap': market_cap,
                })
            elif change_pct <= -limit_threshold:
                result['total_limit_down'] += 1

        result['limit_up_candidates'] = limit_up_stocks

        lu = result['total_limit_up']
        ld = result['total_limit_down']
        if lu >= 50:
            result['sentiment_score'] = 10
        elif lu >= 30:
            result['sentiment_score'] = 8
        elif lu >= 15:
            result['sentiment_score'] = 6
        elif lu >= 5:
            result['sentiment_score'] = 4
        elif lu > 0:
            result['sentiment_score'] = 2
        else:
            result['sentiment_score'] = 1

        if ld > 0:
            result['up_down_ratio'] = round(lu / ld, 2)
        else:
            result['up_down_ratio'] = lu if lu > 0 else 0

    except Exception as e:
        result['error'] = str(e)

    return result


# ============================
# 2. Board Count Detection
# ============================
def _tencent_kline(tq_code, days=30):
    """Get K-line data from Tencent API (works outside China)"""
    url = f'http://ifzq.gtimg.cn/appstock/app/fqkline/get?param={tq_code},day,,,{days},qfq'
    r = _get(url)
    data = r.json()
    
    # Tencent returns data.data.{code}.qfqday or day
    stock_data = data.get('data', {}).get(tq_code, {})
    klines = stock_data.get('qfqday') or stock_data.get('day', [])
    
    rows = []
    for k in klines:
        if len(k) >= 6:
            rows.append({
                'day': k[0],       # date string
                'open': safe_float(k[1]),
                'close': safe_float(k[2]),
                'high': safe_float(k[3]),
                'low': safe_float(k[4]),
                'volume': safe_int(k[5]),
            })
    return rows


def check_board_count(symbol):
    """Detect consecutive limit-up board count from K-line data (Tencent API)"""
    # Normalize symbol to Tencent format: sh603717, sz002559, bj920221
    raw_code = symbol
    for sfx in ['.SH', '.SZ', '.BJ', '.sh', '.sz', '.bj']:
        if symbol.upper().endswith(sfx):
            raw_code = symbol.replace(sfx, '').replace(sfx.lower(), '')
            break
    
    if raw_code.startswith('6'):
        tq_code = f'sh{raw_code}'
    elif raw_code.startswith(('0', '3')):
        tq_code = f'sz{raw_code}'
    elif raw_code.startswith(('8', '4', '92')):
        tq_code = f'bj{raw_code}'
    else:
        tq_code = f'sh{raw_code}'  # fallback

    try:
        rows = _tencent_kline(tq_code, days=30)
        if not rows:
            return {'board_count': 0, 'is_first_board': False, 'board_history': [], 'error': 'no data'}

        # Detect exchange for threshold
        is_chi_next = raw_code.startswith('30')  # 创业板 20%
        is_star = raw_code.startswith('68')       # 科创板 20%
        is_bj = raw_code.startswith(('8', '4', '92'))
        
        if is_chi_next or is_star:
            threshold = 19.0
        elif is_bj:
            threshold = 28.0
        else:
            threshold = 9.5

        board_count = 0
        boards = []

        for i, row in enumerate(rows):
            close = row['close']
            date = row['day'][:10]
            volume = row['volume']

            if i > 0:
                prev_close = rows[i-1]['close']
                if prev_close > 0:
                    pct = (close - prev_close) / prev_close * 100
                    if pct >= threshold:
                        board_count += 1
                        boards.append({
                            'date': date,
                            'close': round(close, 2),
                            'change': round(pct, 2),
                            'volume': volume,
                        })

        # Determine if today is a first board (only today's board, not yesterday)
        is_first_board = False
        if board_count >= 1 and len(boards) > 0:
            # If only 1 board found and it's today -> first board
            if board_count == 1:
                is_first_board = True
            elif len(rows) >= 3:
                # Check if yesterday was NOT a board but today IS
                yesterday_pct = (rows[-2]['close'] - rows[-3]['close']) / rows[-3]['close'] * 100 if rows[-3]['close'] > 0 else 0
                today_pct = (rows[-1]['close'] - rows[-2]['close']) / rows[-2]['close'] * 100 if rows[-2]['close'] > 0 else 0
                if today_pct >= threshold and yesterday_pct < threshold:
                    is_first_board = True

        return {
            'board_count': board_count,
            'is_first_board': is_first_board,
            'board_history': boards[-5:] if boards else [],
        }

    except Exception as e:
        return {'board_count': 0, 'is_first_board': False, 'error': str(e)}


# ============================
# 3. First Board Scoring
# ============================
def score_first_board(stock, board_info):
    """Score a limit-up stock based on sniper strategy criteria (0-10)"""
    score = 0
    details = {}

    price = stock.get('price', 0)
    market_cap = stock.get('market_cap', 0)
    turnover = stock.get('turnover', 0)
    change_pct = stock.get('change_pct', 0)
    board_count = board_info.get('board_count', 0)

    # (1) Market cap: 3-7亿 ideal
    cap = market_cap
    if 3e8 <= cap <= 7e8:
        score += 2
        details['circulation'] = 'ideal(3-7亿)'
    elif cap < 3e8:
        score += 1.5
        details['circulation'] = 'small'
    elif 7e8 < cap <= 15e8:
        score += 1
        details['circulation'] = 'mid(7-15亿)'
    elif 15e8 < cap <= 30e8:
        score += 0.5
        details['circulation'] = 'large(15-30亿)'
    else:
        details['circulation'] = 'out of range'

    # (2) Price: low price preferred
    if price < 10:
        score += 1
        details['price'] = 'low'
    elif price < 20:
        score += 1.5
        details['price'] = 'mid-low'
    elif price < 30:
        score += 1
        details['price'] = 'mid'
    elif price < 50:
        score += 0.5
        details['price'] = 'mid-high'
    else:
        details['price'] = 'high'

    # (3) Turnover rate
    if 5 <= turnover <= 20:
        score += 1
        details['turnover'] = f'moderate({turnover}%)'
    elif 20 < turnover <= 40:
        score += 0.5
        details['turnover'] = f'high({turnover}%)'
    elif turnover > 40:
        details['turnover'] = f'too high({turnover}%)'
    else:
        details['turnover'] = f'low({turnover}%)'

    # (4) Board type
    if board_info.get('is_first_board', False):
        score += 2
        details['board_type'] = 'first_board'
    elif board_count == 2:
        score += 1.5
        details['board_type'] = 'second_board'
    elif board_count >= 3:
        score += 1
        details['board_type'] = f'high_board({board_count})'

    # (5) Strength
    if change_pct >= 10:
        score += 1.5
        details['strength'] = 'yiziban'
    elif change_pct >= 9.8:
        score += 1
        details['strength'] = 'natural'

    return {
        'score': round(min(score, 10), 1),
        'max_score': 10,
        'details': details,
    }


# ============================
# 4. Dragon Head Scoring (7 dimensions)
# ============================
def dragon_head_scoring(stock, sentiment, board_info):
    """Score a stock as potential dragon head (0-21, 7 dimensions)"""
    score = 0
    analysis = {}

    price = stock.get('price', 0)
    market_cap = stock.get('market_cap', 0)
    change_pct = stock.get('change_pct', 0)
    board_count = board_info.get('board_count', 0)

    # 1. Regulatory (default neutral)
    analysis['regulatory'] = {'score': 1.5, 'note': 'need manual check'}
    score += 1.5

    # 2. Market sentiment
    s_score = sentiment.get('sentiment_score', 0)
    env_score = min(s_score / 5, 3)
    analysis['market_sentiment'] = {
        'score': round(env_score, 1),
        'limit_up_count': sentiment.get('total_limit_up', 0),
    }
    score += env_score

    # 3. Theme/sector
    theme_score = 1.5
    if change_pct >= 10 and sentiment.get('total_limit_up', 0) > 20:
        theme_score = 2.5
    elif change_pct >= 9.8:
        theme_score = 2.0
    analysis['theme'] = {'score': theme_score, 'note': 'sector check needed'}
    score += theme_score

    # 4. Dragon height
    if board_count >= 5:
        height_score = 3.0
    elif board_count == 4:
        height_score = 2.5
    elif board_count == 3:
        height_score = 2.0
    elif board_count == 2:
        height_score = 1.5
    elif board_count == 1:
        height_score = 1.0
    else:
        height_score = 0.5
    analysis['height'] = {'score': height_score, 'board_count': board_count}
    score += height_score

    # 5. K-line (default)
    kline_score = 1.5
    analysis['kline'] = {'score': kline_score, 'note': 'chart check needed'}
    score += kline_score

    # 6. Technical indicators (default)
    tech_score = 1.5
    analysis['technical'] = {'score': tech_score, 'note': 'tech analysis needed'}
    score += tech_score

    # 7. Intraday pattern (default)
    time_score = 1.5
    analysis['intraday'] = {'score': time_score, 'note': 'intraday check needed'}
    score += time_score

    total = 21
    pct = round(score / total * 100, 1)

    if pct >= 75:
        verdict = 'strong dragon candidate'
    elif pct >= 60:
        verdict = 'dragon candidate'
    elif pct >= 45:
        verdict = 'watch list'
    elif pct >= 30:
        verdict = 'observe'
    else:
        verdict = 'skip'

    return {
        'total_score': round(score, 1),
        'max_score': total,
        'percentage': pct,
        'verdict': verdict,
        'dimensions': analysis,
    }


# ============================
# 5. Position Sizing (Kelly + Shannon)
# ============================
def calculate_position(board_score, dragon_result=None, total_capital=100000):
    """Calculate position size using Kelly formula + Shannon entropy"""
    if dragon_result:
        pct = dragon_result.get('percentage', 50)
        base_win_rate = pct / 100
    else:
        base_win_rate = board_score / 10

    win_rate = min(0.5 + 0.25 + base_win_rate * 0.15, 0.95)
    lose_rate = 1 - win_rate

    board_count = 0
    if dragon_result and 'height' in dragon_result.get('dimensions', {}):
        board_count = dragon_result['dimensions']['height'].get('board_count', 0)

    if board_count >= 5:
        odds = 5.0
    elif board_count >= 3:
        odds = 3.0
    elif board_count >= 2:
        odds = 2.0
    elif board_count >= 1:
        odds = 1.5
    else:
        odds = 1.0

    kelly_f = (odds * win_rate - lose_rate) / odds
    kelly_f = max(0, min(kelly_f, 1))

    # Shannon: single position <= 1/3
    suggested_ratio = min(kelly_f, 1/3)
    suggested_amount = round(suggested_ratio * total_capital)

    if suggested_ratio >= 0.3:
        level = 'heavy (1/3)'
    elif suggested_ratio >= 0.2:
        level = 'medium (1/4-1/3)'
    elif suggested_ratio >= 0.1:
        level = 'light (1/10-1/6)'
    else:
        level = 'wait/test'

    return {
        'win_rate': round(win_rate, 3),
        'odds': odds,
        'kelly_fraction': round(kelly_f, 3),
        'suggested_ratio': round(suggested_ratio, 3),
        'suggested_amount': suggested_amount,
        'level': level,
    }


# ============================
# 6. Full Pipeline
# ============================
def run_full_pipeline(total_capital=100000):
    """Execute full stock selection pipeline"""
    result = {
        'strategy_name': 'sniper-limit-up',
        'book': 'Sniper Limit-Up (Cao Da)',
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'picks': [],
        'summary': {},
    }

    print('--- Step 1/5: Market Sentiment Scan ---')
    sentiment = scan_market_sentiment(100)
    print(f'  Limit-up: {sentiment["total_limit_up"]} | Limit-down: {sentiment["total_limit_down"]}')
    print(f'  Sentiment Score: {sentiment["sentiment_score"]}/10')
    result['market_sentiment'] = sentiment

    print('\n--- Step 2/5: Board Analysis ---')
    limit_up_stocks = sentiment.get('limit_up_candidates', [])

    enriched = []
    for s in limit_up_stocks:
        code = s['code']
        exchange = 'sh' if s['symbol'].startswith('sh') else ('sz' if s['symbol'].startswith('sz') else 'bj')
        std_symbol = f'{code}.{exchange.upper()}'

        board_info = check_board_count(std_symbol)
        fb_score = score_first_board(s, board_info)

        s['symbol_std'] = std_symbol
        s['board_info'] = board_info
        s['first_board_score'] = fb_score
        s['total_score'] = fb_score.get('score', 0)
        enriched.append(s)

    enriched.sort(key=lambda x: x.get('total_score', 0), reverse=True)
    print(f'  Total limit-up: {len(enriched)}')

    # Board stats
    from collections import Counter
    board_stats = Counter()
    for s in enriched:
        bc = s['board_info'].get('board_count', 0)
        board_stats[bc] += 1
    print(f'  Board distribution: {dict(board_stats)}')
    result['board_stats'] = dict(board_stats)

    # Step 3/4: Filter + Score
    top_picks = enriched[:CONFIG['limit_pool_size']]
    print(f'\n--- Step 3-4/5: Filter & Score ---')
    print(f'  Top {len(top_picks)} candidates:')

    picks = []
    for s in top_picks:
        dragon = dragon_head_scoring(s, sentiment, s['board_info'])
        pos = calculate_position(s['total_score'], dragon, total_capital)
        s['dragon_score'] = dragon
        s['position'] = pos
        picks.append(s)

        print(f'  {s.get("name","?"):>8} ({s.get("symbol_std","?"):>12}) '
              f'+{s.get("change_pct",0):>5.1f}% '
              f'Score:{s["total_score"]:.1f}/10 '
              f'Dragon:{dragon["percentage"]:.0f}% '
              f'Pos:{pos["level"]}')
        if s['board_info'].get('board_count', 0) > 0:
            boards = s['board_info'].get('board_history', [])
            if boards:
                dates = [b['date'][5:] for b in boards]
                print(f'         Boards: {dates}')

    result['picks'] = picks

    # Summary
    print(f'\n--- Step 5/5: Summary ---')
    s = sentiment['sentiment_score']
    if s <= 3:
        action = 'Sentiment cold, reduce position/wait'
    elif s <= 5:
        action = 'Sentiment mild, focus on first boards'
    elif s <= 7:
        action = 'Sentiment active, dragon head trading'
    else:
        action = 'Sentiment hot, take profit cautiously'

    result['summary'] = {
        'market_action': action,
        'sentiment_score': s,
        'top_picks_count': len(picks),
        'best_pick': f'{picks[0]["name"]}({picks[0]["symbol_std"]})' if picks else 'None',
        'position_rule': 'Shannon: single<=1/3, total<=2/3, cash>=1/3',
    }
    print(f'  {action}')
    if picks:
        print(f'  Best: {result["summary"]["best_pick"]}')

    return result


# ============================
# CLI
# ============================
def main():
    parser = argparse.ArgumentParser(description='Sniper Limit-Up Strategy Engine')
    parser.add_argument('--mode', choices=['scan', 'pipeline', 'stock'],
                       default='pipeline')
    parser.add_argument('--symbol', type=str, help='Stock symbol for single stock mode')
    parser.add_argument('--capital', type=float, default=100000,
                       help='Total capital (default: 100000)')
    parser.add_argument('--output', type=str, help='Output JSON file path')
    args = parser.parse_args()

    if args.mode == 'scan':
        result = scan_market_sentiment(200)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    elif args.mode == 'stock':
        if not args.symbol:
            print('Need --symbol')
            sys.exit(1)
        board_info = check_board_count(args.symbol)
        print(json.dumps(board_info, indent=2, ensure_ascii=False, default=str))

    elif args.mode == 'pipeline':
        result = run_full_pipeline(total_capital=args.capital)
        if args.output:
            with open(args.output, 'w') as f:
                json.dump(result, f, indent=2, ensure_ascii=False, default=str)
            print(f'\nSaved: {args.output}')


if __name__ == '__main__':
    main()
