#!/usr/bin/env python3
"""
ML Factor Screener — reads stock data from stdin (JSON), computes 37 factors,
applies trained weights, outputs ranked results.

Usage:
  echo '<stock_data_json>' | python3 ml_screener.py > results.json
  python3 ml_screener.py --file stocks.json > results.json
"""
import json, sys, math, os
import numpy as np

# ====== Trained weights from v8 GLOBAL optimizer (12 seeds multi-start) ======
# v8: deterministic (fixed seeds), 12-seed multi-start, validation-aware selection,
#     hill-climb refined. Strict OOS: avg 0.416 vs v7 0.267; worst fold -0.240 -> 0.000.
WEIGHTS = {
    "price_new_low": 0.912, "vol_shrink_floor": 1.013,
    "rise_from_low": 1.034, "dif_turn_up": 1.982,
    "back_chi_confirm": 0.822, "rebound_pct": 1.106,
    "pullback_no_break": 0.929, "vol_shrink_pullback": 0.920,
    "dif_pullback_zero": 1.014, "pivot_zhongshu": 0.831,
    "break_pivot_top": 0.821, "revisit_no_break": 1.027,
    "vol_confirm": 1.024, "chip_profit_low": 1.255,
    "chip_profit_high": 1.310, "chip_profit_mid": 1.006,
    "sh_ma20_up": 1.055, "sh_ma20_down": 0.801,
    "sh_macd_bull": 0.957, "sh_macd_bear": 0.991,
    "dif_above_zero": 1.285, "vol_ratio_low": 1.119,
    "vol_ratio_high": 0.839, "price_60d_low": 0.979,
    "price_60d_high": 0.781, "rsi_mid": 0.962,
    "rsi_high": 0.967, "rsi_low": 0.999,
    "chip_bottom_peak": 1.129, "rs_weak": 1.043,
    "rs_strong": 1.053, "vol20_low": 0.908,
    "vol20_high": 1.129, "macd_hist_rising": 0.618,
    "near_ma20": 1.150, "sh_ret5_pos": 1.030,
    "sh_ret5_neg": 1.088,
}
BASE_SCORE = 2.7027027027027026  # uniform prior

# ====== Factor computation helpers ======

def ema(values, period):
    result = []
    multiplier = 2 / (period + 1)
    for i, v in enumerate(values):
        if i == 0:
            result.append(v)
        else:
            result.append((v - result[-1]) * multiplier + result[-1])
    return result

def sma(values, period):
    result = []
    for i, v in enumerate(values):
        if i < period - 1:
            result.append(float('nan'))
        else:
            result.append(sum(values[i-period+1:i+1]) / period)
    return result

def rsi(values, period=14):
    if len(values) < period + 1:
        return 50.0
    gains, losses = 0, 0
    for i in range(1, period + 1):
        diff = values[-i] - values[-i-1]
        if diff > 0: gains += diff
        else: losses -= diff
    if losses == 0: return 100.0
    rs = gains / losses
    return 100 - 100 / (1 + rs)

def compute_macd(closes, fast=12, slow=26, signal=9):
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    dif = [ema_fast[i] - ema_slow[i] for i in range(len(closes))]
    dea = ema(dif, signal) if len(dif) >= signal else [0] * len(dif)
    macd = [2 * (dif[i] - dea[i]) for i in range(len(dif))]
    return dif, dea, macd

# ====== Factor computation ======
def compute_factors(stock):
    """
    Compute 37 ML factors from a stock data object.
    stock must have:
      - price, change_percent, volume, turnover, volume_ratio, turnover_rate, market_cap
      - price_high, price_low (today's high/low)
      - pe, pb (optional)
      - kline: [{date, open, close, high, low, volume}, ...] (at least 60 days ideally)
    """
    price = stock.get("price", 0)
    change_pct = stock.get("change_percent", 0)
    volume = stock.get("volume", 0)
    turnover = stock.get("turnover", 0)
    volume_ratio = stock.get("volume_ratio", 1.0)
    turnover_rate = stock.get("turnover_rate", 0)
    market_cap = stock.get("market_cap", 0)
    pe = stock.get("pe", None)
    pb = stock.get("pb", None)
    high_today = stock.get("high", price)
    low_today = stock.get("low", price)
    
    kline = stock.get("kline", [])
    closes = [k["close"] for k in kline]
    highs = [k["high"] for k in kline]
    lows = [k["low"] for k in kline]
    vols = [k["volume"] for k in kline]
    n = len(closes)

    factors = {}
    
    # --- Price position factors ---
    if n >= 60:
        # price_60d_low / high: where is price relative to 60d range
        min_60 = min(lows[-60:])
        max_60 = max(highs[-60:])
        range_60 = max_60 - min_60
        factors["price_60d_low"] = 1.0 - (price - min_60) / range_60 if range_60 > 0 else 0.5
        factors["price_60d_high"] = (price - min_60) / range_60 if range_60 > 0 else 0.5
        # price_new_low: is price near 60d low
        factors["price_new_low"] = 1.0 if price <= min_60 * 1.02 else (0.0 if price >= min_60 * 1.05 else 0.5)
    else:
        factors["price_60d_low"] = 0.5
        factors["price_60d_high"] = 0.5
        factors["price_new_low"] = 0.5
    
    # --- MA factors ---
    if n >= 20:
        ma5 = sum(closes[-5:]) / 5
        ma20 = sum(closes[-20:]) / 20
        ma60 = sum(closes[-60:]) / 60 if n >= 60 else closes[-1]
        
        # sh_ma20_up / down: MA20 direction
        if n >= 25:
            ma20_prev = sum(closes[-25:-5]) / 20
            factors["sh_ma20_up"] = 1.0 if ma20 > ma20_prev else 0.0
            factors["sh_ma20_down"] = 1.0 if ma20 < ma20_prev else 0.0
        else:
            factors["sh_ma20_up"] = 0.5
            factors["sh_ma20_down"] = 0.5
        
        # near_ma20: price close to MA20
        ma20_diff = abs(price - ma20) / ma20 if ma20 > 0 else 0
        factors["near_ma20"] = max(0, 1.0 - ma20_diff * 10)  # within 10% = near
        
        # sh_ret5_pos/neg: 5-day return
        if n >= 6:
            ret5 = (closes[-1] - closes[-6]) / closes[-6]
            factors["sh_ret5_pos"] = max(0, ret5 / 0.1) if ret5 > 0 else 0.0
            factors["sh_ret5_neg"] = max(0, -ret5 / 0.1) if ret5 < 0 else 0.0
        else:
            factors["sh_ret5_pos"] = 0.5
            factors["sh_ret5_neg"] = 0.5
    else:
        for k in ["sh_ma20_up", "sh_ma20_down", "near_ma20", "sh_ret5_pos", "sh_ret5_neg"]:
            factors[k] = 0.5
    
    # --- MACD factors ---
    if n >= 35:
        dif_arr, dea_arr, macd_arr = compute_macd(closes)
        dif_latest = dif_arr[-1]
        dif_prev = dif_arr[-2]
        macd_latest = macd_arr[-1]
        macd_prev = macd_arr[-2]
        
        # dif_above_zero
        factors["dif_above_zero"] = 1.0 if dif_latest > 0 else 0.0
        
        # sh_macd_bull/bear
        factors["sh_macd_bull"] = 1.0 if dif_latest > dea_arr[-1] else 0.0
        factors["sh_macd_bear"] = 1.0 if dif_latest < dea_arr[-1] else 0.0
        
        # macd_hist_rising
        factors["macd_hist_rising"] = 1.0 if macd_latest > macd_prev else 0.0
        
        # dif_turn_up: DIF turning up
        if len(dif_arr) >= 3:
            factors["dif_turn_up"] = 1.0 if dif_latest > dif_prev and dif_prev <= dif_arr[-3] else 0.0
        else:
            factors["dif_turn_up"] = factors["dif_above_zero"]
        
        # dif_pullback_zero: DIF pulling back from negative to near zero
        factors["dif_pullback_zero"] = 1.0 if dif_latest > -0.5 and dif_prev < -1.0 else 0.0
    else:
        for k in ["dif_above_zero", "sh_macd_bull", "sh_macd_bear", "macd_hist_rising", "dif_turn_up", "dif_pullback_zero"]:
            factors[k] = 0.5
    
    # --- RSI factors ---
    if n >= 15:
        rsi_val = rsi(closes, 14)
        factors["rsi_low"] = 1.0 if rsi_val < 30 else (0.0 if rsi_val > 40 else (40 - rsi_val) / 10)
        factors["rsi_mid"] = 1.0 if 40 <= rsi_val <= 60 else 0.0
        factors["rsi_high"] = 1.0 if rsi_val > 70 else (0.0 if rsi_val < 60 else (rsi_val - 60) / 10)
    else:
        for k in ["rsi_low", "rsi_mid", "rsi_high"]:
            factors[k] = 0.5
    
    # --- Volume factors ---
    # vol_ratio_low/high
    factors["vol_ratio_low"] = max(0, 1.0 - volume_ratio / 2) if volume_ratio < 1.0 else 0.0
    factors["vol_ratio_high"] = min(1.0, (volume_ratio - 1.0) / 3) if volume_ratio > 1.0 else 0.0
    
    # vol20_low/high: 20-day volume comparison
    if n >= 20:
        avg_vol_20 = sum(vols[-20:]) / 20
        vol_ratio_20 = volume / avg_vol_20 if avg_vol_20 > 0 else 1.0
        factors["vol20_low"] = max(0, 1.0 - vol_ratio_20) if vol_ratio_20 < 1.0 else 0.0
        factors["vol20_high"] = min(1.0, vol_ratio_20 - 1.0) if vol_ratio_20 > 1.0 else 0.0
    else:
        factors["vol20_low"] = factors["vol_ratio_low"]
        factors["vol20_high"] = factors["vol_ratio_high"]
    
    # vol_confirm: volume confirmation of trend
    factors["vol_confirm"] = factors["vol20_high"] if change_pct > 0 else 0.0
    
    # vol_shrink_floor / vol_shrink_pullback: volume shrinking patterns
    if n >= 10:
        vols_recent = vols[-10:]
        vol_trend = vols_recent[-1] / (sum(vols_recent[:-1]) / (len(vols_recent) - 1) + 0.01)
        factors["vol_shrink_floor"] = max(0, 1.0 - vol_trend) if vol_trend < 1.0 else 0.0
        factors["vol_shrink_pullback"] = factors["vol_shrink_floor"]
    else:
        factors["vol_shrink_floor"] = 0.5
        factors["vol_shrink_pullback"] = 0.5
    
    # --- Price reversal/continuation patterns ---
    # rise_from_low: how far from recent low
    if n >= 20:
        low_20d = min(lows[-20:])
        factors["rise_from_low"] = min(1.0, (price - low_20d) / (low_20d + 0.01) * 5) if price > low_20d else 0.0
        factors["rebound_pct"] = factors["rise_from_low"]
    else:
        factors["rise_from_low"] = 0.5
        factors["rebound_pct"] = 0.5
    
    # pullback_no_break: price pulling back but not breaking support
    if n >= 10:
        low_10d = min(lows[-10:])
        high_10d = max(highs[-10:])
        pullback = (high_10d - price) / (high_10d - low_10d + 0.01)
        factors["pullback_no_break"] = max(0, 1.0 - pullback * 2)  # pulled back <50%
    else:
        factors["pullback_no_break"] = 0.5
    
    # back_chi_confirm: callback confirmation
    factors["back_chi_confirm"] = 1.0 if change_pct > 0 and volume_ratio > 1.0 else 0.0
    
    # --- Relative strength ---
    # rs_weak/strong: simplified as changePercent relative to market
    factors["rs_weak"] = max(0, -change_pct / 5) if change_pct < 0 else 0.0
    factors["rs_strong"] = max(0, change_pct / 5) if change_pct > 0 else 0.0
    
    # --- Pivot/Central pivot (简化的中枢) ---
    if n >= 20:
        low_20 = min(lows[-20:])
        high_20 = max(highs[-20:])
        mid = (high_20 + low_20) / 2
        factors["pivot_zhongshu"] = 1.0 if low_20 * 1.05 <= price <= high_20 * 0.95 else 0.5
        factors["break_pivot_top"] = 1.0 if price > high_20 * 0.98 else 0.0
        factors["revisit_no_break"] = 1.0 if low_20 * 0.98 <= price <= high_20 * 1.02 else 0.0
    else:
        factors["pivot_zhongshu"] = 0.5
        factors["break_pivot_top"] = 0.5
        factors["revisit_no_break"] = 0.5
    
    # --- Chip/market-cap factors (approximated) ---
    factors["chip_profit_low"] = factors["price_60d_low"]
    factors["chip_profit_high"] = factors["price_60d_high"]
    factors["chip_profit_mid"] = 1.0 if 0.3 <= factors.get("price_60d_low", 0.5) <= 0.7 else 0.0
    factors["chip_bottom_peak"] = 1.0 if factors.get("price_60d_low", 0.5) > 0.8 else 0.0
    
    # --- Ensure all factors exist ---
    for k in WEIGHTS:
        if k not in factors:
            factors[k] = 0.5
    
    return factors

def compute_score(factors):
    """Compute composite ML score from factors."""
    score = BASE_SCORE
    for k, w in WEIGHTS.items():
        v = factors.get(k, 0.5)
        score += w * (v - 0.5)  # center at 0.5
    return score

def main():
    # Read input
    if len(sys.argv) >= 3 and sys.argv[1] == '--file':
        with open(sys.argv[2]) as f:
            stocks = json.load(f)
    else:
        stocks = json.load(sys.stdin)
    
    if not isinstance(stocks, list):
        stocks = [stocks]
    
    # ---- v10 MLP scorer (62-factor -> 59-core [64] 8-model ensemble) ----
    try:
        from ml_screener_v9 import compute_factors as v9_factors, MLPScreener
        _MLP_DIR = os.path.dirname(os.path.abspath(__file__))
        _V9W = os.path.join(_MLP_DIR, "..", "data", "stock_ml_model", "ml_mlp_weights.json")
        if not os.path.exists(_V9W):
            _V9W = os.path.join(_MLP_DIR, "ml_mlp_weights.json")
        mlp = MLPScreener(_V9W)
        v9_ok = True
    except Exception as e:
        print(f"⚠ v9 MLP disabled: {e}", file=sys.stderr)
        v9_ok = False

    # ---- v11 MLP scorer (72-feat -> 69-core, BOLL + SSE-index features) ----
    v11 = None
    v11_ok = False
    try:
        _DIR = os.path.dirname(os.path.abspath(__file__))
        if _DIR not in sys.path:
            sys.path.insert(0, _DIR)
        from ml_screener_v11 import V11Screener, compute_factors_v11
        _V11W = os.path.join(_DIR, "v11_weights.json")
        if os.path.exists(_V11W):
            v11 = V11Screener(_V11W)
            v11_ok = True
            print(f"✅ v11 active ({v11.feat_name.__len__()} feats × {len(v11.models)} models)",
                  file=sys.stderr)
        else:
            print("⚠ v11 weights not found, using v10", file=sys.stderr)
    except Exception as e:
        print(f"⚠ v11 disabled: {e}", file=sys.stderr)

    # ---- v10 风控过滤: 20日跌>20% 跳过 (2026-08-03 验证: 含熊市 Sharpe 0.64→0.81, MDD -41.3%→-30.2%) ----
    DROP20_THRESH = -0.20
    n_drop20 = 0

    # pass 1: linear + v10 mlp raw probability
    raw_items = []
    for stock in stocks:
        # 20日跌>20% 过滤 (接飞刀保护)
        _kl = stock.get("kline") or stock.get("kline_list") or []
        if len(_kl) >= 21:
            _c_now = _kl[-1].get("close")
            _c_20 = _kl[-21].get("close")
            if _c_now and _c_20 and _c_20 > 0 and (_c_now / _c_20 - 1) < DROP20_THRESH:
                n_drop20 += 1
                continue
        factors = compute_factors(stock)
        score = compute_score(factors)
        item = {
            "code": stock.get("code", ""),
            "name": stock.get("name", ""),
            "linear_score": round(score, 4),
            "mlp_prob": None,
            "factors": factors,
            "stock": stock,
        }
        if v11_ok:
            try:
                kl = stock.get("kline") or stock.get("kline_list") or []
                idx_close = stock.get("idx_close")
                v11f = compute_factors_v11(kl, idx_close) if kl else None
                if v11f is not None:
                    item["mlp_prob"] = v11.score_one(v11f)
            except Exception as e:
                print(f"⚠ v11 score failed {stock.get('code')}: {e}", file=sys.stderr)
        elif v9_ok:
            try:
                kl = stock.get("kline") or []
                if not kl:
                    # try nested kline from stock object
                    kl = stock.get("kline_list") or []
                v9f = v9_factors(kl) if kl else None
                if v9f is not None:
                    item["mlp_prob"] = mlp.score_one(v9f)
            except Exception as e:
                print(f"⚠ v9 score failed {stock.get('code')}: {e}", file=sys.stderr)
        raw_items.append(item)

    # pass 2: normalize mlp_prob -> 0-100.
    # Use percentile-rank (robust to skewed sigmoid outputs) when pool >= 5,
    # else fall back to linear [p1,p99] stretch.
    probs = np.array([it["mlp_prob"] for it in raw_items if it["mlp_prob"] is not None])
    if len(probs) > 0:
        lo, hi = float(np.percentile(probs, 1)), float(np.percentile(probs, 99))
    else:
        lo, hi = 0.0, 1.0
    if hi - lo < 1e-6:
        lo, hi = 0.0, 1.0
    use_rank = len(probs) >= 5
    if use_rank:
        order = np.argsort(np.argsort(-probs))  # 0 = best prob
        rank100 = 100.0 * (1.0 - order / max(len(probs) - 1, 1))

    results = []
    for it in raw_items:
        factors = it["factors"]
        score = it["linear_score"]
        
        # Scale linear score to 0-100 (empirically calibrated: -5→0, +8→100)
        score_normalized = min(100, max(0, (score + 5) / 13 * 100))
        
        p = it["mlp_prob"]
        if p is not None:
            if use_rank:
                idx = int(np.where(probs == p)[0][0])
                mlp_100 = float(rank100[idx])
            else:
                mlp_100 = min(100.0, max(0.0, (p - lo) / (hi - lo) * 100.0))
        else:
            mlp_100 = None
        
        # Generate signals
        signals = []
        if factors.get("sh_ma20_up", 0) > 0.5:
            signals.append("MA20↑")
        if factors.get("dif_above_zero", 0) > 0.5:
            signals.append("DIF>0")
        if factors.get("macd_hist_rising", 0) > 0.5:
            signals.append("MACD↑")
        if factors.get("rsi_low", 0) > 0.5:
            signals.append("RSI超卖")
        if factors.get("near_ma20", 0) > 0.7:
            signals.append("近MA20")
        if factors.get("vol_confirm", 0) > 0.5:
            signals.append("量能确认")
        if factors.get("vol_shrink_pullback", 0) > 0.7:
            signals.append("缩量回踩")
        if factors.get("break_pivot_top", 0) > 0.5:
            signals.append("突破中枢")
        if factors.get("rebound_pct", 0) > 0.7:
            signals.append("反弹中")
        
        results.append({
            "code": it["code"],
            "name": it["name"],
            "score": round(mlp_100, 1) if mlp_100 is not None else round(score_normalized, 1),
            "mlp_score": round(mlp_100, 1) if mlp_100 is not None else None,
            "mlp_prob": round(p, 4) if p is not None else None,
            "raw_score": round(score, 4),
            "linear_score": round(score_normalized, 1),
            "signals": signals,
            "metrics": {k: round(v, 3) for k, v in factors.items() if v != 0.5},
            "price": it["stock"].get("price", 0),
            "change_percent": it["stock"].get("change_percent", 0),
        })
    
    # Sort: mlp_score primary, linear as fallback
    results.sort(key=lambda r: (r["mlp_score"] if r["mlp_score"] is not None else -1), reverse=True)
    
    # Rank
    for i, r in enumerate(results):
        r["rank"] = i + 1
    
    output = {
        "total": len(results),
        "top_score": results[0]["score"] if results else 0,
        "model": "v11-mlp-69+drop20" if v11_ok else ("v10-mlp-59+drop20" if v9_ok else "v8-linear-37"),
        "n_drop20_filtered": n_drop20,
        "results": results,
    }
    
    print(json.dumps(output, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
