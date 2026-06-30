#!/usr/bin/env python3
"""
A-Share Market Data Fetcher (bridge script)
=============================================
Replacement for stock-analysis-team's market_data_fetcher.py
Uses Sina/腾讯 Finance APIs for A-share data (bypassing EastMoney proxy issues)
+ ta library for technical indicators

Output format matches the original market_data_fetcher.py JSON schema
so stock-analysis-team's analysis pipeline works seamlessly.

Data sources:
  - Real-time quote:  Tencent qt.gtimg.cn
  - Real-time detail: Sina hq.sinajs.cn
  - Historical K-line: Sina CN_MarketData.getKLineData
  - US stocks: yfinance (passthrough)
"""

import argparse
import json
import sys
import re
from datetime import datetime, timedelta

import requests
import pandas as pd
import numpy as np
import ta

# ============================================================
# API helpers (no proxy)
# ============================================================

SESSION = requests.Session()
SESSION.trust_env = False


def _sina_headers():
    return {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn'}


def _get(url, params=None, timeout=15):
    """GET with no proxy, no SSL fuss."""
    return SESSION.get(url, params=params, timeout=timeout,
                       proxies={'http': '', 'https': ''},
                       headers=_sina_headers())


# ============================================================
# Parse Tencent real-time quote
# ============================================================

def parse_tencent_quote(symbol):
    """Fetch and parse Tencent qt.gtimg.cn real-time quote."""
    code_map = {'SH': 'sh', 'SZ': 'sz'}
    prefix = 'sh'
    raw_code = symbol
    for sfx, p in code_map.items():
        if symbol.endswith('.' + sfx):
            raw_code = symbol.replace('.' + sfx, '')
            prefix = p
            break

    url = f"https://qt.gtimg.cn/q={prefix}{raw_code}"
    r = _get(url)
    # Parse: v_sh600519="1~贵州茅台~600519~1291.91~1279.00~...~"
    m = re.search(r'"(.*?)"', r.text)
    if not m:
        return None

    fields = m.group(1).split('~')
    if len(fields) < 40:
        return None

    # Tencent field mapping: https://www.qt.org/wiki/
    # 0:market, 1:name, 2:code, 3:price, 4:last_close, 5:open, 6:volume(手)
    # 7:buy_vol, 8:sell_vol, 9:bid1_price, 10:bid1_vol, ...
    # 28:date, 29:time
    # 30:change, 31:change_pct, 32:high, 33:low
    # 35:amount(万), 36:turnover_rate, 37:pe, 38:amplitude
    # 39:market_cap, 40:total_market_cap, ...
    # 44:pb

    def f(i, default='0'):
        return fields[i] if i < len(fields) and fields[i] else default

    name = f(1)
    price = float(f(3))
    last_close = float(f(4))
    high = float(f(33, '0'))
    low = float(f(34, '0'))
    open_p = float(f(5, '0'))
    volume = int(float(f(6, '0')) * 100)  # 手 -> 股
    change = float(f(31, '0'))
    change_pct = float(f(32, '0'))
    turnover_rate = float(f(38, '0'))
    pe = float(f(39, '0'))
    pb = float(f(46, '0'))
    amplitude = float(f(43, '0'))
    market_cap = float(f(44, '0')) if f(44, '0') else 0  # 亿
    total_market_cap = float(f(45, '0')) if len(fields) > 45 and fields[45] else 0

    result = {
        'symbol': symbol,
        'company_name': name,
        'current_price': round(price, 2),
        'price_change': round(change, 2),
        'price_change_pct': round(change_pct, 2),
        'open': round(open_p, 2),
        'high': round(high, 2),
        'low': round(low, 2),
        'volume': int(volume),
        'amount': round(float(f(57, '0')) * 10000, 2) if f(57, '0') else 0,
        'turnover_rate': turnover_rate,
        'amplitude': amplitude,
        'pe_ratio': pe,
        'pb_ratio': pb,
        'market_cap': market_cap * 1e8,  # 亿 -> 元
        'total_market_cap': total_market_cap * 1e8,
        'high_52w': 0,  # not available from Tencent
        'low_52w': 0,
    }
    return result


# ============================================================
# Fetch historical K-line (Sina API)
# ============================================================

def fetch_hist_kline(symbol, datalen=365):
    """Fetch daily K-line from Sina API."""
    code_map = {'SH': 'sh', 'SZ': 'sz'}
    prefix = 'sh'
    raw_code = symbol
    for sfx, p in code_map.items():
        if sfx in symbol:
            raw_code = symbol.replace('.' + sfx, '')
            prefix = p
            break

    url = ("https://money.finance.sina.com.cn/quotes_service/"
           "api/json_v2.php/CN_MarketData.getKLineData")
    params = {'symbol': f'{prefix}{raw_code}', 'scale': '240',
              'ma': 'no', 'datalen': str(datalen)}

    r = _get(url, params=params)
    rows = json.loads(r.text)

    records = []
    for row in rows:
        records.append({
            'date': row['day'][:10],
            'open': float(row['open']),
            'high': float(row['high']),
            'low': float(row['low']),
            'close': float(row['close']),
            'volume': int(float(row['volume'])),
        })
    return records


# ============================================================
# Compute technical indicators
# ============================================================

def compute_indicators(records):
    """Compute MA, MACD, RSI, Bollinger Bands from price records."""
    df = pd.DataFrame(records)

    # Moving averages
    df['MA5'] = df['close'].rolling(window=5).mean()
    df['MA10'] = df['close'].rolling(window=10).mean()
    df['MA20'] = df['close'].rolling(window=20).mean()
    df['MA60'] = df['close'].rolling(window=60).mean()

    # MACD
    macd = ta.trend.MACD(df['close'])
    df['MACD'] = macd.macd()
    df['MACD_Signal'] = macd.macd_signal()
    df['MACD_Diff'] = df['MACD'] - df['MACD_Signal']

    # RSI
    df['RSI'] = ta.momentum.RSIIndicator(df['close']).rsi()

    # Bollinger Bands
    bb = ta.volatility.BollingerBands(df['close'])
    df['BB_Upper'] = bb.bollinger_hband()
    df['BB_Middle'] = bb.bollinger_mavg()
    df['BB_Lower'] = bb.bollinger_lband()

    # Volume MA
    df['Volume_MA5'] = df['volume'].rolling(window=5).mean()
    df['Volume_MA10'] = df['volume'].rolling(window=10).mean()

    return df


def build_technical_result(df):
    """Build technical indicators dict from computed DataFrame."""
    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else latest

    def v(val):
        return round(float(val), 2) if pd.notna(val) else None

    def v4(val):
        return round(float(val), 4) if pd.notna(val) else None

    # Trend analysis
    multi_bullish = False
    try:
        if all(pd.notna(x) for x in [latest['MA5'], latest['MA10'], latest['MA20'], latest['MA60']]):
            multi_bullish = (latest['MA5'] > latest['MA10'] > latest['MA20'] > latest['MA60'])
    except Exception:
        pass

    def ma_signal():
        cur = latest['close']
        if pd.notna(latest['MA5']):
            if cur > latest['MA5'] > latest['MA10']:
                return '强势'
            elif cur < latest['MA5'] < latest['MA10']:
                return '弱势'
            elif cur > latest['MA5']:
                return '反弹'
            else:
                return '调整'
        return '信号不明'

    def rsi_signal():
        rsi = latest['RSI']
        if pd.notna(rsi):
            if rsi > 70:
                return '超买'
            elif rsi < 30:
                return '超卖'
            elif rsi > 50:
                return '强势'
            else:
                return '弱势'
        return '信号不明'

    tech = {
        'MA5': v(latest['MA5']),
        'MA10': v(latest['MA10']),
        'MA20': v(latest['MA20']),
        'MA60': v(latest['MA60']),
        'MACD': v4(latest['MACD']),
        'MACD_Signal': v4(latest['MACD_Signal']),
        'MACD_Diff': v4(latest['MACD_Diff']),
        'RSI': v(latest['RSI']),
        'BB_Upper': v(latest['BB_Upper']),
        'BB_Middle': v(latest['BB_Middle']),
        'BB_Lower': v(latest['BB_Lower']),
    }

    trend = {
        'multi_bullish': bool(multi_bullish),
        'ma_signal': ma_signal(),
        'macd_signal': '金叉' if pd.notna(latest['MACD_Diff']) and latest['MACD_Diff'] > 0 else ('死叉' if pd.notna(latest['MACD_Diff']) else '信号不明'),
        'rsi_signal': rsi_signal(),
    }

    return tech, trend, df


# ============================================================
# Main entry point
# ============================================================

def get_stock_data(symbol, market='cn', period='1y'):
    """Get stock data for analysis - A-share via Sina/Tencent, US via yfinance."""
    try:
        if market == 'cn' or any(sfx in symbol for sfx in ['SH', 'SZ', 'BJ']):
            return _get_a_share_data(symbol)
        else:
            return _get_us_data(symbol)
    except Exception as e:
        return {'error': f'获取数据失败: {str(e)}'}


def _get_a_share_data(symbol):
    """Fetch A-share data via Tencent + Sina + ta."""
    # 1. Real-time quote (Tencent)
    quote = parse_tencent_quote(symbol)
    if quote is None:
        return {'error': f'无法获取股票 {symbol} 的实时行情'}

    # 2. Historical K-line (Sina)
    records = fetch_hist_kline(symbol, datalen=365)
    if not records:
        return {'error': f'无法获取股票 {symbol} 的历史数据'}

    # 3. Compute technical indicators
    df = compute_indicators(records)
    tech, trend, full_df = build_technical_result(df)

    # 4. Build result
    latest = full_df.iloc[-1]
    prev = full_df.iloc[-2] if len(full_df) > 1 else latest

    # Historical data (last 30 days)
    hist_data = []
    for _, row in full_df.tail(30).iterrows():
        hist_data.append({
            'date': str(row['date'])[:10],
            'open': round(float(row['open']), 2),
            'high': round(float(row['high']), 2),
            'low': round(float(row['low']), 2),
            'close': round(float(row['close']), 2),
            'volume': int(float(row['volume'])),
        })

    result = {
        'symbol': symbol,
        'market': 'cn',
        'company_name': quote.get('company_name', 'N/A'),
        'current_price': quote['current_price'],
        'price_change': quote['price_change'],
        'price_change_pct': quote['price_change_pct'],
        'volume': quote['volume'],
        'amount': quote.get('amount', 0),
        'high_52w': quote.get('high_52w', 0),
        'low_52w': quote.get('low_52w', 0),
        'market_cap': quote.get('market_cap', 0),
        'total_market_cap': quote.get('total_market_cap', 0),
        'pe_ratio': quote.get('pe_ratio', 0),
        'pb_ratio': quote.get('pb_ratio', 0),
        'turnover_rate': quote.get('turnover_rate', 0),
        'amplitude': quote.get('amplitude', 0),
        'technical_indicators': tech,
        'trend_analysis': trend,
        'historical_data': hist_data,
        'data_timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    }
    return result


def _get_us_data(symbol):
    """Fetch US stock data via yfinance (passthrough)."""
    import yfinance as yf
    ticker = yf.Ticker(symbol)
    hist = ticker.history(period='1y', interval='1d')
    if hist.empty:
        return {'error': f'无法获取股票 {symbol} 的数据'}

    info = ticker.info
    df = hist.copy()

    # Technical indicators
    df['MA5'] = df['Close'].rolling(window=5).mean()
    df['MA10'] = df['Close'].rolling(window=10).mean()
    df['MA20'] = df['Close'].rolling(window=20).mean()
    df['MA60'] = df['Close'].rolling(window=60).mean()
    macd = ta.trend.MACD(df['Close'])
    df['MACD'] = macd.macd()
    df['MACD_Signal'] = macd.macd_signal()
    df['MACD_Diff'] = df['MACD'] - df['MACD_Signal']
    df['RSI'] = ta.momentum.RSIIndicator(df['Close']).rsi()
    bb = ta.volatility.BollingerBands(df['Close'])
    df['BB_Upper'] = bb.bollinger_hband()
    df['BB_Middle'] = bb.bollinger_mavg()
    df['BB_Lower'] = bb.bollinger_lband()

    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else latest

    def v(val):
        return round(float(val), 2) if pd.notna(val) else None
    def v4(val):
        return round(float(val), 4) if pd.notna(val) else None

    hist_data = []
    for idx, row in df.tail(30).iterrows():
        hist_data.append({
            'date': idx.strftime('%Y-%m-%d'),
            'open': round(row['Open'], 2),
            'high': round(row['High'], 2),
            'low': round(row['Low'], 2),
            'close': round(row['Close'], 2),
            'volume': int(row['Volume']),
        })

    result = {
        'symbol': symbol,
        'market': 'us',
        'company_name': info.get('longName', 'N/A'),
        'current_price': round(latest['Close'], 2),
        'price_change': round(latest['Close'] - prev['Close'], 2),
        'price_change_pct': round((latest['Close'] - prev['Close']) / prev['Close'] * 100, 2),
        'volume': int(latest['Volume']),
        'high_52w': info.get('fiftyTwoWeekHigh', 0),
        'low_52w': info.get('fiftyTwoWeekLow', 0),
        'market_cap': info.get('marketCap', 0),
        'pe_ratio': info.get('trailingPE', 0),
        'pb_ratio': info.get('priceToBook', 0),
        'technical_indicators': {
            'MA5': v(latest['MA5']), 'MA10': v(latest['MA10']),
            'MA20': v(latest['MA20']), 'MA60': v(latest['MA60']),
            'MACD': v4(latest['MACD']), 'MACD_Signal': v4(latest['MACD_Signal']),
            'MACD_Diff': v4(latest['MACD_Diff']), 'RSI': v(latest['RSI']),
            'BB_Upper': v(latest['BB_Upper']), 'BB_Middle': v(latest['BB_Middle']),
            'BB_Lower': v(latest['BB_Lower']),
        },
        'trend_analysis': {
            'multi_bullish': False,
            'ma_signal': '强势' if latest['Close'] > v(latest['MA5']) > v(latest['MA10']) else '信号不明',
            'macd_signal': '金叉' if df['MACD_Diff'].iloc[-1] > 0 else '死叉',
            'rsi_signal': '超买' if latest['RSI'] > 70 else '超卖' if latest['RSI'] < 30 else '强势' if latest['RSI'] > 50 else '弱势',
        },
        'historical_data': hist_data,
        'data_timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    }
    return result


def main():
    parser = argparse.ArgumentParser(description='A股/美股市场数据获取 (桥接脚本)')
    parser.add_argument('--symbol', type=str, help='股票代码 (如 600519.SH 或 AAPL)')
    parser.add_argument('--market', type=str, choices=['cn', 'us', 'both'], default='cn')
    parser.add_argument('--mode', type=str, choices=['stock', 'market', 'both'], default='stock')
    parser.add_argument('--period', type=str, default='1y')
    parser.add_argument('--interval', type=str, default='1d')
    args = parser.parse_args()

    if args.mode in ['stock', 'both']:
        if not args.symbol:
            print(json.dumps({'error': '个股模式需要提供 --symbol 参数'}, ensure_ascii=False))
            sys.exit(1)
        data = get_stock_data(args.symbol, args.market, args.period)
        print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
