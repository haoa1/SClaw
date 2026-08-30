#!/usr/bin/env python3
"""
给指定股票池打 ML 分（双模型叠加用）— v12 版

用途：scheduler 跑缠论策略前，先对候选池调用 ML v12 模型打分，
     只保留 ML 分 >= minScore 的股票，实现"ML 高分池 + 缠论确认"。

v12 变更 (2026-08-07): 从 v10 (ml_screener.py) 切到 v12 (ml_screener_v12.py)
  - 87 核心特征 / 8-seed MLP 集成 / 含估值+龙虎榜+指数因子
  - 内联打分（不再 subprocess 调 ml_screener.py），数据源与 fetch_screen_v12.py 一致

输入 stdin: {"codes": ["600519", "000001", ...]}
输出 stdout: {"results": [{"code","name","score","v12_prob"}...], "total": N, "scored": N}

数据源：Sclaw SQLite (stock_history.db) + cloud_extra.db (估值/龙虎榜) + sh000001_daily.json (指数)
"""
import json, sys, os, sqlite3

SCLAW_DATA_DIR = "/root/sclaw/data"
ML_DIR = "/root/sclaw/ml_screener"
V12_WEIGHTS = os.path.join(ML_DIR, "v12_weights.json")
IDX_DAILY = os.path.join(ML_DIR, "sh000001_daily.json")
EXTRA_DB = os.path.join(SCLAW_DATA_DIR, "cloud_extra.db")

MIN_BARS = 60
_Q_K = ("SELECT date, open, high, low, close, volume, amount, change_pct, turnover_rate "
        "FROM stock_daily WHERE code=? ORDER BY date DESC LIMIT 120")
_Q_VAL = ("SELECT date, pe_ttm, pb_mrq, ps_ttm, pcf_ocf_ttm, peg, "
          "total_mktcap, float_mktcap, free_shares FROM value_daily "
          "WHERE code=? AND date >= date(?,'-60 days') AND date <= ?")
_Q_LHB = ("SELECT date, billboard_net FROM lhb_daily "
          "WHERE code=? AND date >= date(?,'-60 days') AND date <= ?")


def load_idx_daily():
    dmap = {}
    if os.path.exists(IDX_DAILY):
        try:
            d = json.load(open(IDX_DAILY))
            last = None
            for dt, cl in zip(d.get("dates", []), d.get("closes", [])):
                if cl is not None:
                    try:
                        last = float(cl)
                    except (TypeError, ValueError):
                        pass
                dmap[dt] = last
        except Exception as e:
            print(f"⚠ index load failed: {e}", file=sys.stderr)
    return dmap


def get_db():
    db_path = os.path.join(SCLAW_DATA_DIR, "stock_history.db")
    if not os.path.exists(db_path):
        print(f"❌ DB not found: {db_path}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        print(json.dumps({"total": 0, "results": [], "error": "bad stdin json"}))
        sys.exit(0)

    codes = data.get("codes", [])
    if not codes:
        print(json.dumps({"total": 0, "results": [], "scored": 0}))
        sys.exit(0)

    sys.path.insert(0, ML_DIR)
    from ml_screener_v12 import compute_factors_v12, V12Screener

    conn = get_db()
    ex = None
    if os.path.exists(EXTRA_DB):
        ex = sqlite3.connect(EXTRA_DB)
        ex.row_factory = sqlite3.Row
    idx_map = load_idx_daily()
    scr = V12Screener(V12_WEIGHTS)

    results = []
    code_set = list(dict.fromkeys(codes))
    for code in code_set:
        try:
            info = conn.execute("SELECT code, name, market FROM stock_info WHERE code=?",
                                (code,)).fetchone()
            if not info:
                continue
            ks = conn.execute(_Q_K, (code,)).fetchall()
            if len(ks) < MIN_BARS:
                continue
            ks = list(reversed(ks))
            closes = [k["close"] for k in ks]
            if closes[-1] < 1.0:
                continue
            kline = [{"date": k["date"], "open": k["open"], "high": k["high"],
                      "low": k["low"], "close": k["close"],
                      "volume": k["volume"] or 0, "amount": k["amount"] or 0,
                      "change_pct": k["change_pct"] or 0,
                      "turnover_rate": k["turnover_rate"] or 0} for k in ks]
            idx_close = [idx_map.get(d, 0.0) for d in [k["date"] for k in kline]]
            val_rows = lhb_rows = None
            if ex is not None:
                d_min = kline[0]["date"]
                val_rows = ex.execute(_Q_VAL, (code, d_min, ks[-1]["date"])).fetchall()
                lhb_rows = ex.execute(_Q_LHB, (code, d_min, ks[-1]["date"])).fetchall()
            factors = compute_factors_v12(kline, idx_close, val_rows, lhb_rows)
            if factors is None:
                continue
            p = scr.score_one(factors)
            results.append({"code": code, "name": info["name"],
                            "score": round(p * 100, 1), "v12_prob": round(p, 4)})
        except Exception as e:
            print(f"⚠ {code} failed: {e}", file=sys.stderr)

    conn.close()
    if ex is not None:
        ex.close()

    results.sort(key=lambda r: -r["score"])
    print(json.dumps({"total": len(code_set), "scored": len(results),
                      "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
