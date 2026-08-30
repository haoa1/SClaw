#!/usr/bin/env python3
"""
Fetch stock data from Sclaw SQLite DB and run ML factor screener.

Usage:
  python3 /root/sclaw/ml_screener/fetch_and_screen.py [limit=30] [--min-score=0]
  python3 /root/sclaw/ml_screener/fetch_and_screen.py --quick   (debug: 20 stocks with most data)
  python3 /root/sclaw/ml_screener/fetch_and_screen.py --no-st-filter   (include ST/退市 stocks)

v2 behavior (2026-08-05):
  - FULL-MARKET scoring: scores ALL stocks with >=60 data days (~5,300), then
    outputs top-N by score.  No more "data coverage sampling" bias.
  - ST/退市/星号 name filter ON by default (they dominate the high-score list
    but are not tradeable); disable with --no-st-filter.
  - limit=N now means "output top N by score" (default 30).

Output: JSON with ranked results to stdout, summary to stderr.

Uses Sclaw's stock_history.db tables:
  - stock_info: code, name, market (5,721 stocks)
  - stock_daily: code, date, open, high, low, close, volume, amount, change_pct, turnover_rate (~5M records)
"""

import json, sys, os, subprocess, sqlite3, re, time

SCLAW_DATA_DIR = "/root/sclaw/data"
ML_SCREENER = "/root/sclaw/ml_screener/ml_screener_v11.py"
V11_WEIGHTS = "/root/sclaw/ml_screener/v11_weights.json"
IDX_DAILY = "/root/sclaw/ml_screener/sh000001_daily.json"

_ST_RE = re.compile(r"ST|\*|退", re.IGNORECASE)
_NUM_ONLY_RE = re.compile(r"^\d+$")
_IDX_CACHE = None

def _is_delisted_or_st(code, name):
    """判断 ST / 退市 / 名称缺失(纯代码) 标的。

    - name 含 ST/*/退  → 直接剔除
    - name 为空        → 信息缺失，无法验证，剔除
    - name == code(纯数字) → 本地 DB 里该股 name 未更新，多为退市/更名/停牌，
      剔除（正常交易股票 name 都应有中文名）
    """
    if not name:
        return True
    if _NUM_ONLY_RE.match(name.strip()):
        return True
    return bool(_ST_RE.search(name))

def load_idx_daily():
    """Load SSE index daily closes → {date: close} with ffill (nearest prior)."""
    global _IDX_CACHE
    if _IDX_CACHE is not None:
        return _IDX_CACHE
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
    _IDX_CACHE = dmap
    return dmap

def align_idx_close(kline_dates):
    """Return idx_close list aligned to kline dates (ffill, 0 if missing)."""
    dmap = load_idx_daily()
    return [dmap.get(d, 0.0) for d in kline_dates]

def get_db():
    db_path = os.path.join(SCLAW_DATA_DIR, "stock_history.db")
    if not os.path.exists(db_path):
        print(f"❌ DB not found: {db_path}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def _build_stock(code, ks, info_map):
    """Assemble one stock dict from kline rows."""
    if len(ks) < 20:  # Need at least 20 days for MA20
        return None
    ks = ks[-60:]
    latest = ks[-1]
    info = info_map.get(code)
    closes = [k["close"] for k in ks]
    vols = [k["volume"] for k in ks]
    avg_vol_20 = sum(vols[-20:]) / 20 if len(vols) >= 20 else 1
    return {
        "code": code,
        "name": (info["name"] if info and info["name"] else code),
        "market": (info["market"] if info else ""),
        "price": latest["close"],
        "change_percent": latest["change_pct"] or 0,
        "volume": latest["volume"],
        "turnover": latest["amount"],
        "volume_ratio": latest["volume"] / avg_vol_20 if avg_vol_20 > 0 else 1.0,
        "turnover_rate": latest["turnover_rate"] or 0,
        "pe": None,   # Not stored in this DB
        "pb": None,
        "market_cap": None,
        "high": latest["high"],
        "low": latest["low"],
        "kline": [
            {
                "date": k["date"],
                "open": k["open"],
                "high": k["high"],
                "low": k["low"],
                "close": k["close"],
                "volume": k["volume"],
                "amount": k["amount"] if k["amount"] is not None else 0,
                "change_pct": k["change_pct"] if k["change_pct"] is not None else 0
            } for k in ks
        ],
        "idx_close": align_idx_close([k["date"] for k in ks]),
    }

def fetch_stocks(conn, st_filter=True):
    """Fetch ALL stocks with >=60 days of kline (full market, ~5,300)."""
    t0 = time.time()
    print(f"  Finding all stocks with 60+ data days...", file=sys.stderr)
    codes = conn.execute("""
        SELECT code, COUNT(*) as days FROM stock_daily
        GROUP BY code HAVING days >= 60 ORDER BY code
    """).fetchall()
    all_count = len(codes)
    print(f"  Found {all_count} stocks with 60+ days ({time.time()-t0:.1f}s)", file=sys.stderr)

    info_map = {r["code"]: r for r in conn.execute(
        "SELECT code, name, market FROM stock_info").fetchall()}

    if st_filter:
        before = len(codes)
        def _keep(c):
            info = info_map.get(c["code"])
            if info is None:
                # 有日线但 stock_info 无记录 → 数据异常/退市，不冒险
                return False
            return not _is_delisted_or_st(c["code"], info["name"] or "")
        codes = [c for c in codes if _keep(c)]
        print(f"  ST/退市过滤: {before} -> {len(codes)}", file=sys.stderr)

    stocks = []
    for row in codes:
        code = row["code"]
        ks = conn.execute("""
            SELECT date, open, high, low, close, volume, amount, change_pct, turnover_rate
            FROM stock_daily WHERE code=? ORDER BY date DESC LIMIT 60
        """, (code,)).fetchall()
        ks.reverse()
        stock = _build_stock(code, ks, info_map)
        if stock:
            stocks.append(stock)
    print(f"  Prepared {len(stocks)} stocks ({time.time()-t0:.1f}s)", file=sys.stderr)
    return stocks

def fetch_stocks_quick(conn, limit=20):
    """Legacy quick mode: `limit` stocks with most data coverage (debug only)."""
    print(f"  Quick mode: top {limit} by data coverage...", file=sys.stderr)
    cursor = conn.execute("""
        SELECT code, COUNT(*) as days FROM stock_daily
        GROUP BY code HAVING days >= 60 ORDER BY days DESC LIMIT ?
    """, (limit * 2,))
    info_map = {r["code"]: r for r in conn.execute(
        "SELECT code, name, market FROM stock_info").fetchall()}
    stocks = []
    for row in cursor.fetchall():
        code = row["code"]
        ks = conn.execute("""
            SELECT date, open, high, low, close, volume, amount, change_pct, turnover_rate
            FROM stock_daily WHERE code=? ORDER BY date DESC LIMIT 60
        """, (code,)).fetchall()
        ks.reverse()
        stock = _build_stock(code, ks, info_map)
        if stock:
            stocks.append(stock)
        if len(stocks) >= limit:
            break
    print(f"  Quick: {len(stocks)} stocks", file=sys.stderr)
    return stocks

def run_ml_screener(stocks):
    """Pipe stocks to ml_screener.py and return results."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(stocks, f)
        spath = f.name
    try:
        result = subprocess.run(
            [sys.executable, ML_SCREENER, V11_WEIGHTS, spath, IDX_DAILY],
            capture_output=True,
            text=True,
            timeout=900
        )
    finally:
        os.unlink(spath)
    if result.returncode != 0:
        print(f"❌ ML screener error: {result.stderr[:500]}", file=sys.stderr)
        return {"total": 0, "results": []}
    return json.loads(result.stdout)

def main():
    limit = 30          # output top-N by score (full-market scoring)
    min_score = 0
    quick = False
    st_filter = True
    for arg in sys.argv[1:]:
        if arg.startswith("limit="):
            limit = int(arg.split("=")[1])
        elif arg.startswith("--min-score="):
            min_score = float(arg.split("=")[1])
        elif arg == "--quick":
            quick = True
            limit = 20
        elif arg == "--no-st-filter":
            st_filter = False

    conn = get_db()
    if quick:
        print(f"🔍 ML Screener: quick mode (debug)...", file=sys.stderr)
        stocks = fetch_stocks_quick(conn, limit=20)
    else:
        print(f"🔍 ML Screener: full-market scoring, output top {limit}...", file=sys.stderr)
        stocks = fetch_stocks(conn, st_filter=st_filter)
    conn.close()

    if not stocks:
        print(json.dumps({"total": 0, "results": [], "error": "No stock data with 60+ days available"}, ensure_ascii=False))
        sys.exit(0)

    t0 = time.time()
    print(f"📊 Running ML factor model on {len(stocks)} stocks (~{int((time.time()-t0))}s elapsed)...", file=sys.stderr)
    results = run_ml_screener(stocks)
    print(f"  ML scoring done in {time.time()-t0:.0f}s", file=sys.stderr)

    if results.get("results"):
        # Sort by score desc, re-assign rank, then take top N
        results["results"].sort(key=lambda r: r.get("score", 0), reverse=True)
        for i, r in enumerate(results["results"]):
            r["rank"] = i + 1
        results["total"] = len(results["results"])
        if min_score > 0:
            results["results"] = [r for r in results["results"] if r["score"] >= min_score]
            results["total"] = len(results["results"])
        if limit and limit < results["total"]:
            results["results"] = results["results"][:limit]
            results["total"] = len(results["results"])

    top = results.get("results", [])[:5]
    if top:
        print(f"\n🏆 Top {len(top)} ML picks (full-market):", file=sys.stderr)
        for r in top:
            sigs = " ".join(r.get("signals", []))
            print(f"  #{r['rank']} {r['code']} {r['name']:8s} | 评分:{r['score']:5.1f} | 涨跌:{r.get('change_percent',0):+6.2f}% | {sigs}", file=sys.stderr)
    else:
        print(f"\nNo stocks scored above {min_score}", file=sys.stderr)

    print(json.dumps(results, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
