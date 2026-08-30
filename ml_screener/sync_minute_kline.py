#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_minute_kline.py — 全市场 30/60 分钟 K 线同步 (腾讯 ifzq.gtimg.cn)

数据源: https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={sym},m30,,800
  - m30 最多 800 根 (~5个月), m60 最多 800 根 (~10个月)
  - 字段: [datetime, open, close, high, low, volume, {}, amount]
  - datetime 格式 '202606181000' → '2026-06-18 10:00'

入库: /root/sclaw/data/stock_history.db 新表 stock_kline_30m / stock_kline_60m
  PRIMARY KEY (code, datetime), INSERT OR REPLACE 幂等增量

Usage:
  python3 sync_minute_kline.py [--workers=8] [--limit=N] [--periods=m30,m60]
"""
import json
import os
import sqlite3
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_PATH = "/root/sclaw/data/stock_history.db"
API = "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}

TABLES = {
    "m30": "stock_kline_30m",
    "m60": "stock_kline_60m",
}


def detect_symbol(code: str) -> str:
    if code.startswith(("6", "9")):
        return "sh" + code
    if code.startswith(("8", "4")):
        return "bj" + code
    return "sz" + code


def fmt_dt(dt: str) -> str:
    # '202606181000' -> '2026-06-18 10:00'
    return f"{dt[0:4]}-{dt[4:6]}-{dt[6:8]} {dt[8:10]}:{dt[10:12]}" if len(dt) >= 12 else dt


def fetch_minute(sym: str, period: str, count: int = 800, retries: int = 3):
    url = f"{API}?param={sym},{period},,{count}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
            data = d.get("data", {}).get(sym, {})
            kline = data.get(period)
            if not kline:
                return None
            bars = []
            for k in kline:
                if len(k) < 7:
                    continue
                bars.append({
                    "datetime": fmt_dt(k[0]),
                    "open": float(k[1]),
                    "close": float(k[2]),
                    "high": float(k[3]),
                    "low": float(k[4]),
                    "volume": float(k[5]) if k[5] else 0.0,
                    "amount": float(k[6]) if k[6] else 0.0,
                })
            return bars
        except Exception as e:
            if attempt == retries - 1:
                print(f"  [ERR] {sym} {period}: {e}", file=sys.stderr)
                return None
            time.sleep(1 + attempt)
    return None


def init_db(conn):
    for period, table in TABLES.items():
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                code TEXT NOT NULL,
                datetime TEXT NOT NULL,
                open REAL, high REAL, low REAL, close REAL,
                volume REAL, amount REAL,
                PRIMARY KEY (code, datetime)
            )""")
    conn.commit()


def main():
    workers = 8
    limit = None
    periods = ["m30", "m60"]
    skip_synced = False
    for arg in sys.argv[1:]:
        if arg.startswith("--workers="):
            workers = int(arg.split("=")[1])
        elif arg.startswith("--limit="):
            limit = int(arg.split("=")[1])
        elif arg.startswith("--periods="):
            periods = arg.split("=")[1].split(",")
        elif arg == "--skip-synced":
            skip_synced = True

    conn = sqlite3.connect(DB_PATH, timeout=30)
    init_db(conn)

    cur = conn.cursor()
    cur.execute("SELECT code FROM stock_info ORDER BY code")
    codes = [r[0] for r in cur.fetchall()]
    if skip_synced:
        have = set()
        for p in periods:
            cur.execute(f"SELECT DISTINCT code FROM {TABLES[p]}")
            have |= {r[0] for r in cur.fetchall()}
        before = len(codes)
        codes = [c for c in codes if c not in have]
        print(f"[minute-sync] skip-synced: {before} -> {len(codes)} todo", file=sys.stderr)
    if limit:
        codes = codes[:limit]
    print(f"[minute-sync] {len(codes)} stocks x {periods} workers={workers}", file=sys.stderr)

    total_bars = {p: 0 for p in periods}
    total_stocks = {p: 0 for p in periods}
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        for code in codes:
            sym = detect_symbol(code)
            for p in periods:
                futures[pool.submit(fetch_minute, sym, p)] = (code, p)
        done = 0
        for fut in as_completed(futures):
            code, p = futures[fut]
            bars = fut.result()
            done += 1
            if bars:
                rows = [(code, b["datetime"], b["open"], b["high"], b["low"],
                         b["close"], b["volume"], b["amount"]) for b in bars]
                conn.executemany(
                    f"INSERT OR REPLACE INTO {TABLES[p]} "
                    "(code, datetime, open, high, low, close, volume, amount) "
                    "VALUES (?,?,?,?,?,?,?,?)", rows)
                total_bars[p] += len(bars)
                total_stocks[p] += 1
            if done % 200 == 0:
                conn.commit()
                print(f"  [{done}/{len(futures)}] {time.time()-t0:.0f}s "
                      f"30m:{total_bars['m30']}bars/{total_stocks['m30']}st "
                      f"60m:{total_bars['m60']}bars/{total_stocks['m60']}st",
                      file=sys.stderr, flush=True)
    conn.commit()
    conn.close()
    print(f"[minute-sync] DONE {time.time()-t0:.0f}s | "
          f"30m:{total_stocks['m30']}stocks/{total_bars['m30']}bars | "
          f"60m:{total_stocks['m60']}stocks/{total_bars['m60']}bars")


if __name__ == "__main__":
    main()
