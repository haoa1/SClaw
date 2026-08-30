#!/usr/bin/env python3
"""ml_screener_v12 — v12 生产评分器 (90 因子 → 87 核心, MLP 集成 ×8 seeds).

特征复刻训练侧 ml_v12_gen_dataset.py / ml_v12_predict_par.py:
  v11 72 因子 (compute_factors_v11 复用 ml_screener_v11) +
  v12 18 因子 (换手率5 + 估值8 + 龙虎榜3 + 筹码2).
  90 → CORE_IDX = 0..36 + 40..71 + 72..89 剔除 37/38/39 (chip 三兄弟恒 0).

Usage:
  from ml_screener_v12 import compute_factors_v12, V12Screener
  scr = V12Screener('/root/sclaw/ml_screener/v12_weights.json')
  factors = compute_factors_v12(kline, idx_close, val_rows, lhb_rows)
  prob = scr.score_one(factors)

kline: list of {date, open, high, low, close, volume, amount, change_pct, turnover_rate}
idx_close: SSE index closes aligned to kline dates (ffill, 0 missing)
val_rows: list of (date, pe, pb, ps, pcf, peg, mktcap, floatcap, free_shares) or None
lhb_rows: list of (date, billboard_net) or None
"""
import json
import sys

import numpy as np
import pandas as pd

from ml_screener_v11 import ALL_NAMES as V11_NAMES
from ml_screener_v11 import compute_factors_v11

# ---- v12 新增 18 因子 (顺序必须与训练 ALL_NAMES 尾部一致) ----
NEW_COLS = ['turnover_rate', 'turnover_ma5', 'turnover_ma20', 'turnover_ratio',
            'turnover_trend',
            'pe_ttm', 'pb_mrq', 'ps_ttm', 'pcf_ocf_ttm', 'peg', 'mktcap_log',
            'pe_pct60', 'pb_pct60',
            'lhb_up', 'lhb_net_ratio', 'lhb_net_sum10',
            'chip_profit_est', 'chip_conc_est']
ALL_NAMES = V11_NAMES + NEW_COLS  # 90
CORE_IDX = list(range(0, 37)) + list(range(40, 72)) + list(range(72, 90))  # 87


def _v12_extra_factors(df):
    """复刻训练侧 compute_v12_factors (输入 df 已 merge val/lhb/idx)."""
    n = len(df)
    f = pd.DataFrame(index=df.index)
    turn = df['turnover_rate'].to_numpy(float) if 'turnover_rate' in df else np.zeros(n)
    s_turn = pd.Series(turn)

    # ---- A 换手率 ----
    f['turnover_rate'] = turn
    ma5 = s_turn.rolling(5).mean()
    ma20 = s_turn.rolling(20).mean()
    f['turnover_ma5'] = ma5
    f['turnover_ma20'] = ma20
    f['turnover_ratio'] = turn / ma5
    f['turnover_trend'] = ma5 / ma5.shift(5) - 1

    c = df['close'].to_numpy(float)
    s = pd.Series(c)

    # ---- B 估值 ----
    pe = df['pe_ttm_raw'].to_numpy(float) if 'pe_ttm_raw' in df else np.full(n, np.nan)
    pb = df['pb_mrq_raw'].to_numpy(float) if 'pb_mrq_raw' in df else np.full(n, np.nan)
    ps = df['ps_ttm_raw'].to_numpy(float) if 'ps_ttm_raw' in df else np.full(n, np.nan)
    pcf = df['pcf_raw'].to_numpy(float) if 'pcf_raw' in df else np.full(n, np.nan)
    peg = df['peg_raw'].to_numpy(float) if 'peg_raw' in df else np.full(n, np.nan)
    mktcap = df['mktcap_raw'].to_numpy(float) if 'mktcap_raw' in df else np.full(n, np.nan)

    f['pe_ttm'] = np.log1p(np.clip(pe, 0, 500))
    f['pb_mrq'] = np.log1p(np.clip(pb, 0, 100))
    f['ps_ttm'] = np.log1p(np.clip(ps, 0, 100))
    f['pcf_ocf_ttm'] = np.log1p(np.clip(pcf, -100, 100) + 100)
    f['peg'] = np.clip(peg, -10, 10)
    with np.errstate(divide='ignore', invalid='ignore'):
        f['mktcap_log'] = np.log(mktcap)

    s_pe = pd.Series(pe)
    s_pb = pd.Series(pb)
    f['pe_pct60'] = s_pe.rolling(60).rank(pct=True)
    f['pb_pct60'] = s_pb.rolling(60).rank(pct=True)

    # ---- C 龙虎榜 ----
    lhb_net = df['lhb_net_raw'].to_numpy(float) if 'lhb_net_raw' in df else np.zeros(n)
    lhb_up = df['lhb_up_raw'].to_numpy(float) if 'lhb_up_raw' in df else np.zeros(n)
    free_shares = df['free_shares'].to_numpy(float) if 'free_shares' in df else np.full(n, np.nan)
    floatcap = free_shares * c
    f['lhb_up'] = lhb_up
    with np.errstate(divide='ignore', invalid='ignore'):
        net_ratio = np.where(floatcap > 0, lhb_net / floatcap * 100, 0.0)
    f['lhb_net_ratio'] = net_ratio
    f['lhb_net_sum10'] = pd.Series(net_ratio).rolling(10).sum()

    # ---- D 筹码估算 (60日换手加权) ----
    window = 60
    profit = np.full(n, np.nan)
    conc = np.full(n, np.nan)
    for i in range(window - 1, n):
        w = turn[i - window + 1:i + 1]
        prices = c[i - window + 1:i + 1]
        sw = w.sum()
        if sw > 0:
            profit[i] = (w * (prices < c[i])).sum() / sw
            mean_cost = (w * prices).sum() / sw
            var = (w * (prices - mean_cost) ** 2).sum() / sw
            conc[i] = np.sqrt(var) / max(c[i], 1e-9)
    f['chip_profit_est'] = profit
    f['chip_conc_est'] = conc

    return f[ALL_NAMES[len(V11_NAMES):]]


def compute_factors_v12(kline, idx_close=None, val_rows=None, lhb_rows=None):
    """90 因子 (v11 72 + v12 18), 返回 dict 或 None (<60 bars)."""
    n = len(kline)
    if n < 60:
        return None
    # ---- build df (训练侧 predict_par 完全一致) ----
    df = pd.DataFrame([{
        'date': r['date'], 'open': r.get('open'), 'high': r.get('high'),
        'low': r.get('low'), 'close': r.get('close'),
        'volume': r.get('volume') or 0.0,
        'amount': r.get('amount') or 0.0,
        'change_pct': r.get('change_pct') or 0.0,
        'turnover_rate': r.get('turnover_rate') or 0.0,
    } for r in kline])

    # merge 估值 (训练: left join on date, 然后 ffill)
    if val_rows:
        vdf = pd.DataFrame(val_rows, columns=['date', 'pe_ttm_raw', 'pb_mrq_raw',
                                              'ps_ttm_raw', 'pcf_raw', 'peg_raw',
                                              'mktcap_raw', 'floatcap_raw',
                                              'free_shares'])
        df = df.merge(vdf, on='date', how='left')
    else:
        for col in ['pe_ttm_raw', 'pb_mrq_raw', 'ps_ttm_raw', 'pcf_raw',
                    'peg_raw', 'mktcap_raw', 'floatcap_raw', 'free_shares']:
            df[col] = np.nan
    # merge 龙虎榜
    if lhb_rows:
        ldf = pd.DataFrame(lhb_rows, columns=['date', 'lhb_net_raw'])
        ldf['lhb_up_raw'] = 1.0
        df = df.merge(ldf, on='date', how='left')
        df['lhb_up_raw'] = df['lhb_up_raw'].fillna(0.0)
        df['lhb_net_raw'] = df['lhb_net_raw'].fillna(0.0)
    else:
        df['lhb_net_raw'] = 0.0
        df['lhb_up_raw'] = 0.0
    # 指数 (ffill)
    if idx_close is not None and len(idx_close) == n:
        df['idx_close'] = pd.Series(idx_close).ffill()
    else:
        df['idx_close'] = np.nan
    # 估值 ffill
    for col in ['pe_ttm_raw', 'pb_mrq_raw', 'ps_ttm_raw', 'pcf_raw',
                'peg_raw', 'mktcap_raw', 'floatcap_raw', 'free_shares']:
        df[col] = df[col].ffill()
    if df['idx_close'].isna().any() or df['close'].isna().any():
        return None

    # ---- 因子 ----
    f11 = compute_factors_v11(kline, idx_close)  # 72 dict
    f12 = _v12_extra_factors(df)                 # 18 DataFrame
    last12 = f12.iloc[-1]

    out = {}
    for name in V11_NAMES:
        v = f11[name]
        out[name] = 0.0 if (v != v) else float(v)
    for name in NEW_COLS:
        v = last12[name]
        if isinstance(v, (np.floating, np.integer)):
            v = float(v)
        out[name] = 0.0 if (v != v) else float(v)
    return out


class V12Screener:
    """v12 MLP ensemble scorer — 加载训练机转换的 v12_weights.json."""

    def __init__(self, weights_path):
        with open(weights_path) as fh:
            W = json.load(fh)
        self.mu = np.asarray(W['mu'], dtype=np.float64)
        self.sd = np.asarray(W['sd'], dtype=np.float64)
        if len(self.mu) != len(CORE_IDX):
            raise ValueError(f'weights mu {len(self.mu)} != CORE 87')
        # ensemble: [{W, b} x (hidden+1) layers] per seed
        self.models = W['ensemble']

    def features(self, factors):
        row = np.array([float(factors.get(ALL_NAMES[i], 0.0)) for i in CORE_IDX])
        return row

    def _forward(self, x, layers):
        # layers: [{W, b}, {W, b}]  (Linear -> ReLU -> ... -> Linear)
        for i, L in enumerate(layers):
            W = np.asarray(L['W'], dtype=np.float64)
            b = np.asarray(L['b'], dtype=np.float64)
            x = W @ x + b
            if i < len(layers) - 1:
                x = np.maximum(x, 0.0)  # ReLU
        x = np.clip(x, -30.0, 30.0)
        return float(1.0 / (1.0 + np.exp(-x[0])))

    def score_one(self, factors):
        x = (self.features(factors) - self.mu) / (self.sd + 1e-9)
        preds = [self._forward(x, m) for m in self.models]
        return float(np.mean(preds))


def _main():
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)
    wpath, stocks_path, idx_path, val_path, lhb_path = sys.argv[1:6]
    scr = V12Screener(wpath)
    stocks = json.load(open(stocks_path))
    idx_data = json.load(open(idx_path))
    idx_closes = idx_data.get('closes') if idx_data else None
    val_map = json.load(open(val_path)) if val_path != '-' else {}
    lhb_map = json.load(open(lhb_path)) if lhb_path != '-' else {}
    out = []
    for st in stocks:
        kl = st.get('kline') or st.get('kline_list') or []
        code = st.get('code')
        factors = compute_factors_v12(kl, idx_closes,
                                      val_map.get(code), lhb_map.get(code))
        if factors is None:
            continue
        p = scr.score_one(factors)
        out.append({'code': code, 'name': st.get('name'),
                    'v12_prob': round(p, 4), 'score': round(p * 100, 1),
                    'signals': ['v12'], 'price': st.get('price'),
                    'change_percent': st.get('change_percent')})
    out.sort(key=lambda r: -r['v12_prob'])
    for i, r in enumerate(out):
        r['rank'] = i + 1
    print(json.dumps({'date': stocks.get('date') or '', 'count': len(out),
                      'results': out}, ensure_ascii=False))


if __name__ == '__main__':
    _main()
