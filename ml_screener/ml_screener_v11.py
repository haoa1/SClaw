#!/usr/bin/env python3
"""ml_screener_v11 — v11 生产评分器 (72 特征 → 69 核心, MLP 集成).

特征计算复刻训练侧 ml_v11_gen_dataset.py (pandas 语义完全一致),
指数特征需要上证指数日线 (按日期左对齐 + ffill, 与训练一致).

Usage:
  from ml_screener_v11 import V11Screener, compute_factors_v11
  scr = V11Screener('/root/sclaw/ml_screener/v11_weights.json')
  prob = scr.score_one(factors_dict)

  或命令行:  python3 ml_screener_v11.py weights.json stocks.json idx_daily.json
"""
import json
import math
import sys

import numpy as np
import pandas as pd

# ============================================================
# 72-factor vocabulary (MUST match training ALL_NAMES order)
# ============================================================
SPARSE_NAMES = [
    'price_new_low', 'vol_shrink_floor', 'rise_from_low', 'dif_turn_up',
    'back_chi_confirm', 'rebound_pct', 'pullback_no_break', 'vol_shrink_pullback',
    'dif_pullback_zero', 'pivot_zhongshu', 'break_pivot_top', 'revisit_no_break',
    'vol_confirm', 'chip_profit_low', 'chip_profit_high', 'chip_profit_mid',
    'sh_ma20_up', 'sh_ma20_down', 'sh_macd_bull', 'sh_macd_bear',
    'dif_above_zero', 'vol_ratio_low', 'vol_ratio_high', 'price_60d_low',
    'price_60d_high', 'rsi_mid', 'rsi_high', 'rsi_low', 'chip_bottom_peak',
    'rs_weak', 'rs_strong', 'vol20_low', 'vol20_high', 'macd_hist_rising',
    'near_ma20', 'sh_ret5_pos', 'sh_ret5_neg',
]
FLOAT_COLS = ['chipProfitRatio', 'chipConcentration', 'chipCostDist',
              'volRatio', 'pricePos60', 'ma5Dist', 'ma10Dist', 'ma20Dist',
              'rsi6', 'vol20', 'ret5', 'ret20', 'atrRatio', 'rs5', 'rs20',
              'shAboveMA20', 'shRet5', 'shRet20', 'volTrend']
INT_COLS = ['chipBottomPeak', 'shMA20Dir', 'shMACDBull', 'shMACDZero',
            'difAboveZero', 'macdHistRising']
NEW_COLS = ['boll_pctB', 'boll_width', 'boll_width_chg', 'boll_mid_dist',
            'idx_ret5', 'idx_ret20', 'idx_ma20_dist', 'idx_bull',
            'rs5_idx', 'rs20_idx']
ALL_NAMES = SPARSE_NAMES + FLOAT_COLS + INT_COLS + NEW_COLS  # 72
CORE_IDX = list(range(0, 37)) + list(range(40, 62)) + list(range(62, 72))  # 69
CORE_NAMES = [ALL_NAMES[i] for i in CORE_IDX]


def compute_factors_v11(kline, idx_close=None):
    """Compute all 72 factors from K-line bars (oldest→newest).

    kline: list of {date, open, high, low, close, volume, amount, change_pct}
    idx_close: list of SSE index closes aligned to kline dates (optional).
        If None → index features default (0.0 / 0).
    Returns dict of 72 factors (or None if < 60 bars).
    """
    n = len(kline)
    if n < 60:
        return None
    closes = np.array([r['close'] for r in kline], dtype=np.float64)
    highs = np.array([r['high'] for r in kline], dtype=np.float64)
    lows = np.array([r['low'] for r in kline], dtype=np.float64)
    vols = np.array([r['volume'] for r in kline], dtype=np.float64)
    amts = np.array([r['amount'] if r.get('amount') else 0.0 for r in kline], dtype=np.float64)
    chg = np.array([r['change_pct'] if r.get('change_pct') else 0.0 for r in kline], dtype=np.float64)

    s = pd.Series(closes)
    sv = pd.Series(vols)
    samt = pd.Series(amts)
    ch = pd.Series(chg)
    sh = pd.Series(highs)
    sl = pd.Series(lows)

    ma5 = s.rolling(5).mean()
    ma10 = s.rolling(10).mean()
    ma20 = s.rolling(20).mean()
    ma60 = s.rolling(60).mean()
    avg_vol20 = sv.rolling(20).mean()
    avg_vol5 = sv.rolling(5).mean()
    avg_amt20 = samt.rolling(20).mean()
    c = s

    f = pd.DataFrame(index=s.index)
    # ---- continuous (v10) ----
    f['volRatio'] = sv / avg_vol20
    high60 = sh.rolling(60).max()
    low60 = sl.rolling(60).min()
    f['pricePos60'] = (c - low60) / (high60 - low60)
    f['ma5Dist'] = (c / ma5 - 1.0) * 100
    f['ma10Dist'] = (c / ma10 - 1.0) * 100
    f['ma20Dist'] = (c / ma20 - 1.0) * 100
    diff = s.diff()
    gains = diff.clip(lower=0).rolling(6).mean()
    losses = (-diff.clip(upper=0)).rolling(6).mean()
    f['rsi6'] = 100 - 100 / (1 + gains / losses)
    f['rsi6'] = f['rsi6'].fillna(50.0)
    f['vol20'] = avg_amt20 / 1e8
    f['ret5'] = ch
    f['ret20'] = (c / s.shift(20) - 1) * 100
    pc = s.shift(1)
    tr = pd.concat([(sh - sl), (sh - pc).abs(), (sl - pc).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    f['atrRatio'] = atr / c
    f['rs5'] = ch
    f['rs20'] = f['ret20']
    f['shAboveMA20'] = (c > ma20).astype(float)
    f['shRet5'] = ch
    f['shRet20'] = f['ret20']
    f['volTrend'] = (avg_vol5 / avg_vol20 - 1) * 100

    # ---- int (v10) ----
    f['chipBottomPeak'] = (f['pricePos60'] < 0.25).astype(float)
    ma20_prev = ma20.shift(20)
    f['shMA20Dir'] = np.sign(ma20 - ma20_prev).fillna(0)
    ema12 = s.ewm(span=12, adjust=False).mean()
    ema26 = s.ewm(span=26, adjust=False).mean()
    dif = ema12 - ema26
    f['shMACDBull'] = np.where((dif > 0) & (ema12 > ema26), 1.0,
                     np.where((dif < 0) & (ema12 < ema26), -1.0, 0.0))
    f['shMACDZero'] = ((c / ma20 - 1).abs() < 0.02).astype(float)
    f['difAboveZero'] = (c > ma20).astype(float)
    f['macdHistRising'] = ((ch > 0) & (ch.shift(1) > 0)).astype(float)
    f.loc[f.index[0], 'macdHistRising'] = 0.0

    # ---- 37 sparse (v10) ----
    pp60 = f['pricePos60']
    vr = f['volRatio']
    f['price_new_low'] = (pp60 < 0.1).astype(float)
    f['vol_shrink_floor'] = ((vr < 0.6) & (pp60 < 0.3)).astype(float)
    f['rise_from_low'] = ((ch > 2) & (pp60 < 0.3)).astype(float)
    f['dif_turn_up'] = ((ch > 0) & (ch.shift(1) <= 0) & (ch.shift(2) <= 0)).astype(float)
    f['back_chi_confirm'] = ((vr < 0.5) & (pp60 < 0.2)).astype(float)
    f['rebound_pct'] = (np.abs(ch) > 3).astype(float)
    f['pullback_no_break'] = ((ch < 0) & (np.abs(ch) < 5)).astype(float)
    f['vol_shrink_pullback'] = ((ch < 0) & (vr < 0.7)).astype(float)
    f['dif_pullback_zero'] = ((np.abs(ch) < 1) & (vr < 0.8)).astype(float)
    f['pivot_zhongshu'] = ((ma20 - ma60).abs() / ma60 < 0.05).astype(float)
    f['break_pivot_top'] = ((c > ma20) & (c.shift(5) < ma20)).astype(float)
    high10 = sh.rolling(10).max()
    f['revisit_no_break'] = ((c > ma20) & (c / high10 > 0.95)).astype(float)
    f['vol_confirm'] = ((vr > 1.2) & (ch > 0)).astype(float)
    f['chip_profit_low'] = (pp60 < 0.3).astype(float)
    f['chip_profit_high'] = (pp60 > 0.9).astype(float)
    f['chip_profit_mid'] = ((pp60 >= 0.3) & (pp60 <= 0.7)).astype(float)
    f['sh_ma20_up'] = (f['shMA20Dir'] > 0).astype(float)
    f['sh_ma20_down'] = (f['shMA20Dir'] < 0).astype(float)
    f['sh_macd_bull'] = (f['shMACDBull'] == 1).astype(float)
    f['sh_macd_bear'] = (f['shMACDBull'] == -1).astype(float)
    f['dif_above_zero'] = f['difAboveZero'].astype(float)
    f['vol_ratio_low'] = (vr < 0.7).astype(float)
    f['vol_ratio_high'] = (vr > 2.0).astype(float)
    f['price_60d_low'] = (pp60 < 0.25).astype(float)
    f['price_60d_high'] = (pp60 > 0.75).astype(float)
    f['rsi_mid'] = ((f['rsi6'] >= 30) & (f['rsi6'] <= 60)).astype(float)
    f['rsi_high'] = (f['rsi6'] > 70).astype(float)
    f['rsi_low'] = (f['rsi6'] < 30).astype(float)
    f['chip_bottom_peak'] = f['chipBottomPeak'].astype(float)
    f['rs_weak'] = (f['rs20'] < -5).astype(float)
    f['rs_strong'] = (f['rs20'] > 10).astype(float)
    f['vol20_low'] = (f['vol20'] < 0.015).astype(float)
    f['vol20_high'] = (f['vol20'] > 0.03).astype(float)
    f['macd_hist_rising'] = f['macdHistRising'].astype(float)
    f['near_ma20'] = (f['ma20Dist'].abs() < 5).astype(float)
    f['sh_ret5_pos'] = (f['shRet5'] > 0).astype(float)
    f['sh_ret5_neg'] = (f['shRet5'] < -2).astype(float)

    # chip 3 factors NOT computable from kline -> 0
    f['chipProfitRatio'] = 0.0
    f['chipConcentration'] = 0.0
    f['chipCostDist'] = 0.0

    # ---- BOLL (20,2) ----
    mid20 = s.rolling(20).mean()
    std20 = s.rolling(20).std()          # ddof=1 (pandas default)
    upper = mid20 + 2 * std20
    lower = mid20 - 2 * std20
    f['boll_pctB'] = (c - lower) / (upper - lower)
    f['boll_width'] = (upper - lower) / mid20 * 100
    f['boll_width_chg'] = f['boll_width'] / f['boll_width'].shift(5) - 1
    f['boll_mid_dist'] = (c - mid20) / mid20 * 100

    # ---- SSE Index features (aligned by date, ffill like training) ----
    if idx_close is not None and len(idx_close) == n:
        s_idx = pd.Series(np.asarray(idx_close, dtype=np.float64))
        idx_ma20 = s_idx.rolling(20).mean()
        f['idx_ret5'] = (s_idx / s_idx.shift(5) - 1) * 100
        f['idx_ret20'] = (s_idx / s_idx.shift(20) - 1) * 100
        f['idx_ma20_dist'] = (s_idx / idx_ma20 - 1) * 100
        f['idx_bull'] = (s_idx > idx_ma20).astype(float)
        ret5_true = (c / s.shift(5) - 1) * 100          # stock true 5d return
        f['rs5_idx'] = ret5_true - f['idx_ret5']
        f['rs20_idx'] = f['ret20'] - f['idx_ret20']
    else:
        f['idx_ret5'] = 0.0
        f['idx_ret20'] = 0.0
        f['idx_ma20_dist'] = 0.0
        f['idx_bull'] = 0.0
        f['rs5_idx'] = (c / s.shift(5) - 1) * 100
        f['rs20_idx'] = f['ret20']

    last = f.iloc[-1]
    out = {}
    for name in ALL_NAMES:
        v = last[name]
        if isinstance(v, (np.floating, np.integer)):
            v = float(v)
        if v != v:  # NaN
            v = 0.0
        out[name] = v
    return out


class V11Screener:
    """v11 MLP ensemble scorer — loads cloud JSON weights (same shape as v10)."""

    def __init__(self, weights_path):
        with open(weights_path) as fh:
            W = json.load(fh)
        self.mu = np.asarray(W['mu'], dtype=np.float64)
        self.sd = np.asarray(W['sd'], dtype=np.float64)
        self.hids = W.get('hids', [])
        self.feat_name = W.get('feat_name') or CORE_NAMES
        if len(self.feat_name) != len(self.mu):
            raise ValueError(
                f'feat_name {len(self.feat_name)} != mu {len(self.mu)}')
        self.models = W['models']

    def features(self, factors):
        row = np.array([float(factors.get(nm, 0.0)) for nm in self.feat_name])
        return row

    def _forward(self, x, m):
        # layers stored as W1/b1/W2/b2...
        i = 1
        while f'W{i}' in m:
            W = np.asarray(m[f'W{i}'], dtype=np.float64)
            b = np.asarray(m[f'b{i}'], dtype=np.float64)
            x = W @ x + b
            if f'W{i + 1}' in m:
                x = np.maximum(x, 0.0)  # ReLU
            i += 1
        # final sigmoid
        x = np.clip(x, -30.0, 30.0)
        sig = 1.0 / (1.0 + np.exp(-x))
        return float(np.asarray(sig).reshape(-1)[0])

    def score_one(self, factors):
        x = (self.features(factors) - self.mu) / (self.sd + 1e-9)
        preds = [self._forward(x, m) for m in self.models]
        return float(np.mean(preds))


def _main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    wpath, stocks_path, idx_path = sys.argv[1], sys.argv[2], sys.argv[3]
    scr = V11Screener(wpath)
    stocks = json.load(open(stocks_path))
    idx_data = json.load(open(idx_path)) if idx_path != '-' else None
    idx_closes = None
    if idx_data and 'closes' in idx_data:
        idx_closes = idx_data['closes']
    out = []
    for st in stocks:
        kl = st.get('kline') or st.get('kline_list') or []
        factors = compute_factors_v11(kl, idx_closes)
        if factors is None:
            continue
        p = scr.score_one(factors)
        out.append({'code': st.get('code'), 'name': st.get('name'),
                    'v11_prob': round(p, 4),
                    'score': round(p * 100, 1),
                    'signals': ['v11'],
                    'price': st.get('price'),
                    'change_percent': st.get('change_percent')})
    out.sort(key=lambda r: -r['v11_prob'])
    for i, r in enumerate(out):
        r['rank'] = i + 1
    print(json.dumps({'total': len(out), 'results': out}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    _main()
