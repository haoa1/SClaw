#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Step 3c：大盘腿（上证指数）日线 MACD + D 态序列 —— 报表的第二条腿。

为什么要有这一步
--------------
Jack 2026-09-13 反馈：报表只有个股腿（S 态），看不到「上证 MACD 走势」，
于是 regime_matrix 的每个格 «D×S» 里那一半（D）在图上没有任何依据。
本步把大盘腿算出来落盘，供 step4_render 画：
  (a) 每票图里一条「上证大盘 MACD」面板（与个股面板同窗口、同 x 轴）；
  (b) 报表顶部的「上证 MACD 走势总览」。

口径（与 self-evolving-stock/references/regime_matrix.md 规格 §1 同源）
--------------------------------------------------------------
- 指数：上证综指 000001（东财 secid=1.000001），日线收盘。
- MACD：(12,26,9)，红绿柱 = 2·(DIF−DEA)。实现直接 import step3b_enrich，
  **不另写第二份**（个股腿/大盘腿必须同一实现，否则两腿不可比）。
- D 态：regime_matrix.classify_state 同规格，逐日「前缀判定」
  （D1 红强 / D2 红弱 / D3 绿缩 / D4 绿强），与生产 index_state_history 同语义。

来源优先级
--------
本地缓存 CSV（默认 DATA/index_daily_000001.csv，列 date,close）
  → 东财 → 新浪 → 腾讯。缓存命中即离线复现；缓存文件 md5 记入 meta 随报表可追溯。
（研究档案 /root/research_archive/regime_matrix_backtest_20260913/index_daily_000001.csv 与
 本文件同源 —— 就是 regime_matrix 回测裁决用的那条指数序列。）

输出
----
index_metrics.json : { meta:{...}, series:[[date, close, dif, dea, hist, state], ...] }

自检（强校验，跨源）
------------------
用本步重算的 D 态，与 cache_charts.json 里**每一笔交易的 D 标签**逐一比对 ——
那些标签来自生产策略自己的大盘腿。一致率 < 99% 即口径不一致，必须排查
（可能是指数错、复权错、或 MACD 实现差异）。
"""
import hashlib
import json
import os
import socket
import sys
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, DIR)
from step3b_enrich import classify_state, macd  # noqa: E402  同一实现，勿复制


def _arg(flag, default):
    a = sys.argv
    return a[a.index(flag) + 1] if flag in a else default


DATA = _arg("--data", "/root/research_archive/losers_charts_20260913")
CACHE = _arg("--cache", os.path.join(DATA, "index_daily_000001.csv"))
OUT = _arg("--out", os.path.join(DATA, "index_metrics.json"))
CHARTS = _arg("--charts", os.path.join(DATA, "cache_charts.json"))
INDEX_CODE = _arg("--code", "000001")
WARMUP_MIN = 60          # 前缀判定最少要 2 根；记 <60 根为「未预热」（与个股口径一致）
REFETCH = "--refetch" in sys.argv

EM_URL = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.%s"
          "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
          "&klt=101&fqt=0&beg=20140101&end=20500101&lmt=100000")
SINA_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            "CN_MarketData.getKLineData?symbol=sh%s&scale=240&ma=no&datalen=1800")
TX_URL = ("https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=sh%s,day,,,1800,qfq")


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


# ---------------- 取数 ----------------
class _IPv4:
    """强制 IPv4 解析（本机 resolver 会优先返回只有 AAAA 的地址 → RemoteDisconnected）。"""

    def __enter__(self):
        self.orig = socket.getaddrinfo
        socket.getaddrinfo = lambda h, p, f=0, t=0, pr=0, fl=0: self.orig(h, p, socket.AF_INET, t, pr, fl)
        return self

    def __exit__(self, *a):
        socket.getaddrinfo = self.orig


def _get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with _IPv4():
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "ignore")


def _p_em(txt):
    k = ((json.loads(txt).get("data") or {}).get("klines")) or []
    return [(ln.split(",")[0], float(ln.split(",")[2])) for ln in k if ln]


def _p_sina(txt):
    return [(r["day"], float(r["close"])) for r in json.loads(txt)]


def _p_tx(txt):
    sym = "sh" + INDEX_CODE
    d = (json.loads(txt).get("data") or {}).get(sym) or {}
    return [(r[0], float(r[2])) for r in (d.get("qfqday") or d.get("day") or []) if r and r[2]]


def fetch_index():
    for name, fn, url in (("eastmoney", _p_em, EM_URL % INDEX_CODE),
                          ("sina", _p_sina, SINA_URL % INDEX_CODE),
                          ("tencent", _p_tx, TX_URL % INDEX_CODE)):
        for attempt in range(1, 4):
            try:
                rows = fn(_get(url))
                if rows:
                    print(f"[index] {name} OK: {len(rows)} bars {rows[0][0]}..{rows[-1][0]}")
                    return name, rows
            except Exception as exc:  # noqa: BLE001
                print(f"[index] {name} try {attempt} failed: {exc}")
    raise SystemExit("指数日线不可用：缓存缺失且东财/新浪/腾讯三路全失败")


def load_index():
    if os.path.exists(CACHE) and not REFETCH:
        rows = []
        for ln in open(CACHE, encoding="utf-8").read().splitlines():
            ln = ln.strip()
            if not ln or ln.lower().startswith("date"):
                continue
            d, c = ln.split(",")[:2]
            rows.append((d.strip(), float(c)))
        if rows:
            rows.sort()
            print(f"[index] cache hit: {os.path.basename(CACHE)} ({len(rows)} bars "
                  f"{rows[0][0]}..{rows[-1][0]} md5={md5_of(CACHE)})")
            return "cache:" + os.path.basename(CACHE), rows
        print(f"[index] cache 文件为空/格式异常，改走网络: {CACHE}")
    src, rows = fetch_index()
    rows = sorted(rows)
    with open(CACHE, "w", encoding="utf-8") as f:
        f.write("date,close\n")
        for d, c in rows:
            f.write(f"{d},{c:.3f}\n")
    print(f"[index] cache written: {CACHE} ({len(rows)} bars, md5={md5_of(CACHE)})")
    return src, rows


# ---------------- 主流程 ----------------
def main():
    src, rows = load_index()
    # 同日去重（网络源偶有重复行）
    seen, ded = set(), []
    for d, c in rows:
        if d in seen:
            continue
        seen.add(d)
        ded.append((d, c))
    rows = ded

    dates = [d for d, _ in rows]
    closes = [c for _, c in rows]
    dif, dea, hist = macd(closes)

    series, states = [], {}
    for i, d in enumerate(dates):
        st = None
        if i + 1 >= WARMUP_MIN:
            st = "D" + classify_state(hist[: i + 1])[1]
            states[d] = st
        series.append([d, round(float(closes[i]), 3), round(float(dif[i]), 4),
                       round(float(dea[i]), 4), round(float(hist[i]), 4), st])

    # ---------- 自检：与生产策略的 D 标签比对 ----------
    tc = tc_bad = 0
    bad_samples = []
    if os.path.exists(CHARTS):
        ch = json.load(open(CHARTS, encoding="utf-8"))
        for c in ch["charts"]:
            for t in c.get("trades", []):
                want = t.get("D")
                got = states.get(t["date"])
                if not want or not got:
                    continue
                tc += 1
                if want != got:
                    tc_bad += 1
                    if len(bad_samples) < 12:
                        bad_samples.append(f'{c["code"]} {t["date"]} 生产{want} vs 重算{got}')

    last_state, last_close = series[-1][5], series[-1][1]
    meta = {
        "index_code": INDEX_CODE, "index_name": "上证综指",
        "source": src, "cache": os.path.basename(CACHE) if os.path.exists(CACHE) else None,
        "cache_md5": md5_of(CACHE) if os.path.exists(CACHE) else None,
        "bars": len(series), "first": series[0][0], "last": series[-1][0],
        "first_warm_date": series[WARMUP_MIN - 1][0] if len(series) >= WARMUP_MIN else None,
        "last_close": last_close, "last_state": last_state,
        "macd": f"{12},{26},{9}", "warmup_min": WARMUP_MIN,
        "state_days": {s: sum(1 for r in series if r[5] == s) for s in ("D1", "D2", "D3", "D4")},
        "check_trades": tc, "check_mismatch": tc_bad,
        "check_ratio": (round(1 - tc_bad / tc, 6) if tc else None),
    }
    json.dump({"meta": meta, "series": series}, open(OUT, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))

    print("写出:", OUT, os.path.getsize(OUT), "B")
    print(f"大盘: {meta['index_name']}{INDEX_CODE} {meta['first']}..{meta['last']} "
          f"({meta['bars']} 根, 源={src}) 最新 {last_close:.2f} {last_state}")
    print("D 态天数:", meta["state_days"])
    if tc:
        print(f"★大盘态自检（vs 生产策略 D 标签）：{tc - tc_bad}/{tc} 一致 "
              f"({1 - tc_bad / tc:.2%})")
        for b in bad_samples:
            print("   不一致:", b)
        if tc_bad / tc > 0.01:
            print("   ⚠️ 一致率 < 99% —— 指数/复权/MACD 口径需排查，先不要出报表")
    else:
        print("⚠️ 未找到可比的交易 D 标签（cache_charts.json 缺 trades），跳过自检")


if __name__ == "__main__":
    main()
