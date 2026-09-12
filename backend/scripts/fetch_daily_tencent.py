#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_daily_tencent.py — 用腾讯 newfqkline 建「干净日线库」（可信回测地基）

为什么换源（2026-09-11 取证）:
  - baostock: 8 并发把 IP 打进黑名单 ('黑名单用户')，不可用
  - 东财 push2his: 网络层阻断 (curl 000, IPv4/IPv6 均不通)
  - 本地 stock_history.db: 多源拼接 —— close 不复权(415 次 |日收益|>21%)、
    volume 单位按股票而异、amount 全 0、index_daily 0 行  => 不可用于"已验证"结论
  - 腾讯 newfqkline: 200 OK，且字段最全 ★

数据源: https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get
  param = <sym>,day,<beg>,<end>,<count>,qfq
  返回 data[sym].qfqday = [[日期, 开, 收, 高, 低, 量, {}, 换手率%, 成交额(万元), ...], ...]

关键事实（已实测）:
  1) count 上限 = 800 根；显式 end 生效 → 可向前翻页取长历史
  2) 翻页拼接安全：重叠日 qfq close 在不同请求中完全一致（前复权基准统一）
  3) 换手率(field 7) 与成交额(field 8) 直接给出，量纲自洽、可交叉校验
     (000001: 832461手 x100 x11.74 = 9.77亿 ≈ 成交额 9.8亿 ✓)
  4) ⚠️ volume 单位按板块不一致（科创观察到为"股"，主板/创业为"手"）
     => 绝对量一律用 amount/turn；volume 仅用于同一只股票内部的比值（量比）

用法:
  python3 fetch_daily_tencent.py [--start 2020-01-01] [--workers 6] [--limit N] [--max-pages 3]
"""
import argparse
import json
import os
import sqlite3
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SRC_DB = "/root/sclaw/backend/data/stock_history.db"
OUT_DB = "/root/sclaw/backend/data/clean_daily.db"
BASE = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get"

DDL = """
CREATE TABLE IF NOT EXISTS daily (
  code TEXT NOT NULL, date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL,
  volume REAL, amount REAL, turn REAL,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date);
CREATE INDEX IF NOT EXISTS idx_daily_code ON daily(code);
"""


def to_sym(code):
    # ⚠️ 腾讯要 sz000001（无点号），不要写成 sz.000001（那会返回 data:[]）
    if code.startswith(("6", "9")):
        return "sh" + code
    if code.startswith(("4", "8")):
        return "bj" + code
    return "sz" + code


def http_get(url, timeout=25, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf8", "ignore")
        except Exception as e:
            last = e
            time.sleep(0.6 * (i + 1))
    raise last


def fetch_page(sym, end, count=800):
    url = "%s?param=%s,day,,%s,%d,qfq" % (BASE, sym, end, count)
    txt = http_get(url)
    d = json.loads(txt)
    node = d.get("data", {}).get(sym)
    if not node:
        return []
    key = None
    for k in ("qfqday", "day", "hfqday"):
        if k in node and node[k]:
            key = k
            break
    if not key:
        return []
    return node[key]


def parse_rows(code, bars):
    out = []
    for b in bars:
        if len(b) < 9:
            continue
        def f(x):
            try:
                return float(x)
            except (TypeError, ValueError):
                return None
        amount = f(b[8])
        out.append((code, b[0], f(b[1]), f(b[3]), f(b[4]), f(b[2]),
                    f(b[5]), (amount * 1e4 if amount is not None else None), f(b[7])))
    return out


def worker(code, start, max_pages):
    sym = to_sym(code)
    rows, end, pages = [], time.strftime("%Y-%m-%d"), 0
    try:
        while pages < max_pages:
            bars = fetch_page(sym, end, 800)
            pages += 1
            if not bars:
                break
            rows = parse_rows(code, bars) + rows
            first = bars[0][0]
            if first <= start:
                break
            y, m, dd = (int(x) for x in first.split("-"))
            dd -= 1
            if dd < 1:
                m -= 1
                if m < 1:
                    y, m = y - 1, 12
                dd = 28
            end = "%04d-%02d-%02d" % (y, m, dd)
        if not rows:
            return code, 0, "empty"
        # 去重（翻页重叠日）
        ded = {}
        for r in rows:
            ded[(r[0], r[1])] = r
        vals = list(ded.values())
        conn = sqlite3.connect(OUT_DB, timeout=60)
        try:
            conn.executescript(DDL)
            conn.executemany(
                """INSERT OR REPLACE INTO daily
                   (code,date,open,high,low,close,volume,amount,turn)
                   VALUES (?,?,?,?,?,?,?,?,?)""", vals)
            conn.commit()
        finally:
            conn.close()
        return code, len(vals), "ok"
    except Exception as e:
        return code, 0, "error:%s" % str(e)[:80]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2020-01-01")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-pages", type=int, default=3)
    ap.add_argument("--codes", default="")
    a = ap.parse_args()

    if a.codes:
        codes = [c.strip() for c in a.codes.split(",") if c.strip()]
    else:
        conn = sqlite3.connect("file:%s?mode=ro" % SRC_DB, uri=True)
        codes = set()
        try:
            codes |= {r[0] for r in conn.execute("SELECT code FROM stock_info")}
        except Exception:
            pass
        try:
            codes |= {r[0] for r in conn.execute("SELECT DISTINCT code FROM stock_daily")}
        except Exception:
            pass
        conn.close()
        codes = sorted(c for c in codes if c and len(c) == 6 and c.isdigit() and c[0] in "0368")
    if a.limit:
        codes = codes[: a.limit]

    print("[fetch_tx] start=%s workers=%d max_pages=%d 股票池=%d" % (a.start, a.workers, a.max_pages, len(codes)), flush=True)
    t0 = time.time()
    st = {"ok": 0, "empty": 0}
    errs, total, done = [], 0, 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(worker, c, a.start, a.max_pages): c for c in codes}
        for fut in as_completed(futs):
            code, n, status = fut.result()
            done += 1
            total += n
            if status in st:
                st[status] += 1
            else:
                errs.append("%s:%s" % (code, status))
            if done % 50 == 0 or done == len(codes):
                el = time.time() - t0
                print("[%d/%d] +%d行 ok=%d empty=%d err=%d %.0fs %.1f/s"
                      % (done, len(codes), total, st["ok"], st["empty"], len(errs), el, done / max(el, 1)), flush=True)
    print("[fetch_tx] DONE rows=%d ok=%d empty=%d err=%d elapsed=%.0fs"
          % (total, st["ok"], st["empty"], len(errs), time.time() - t0), flush=True)
    if errs:
        print("  err sample:", errs[:8], flush=True)


if __name__ == "__main__":
    main()
