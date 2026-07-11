#!/usr/bin/env python3
"""
BJ 股票 K线数据获取 — 通过 akshare stock_zh_a_daily (新浪数据源)
被 data-sync.ts 作为子进程调用，输出 JSON 到 stdout

用法:
  python3 fetch_bj_via_akshare.py <code> <start_date> <end_date> [adjust]

输出: JSON 数组 [{date, open, close, high, low, volume}, ...]
"""
import sys
import json
import traceback

try:
    import akshare as ak
except ImportError:
    print(json.dumps({"error": "akshare not installed"}))
    sys.exit(1)

def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: fetch_bj_via_akshare.py <code> <start_date> <end_date> [adjust]"}))
        sys.exit(1)

    code = sys.argv[1]
    start_date = sys.argv[2]
    end_date = sys.argv[3]
    adjust = sys.argv[4] if len(sys.argv) > 4 else "qfq"

    symbol = f"bj{code}"

    try:
        df = ak.stock_zh_a_daily(
            symbol=symbol,
            start_date=start_date,
            end_date=end_date,
            adjust=adjust,
        )

        records = []
        for _, row in df.iterrows():
            records.append({
                "date": str(row["date"])[:10],
                "open": float(row["open"]),
                "close": float(row["close"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "volume": int(row["volume"]),
            })

        print(json.dumps(records))

    except Exception as e:
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)

if __name__ == "__main__":
    main()
