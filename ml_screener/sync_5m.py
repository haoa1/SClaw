#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_5m.py — 全市场 5 分钟 K 线同步 (腾讯 ifzq.gtimg.cn mkline)
数据源: https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={sym},m5,,800
  - m5 最多 800 根 (~16个交易日), 字段 [datetime, open, close, high, low, volume, {}, amount]
  - datetime '202608041055' → '2026-08-04 10:55'
入库: /root/sclaw/data/stock_5m.db 表 stock_kline_5m (独立库, 避免撑爆主库)
  PRIMARY KEY (code, datetime), INSERT OR REPLACE 幂等增量
增量: 只保留最近 --keep-days 个交易日的 bars (默认3天), 每日收盘后跑即为增量
Usage:
  python3 sync_5m.py [--workers=12] [--limit=N] [--keep-days=3] [--skip-synced]
"""
import json
import sqlite3
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_PATH = "/root/sclaw/data/stock_5m.db"
API = "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}
TABLE = "stock_kline_5m"

# ---- 全局限速: 防止密集请求触发腾讯风控 ----
MIN_INTERVAL = 0.04  # 单个请求最小间隔(s) -> 理论 25 req/s
_lock = threading.Lock()
_last_req = 0.0


def _throttle():
    global _last_req
    with _lock:
        now = time.monotonic()
        wait = MIN_INTERVAL - (now - _last_req)
        if wait > 0:
            time.sleep(wait)
        _last_req = time.monotonic()


def detect_symbol(code: str) -> str:
    if code.startswith(("6", "9")):
        return "sh" + code
    if code.startswith(("8", "4")):
        return "bj" + code
    return "sz" + code


def fmt_dt(dt: str) -> str:
    # '202608041055' -> '2026-08-04 10:55'
    return f"{dt[0:4]}-{dt[4:6]}-{dt[6:8]} {dt[8:10]}:{dt[10:12]}" if len(dt) >= 12 else dt


def fetch_5m(sym: str, count: int = 800, retries: int = 3):
    url = f"{API}?param={sym},m5,,{count}"
    for attempt in range(retries):
        try:
            _throttle()
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
            data = d.get("data", {}).get(sym, {})
            kline = data.get("m5")
            if not kline:
                return None
            bars = []
            for k in kline:
                if len(k) < 6:
                    continue
                bars.append({
                    "datetime": fmt_dt(k[0]),
                    "open": float(k[1]),
                    "close": float(k[2]),
                    "high": float(k[3]),
                    "low": float(k[4]),
                    "volume": float(k[5]) if k[5] else 0.0,
                    "amount": float(k[6]) if len(k) > 6 and k[6] else 0.0,
                })
            return bars
        except Exception as e:
            if attempt == retries - 1:
                print(f"  [ERR] {sym}: {e}", file=sys.stderr)
                return None
            time.sleep(1 + attempt)
    return None


def init_db(conn):
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            code TEXT NOT NULL,
            datetime TEXT NOT NULL,
            open REAL, high REAL, low REAL, close REAL,
            volume REAL, amount REAL,
            PRIMARY KEY (code, datetime)
        )""")
    conn.commit()


def main():
    workers = 10
    limit = None
    keep_days = 3
    skip_synced = False
    for arg in sys.argv[1:]:
        if arg.startswith("--workers="):
            workers = int(arg.split("=")[1])
        elif arg.startswith("--limit="):
            limit = int(arg.split("=")[1])
        elif arg.startswith("--keep-days="):
            keep_days = int(arg.split("=")[1])
        elif arg == "--skip-synced":
            skip_synced = True

    conn = sqlite3.connect(DB_PATH, timeout=30)
    init_db(conn)
    cur = conn.cursor()

    # 代码池来自主库 stock_history.db 的 stock_info
    src = sqlite3.connect("/root/sclaw/data/stock_history.db")
    codes = [r[0] for r in src.execute("SELECT code FROM stock_info ORDER BY code")]
    src.close()
    if skip_synced:
        have = set(r[0] for r in cur.execute(f"SELECT DISTINCT code FROM {TABLE}"))
        before = len(codes)
        codes = [c for c in codes if c not in have]
        print(f"[5m-sync] skip-synced: {before} -> {len(codes)} todo", file=sys.stderr)
    if limit:
        codes = codes[:limit]

    # 保留交易窗口天数: keep_days>0 用指定值, 否则用防御上限(>腾讯17天, 清停牌残渣)
    window = keep_days if keep_days > 0 else 18
    cutoff = None
    try:
        cal = sqlite3.connect("/root/sclaw/data/stock_history.db")
        rows = cal.execute(
            "SELECT date FROM trading_calendar WHERE is_trading_day=1 AND date<=? ORDER BY date DESC LIMIT ?",
            (time.strftime("%Y-%m-%d"), window)).fetchall()
        cal.close()
        if len(rows) == window:
            cutoff = rows[-1][0]  # 最早保留日
    except Exception:
        pass
    if cutoff is None:
        # 兜底: 从现有5m数据取最近N个交易日
        rows = conn.execute(
            f"SELECT DISTINCT substr(datetime,1,10) d FROM {TABLE} "
            f"ORDER BY d DESC LIMIT {window}").fetchall()
        if len(rows) == window:
            cutoff = rows[-1][0]
    if cutoff:
        print(f"[5m-sync] 窗口模式: 保留 >= {cutoff} ({window} 个交易日)", file=sys.stderr)

    print(f"[5m-sync] {len(codes)} stocks, workers={workers}, keep_days={keep_days}", file=sys.stderr)
    total_bars = 0
    total_stocks = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_5m, detect_symbol(c)): c for c in codes}
        done = 0
        for fut in as_completed(futures):
            code = futures[fut]
            bars = fut.result()
            done += 1
            if bars:
                if cutoff:
                    bars = [b for b in bars if b["datetime"][:10] >= cutoff]
                if bars:
                    rows = [(code, b["datetime"], b["open"], b["high"], b["low"],
                             b["close"], b["volume"], b["amount"]) for b in bars]
                    conn.executemany(
                        f"INSERT OR REPLACE INTO {TABLE} "
                        "(code, datetime, open, high, low, close, volume, amount) "
                        "VALUES (?,?,?,?,?,?,?,?)", rows)
                    total_bars += len(bars)
                    total_stocks += 1
            if done % 200 == 0:
                conn.commit()
                print(f"  [{done}/{len(futures)}] {time.time()-t0:.0f}s "
                      f"{total_bars}bars/{total_stocks}st", file=sys.stderr, flush=True)
    conn.commit()
    # 窗口裁剪: 清理 cutoff 之前的旧数据(防停牌股残留)。仅全量模式执行, 避免分片/limit误删未同步股票
    if cutoff and not limit:
        n_del = cur.execute(
            "DELETE FROM stock_kline_5m WHERE substr(datetime,1,10) < ?", (cutoff,)).rowcount
        conn.commit()
        if n_del:
            print(f"[5m-sync] 清理 < {cutoff} 旧数据: {n_del:,} bars", file=sys.stderr)
    conn.close()
    print(f"[5m-sync] DONE {time.time()-t0:.0f}s | {total_stocks}stocks/{total_bars}bars")


if __name__ == "__main__":
    main()
