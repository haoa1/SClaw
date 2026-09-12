#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backfill_m30.py — 用 baostock 补齐本地 stock_kline_30m 表到最近 1 年

背景:
  现有 sync_minute_kline.py 用腾讯 mkline 接口, 单只最多返回 800 根 30m (~5个月),
  无法覆盖完整 1 年。baostock 可拉到完整历史 (frequency=30, adjustflag=2 前复权)。

关键决策:
  - 用 ProcessPoolExecutor 而非 ThreadPoolExecutor
      -> baostock 非线程安全, 并发访问会污染 get_row_data (list index out of range)
      -> 进程池内每进程独立 baostock 实例, 完全隔离, 已验证安全
      -> 每进程独立 sqlite 连接 (check_same_thread=False 配合进程内单线程)
  - 前复权 (adjustflag=2), 与腾讯源现有数据口径对齐 (已验证 2025-12-17 一致)
  - INSERT OR REPLACE 幂等合并, 不破坏已有数据
  - 退市/停牌股 (baostock 无数据) 标记 empty 跳过, 不视为错误

用法:
  python3 backfill_m30.py --start 2025-09-08 [--end YYYY-MM-DD] [--period 30|60]
                          [--workers 4] [--limit N] [--codes A,B]

量纲约定 (2026-09-12 实测校准):
  stock_kline_30m : volume 单位=股, amount 单位=元   (baostock 原生)
  stock_kline_60m : volume 单位=手(=股/100), amount 单位=元
  ⇒ period=60 写库时 volume/100, 与表内既有数据(手)保持一致
  价格口径: baostock adjustflag=2 (前复权), 与表内既有 1 年数据一致
"""
import argparse
import sqlite3
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

DB_PATH = "/root/sclaw/backend/data/stock_history.db"
FIELDS = "date,time,open,high,low,close,volume,amount"

# period -> (baostock frequency, 目标表, volume 除数)
PERIODS = {
    30: ("30", "stock_kline_30m", 1.0),     # 表内 volume 单位=股
    60: ("60", "stock_kline_60m", 100.0),   # 表内 volume 单位=手
}

_SESSION = {"logged": False}


def _detect_symbol(code: str) -> str:
    # baostock 格式: sh.600000 / sz.000001 / bj.830000
    if code.startswith(("6", "9")):
        return "sh." + code
    if code.startswith(("8", "4")):
        return "bj." + code
    return "sz." + code


def _fmt_dt(dt: str) -> str:
    # '20251217100000000' -> '2025-12-17 10:00'
    if len(dt) >= 12:
        return f"{dt[0:4]}-{dt[4:6]}-{dt[6:8]} {dt[8:10]}:{dt[10:12]}"
    return dt


def _ensure_login():
    """每个进程只 login 一次, 复用到进程结束 (省掉每只票一次握手)"""
    import baostock as bs
    if _SESSION["logged"]:
        return True
    lg = bs.login()
    _SESSION["logged"] = lg.error_code == "0"
    return _SESSION["logged"]


def worker(code: str, start: str, end: str, period: int = 30):
    """在独立进程内拉取并写入一只股票, 返回 (code, rows, status)"""
    import baostock as bs
    freq, table, vol_div = PERIODS[period]
    if not _ensure_login():
        return code, 0, "login_fail"
    try:
        sym = _detect_symbol(code)
        rs = bs.query_history_k_data_plus(
            sym, FIELDS, start_date=start, end_date=end, frequency=freq, adjustflag="2"
        )
        if rs.error_code != "0":
            return code, 0, "query_err"
        bars = []
        while rs.error_code == "0" and rs.next():
            row = rs.get_row_data()
            if len(row) >= 8:
                dt = _fmt_dt(row[1])
                try:
                    bars.append({
                        "code": code,
                        "datetime": dt,
                        "open": float(row[2]),
                        "high": float(row[3]),
                        "low": float(row[4]),
                        "close": float(row[5]),
                        "volume": (float(row[6]) / vol_div) if row[6] else 0.0,
                        "amount": float(row[7]) if row[7] else 0.0,
                    })
                except ValueError:
                    continue
        if not bars:
            return code, 0, "empty"

        # 独立进程内逐一写库 (进程隔离, 单线程访问)
        conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        try:
            conn.executemany(
                """INSERT OR REPLACE INTO %s
                   (code, datetime, open, high, low, close, volume, amount)
                   VALUES (:code, :datetime, :open, :high, :low, :close, :volume, :amount)""" % table,
                bars,
            )
            conn.commit()
        finally:
            conn.close()
        return code, len(bars), "ok"
    except Exception as e:
        return code, 0, f"error:{e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-09-08", help="1年起点 YYYY-MM-DD")
    ap.add_argument("--end", default="", help="截止日, 默认今天")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 只 (0=全量)")
    ap.add_argument("--codes", default="", help="逗号分隔 code 列表, 覆盖股票池")
    ap.add_argument("--period", type=int, default=30, choices=[30, 60],
                    help="30=stock_kline_30m(默认) / 60=stock_kline_60m")
    args = ap.parse_args()

    end = args.end or time.strftime("%Y-%m-%d")
    freq, table, vol_div = PERIODS[args.period]
    print(f"[backfill_m30] period={args.period}({freq}m) -> {table} vol_div={vol_div} "
          f"start={args.start} end={end} workers={args.workers}")

    if args.codes:
        codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    else:
        conn = sqlite3.connect(DB_PATH)
        codes = [r[0] for r in conn.execute("SELECT code FROM stock_info ORDER BY code").fetchall()]
        conn.close()
    if args.limit:
        codes = codes[: args.limit]
    print(f"[backfill_m30] 股票池 {len(codes)} 只")

    t0 = time.time()
    done = 0
    total_rows = 0
    stats = {"ok": 0, "empty": 0, "login_fail": 0, "query_err": 0, "error": []}

    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(worker, c, args.start, end, args.period): c for c in codes}
        for fut in as_completed(futs):
            code, n, status = fut.result()
            done += 1
            total_rows += n
            stats[status if status in stats else "error"] += 1
            if status not in ("ok", "empty", "login_fail", "query_err"):
                stats["error"] = [e for e in stats["error"] if not e.startswith(code)]
                stats["error"].append(f"{code}: {status}")
            if done % 100 == 0 or done == len(codes):
                el = time.time() - t0
                print(f"[{done}/{len(codes)}] +{total_rows}行 ok={stats['ok']} empty={stats['empty']} "
                      f"err={len(stats['error'])} elapsed={el:.0f}s rate={done/el:.1f}/s")

    el = time.time() - t0
    print(f"\n[backfill_m30] DONE: {done}/{len(codes)} stocks, +{total_rows}行, "
          f"ok={stats['ok']} empty={stats['empty']} login_fail={stats['login_fail']} "
          f"query_err={stats['query_err']} errors={len(stats['error'])} elapsed={el:.0f}s")
    if stats["error"]:
        print("  errors sample:", stats["error"][:10])


if __name__ == "__main__":
    main()
