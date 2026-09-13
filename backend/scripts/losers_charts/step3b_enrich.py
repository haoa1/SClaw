#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Step 3b：为报表补两维信息 —— ① MACD(12,26,9) ② 筹码分布(获利盘/均成本/集中度/套牢盘)

为什么要有这一步
--------------
Jack 2026-09-13 反馈：「macd 也不上」「买卖点太密集」「买卖点没考虑筹码」。
- MACD：策略的个股侧 S1..S4 就是 MACD 柱方向，图上看不到柱＝看不到信号依据。
- 筹码：`clean_daily.db` 的 `turn`(换手率) 可用 ⇒ 可算标准「筹码衰减分布」，
        给每个买/卖点配上「当时获利盘多少 / 均成本在哪 / 上方套牢盘多重」。

来源
----
- 价格/换手：/root/sclaw/backend/data/clean_daily.db  (v2 干净前复权基座)
- 图窗/交易日：research_archive/losers_charts_20260913/cache_charts.json

输出
----
enrich_metrics.json : { code: { "YYYY-MM-DD": {dif,dea,hist,win,cost,conc,over,turn} } }
只输出各图 K 线所在日（~281 日/票），体积小；MACD 用全历史预热后再切片。
"""
import json, os, sqlite3, sys
import numpy as np

DIR = os.path.dirname(os.path.abspath(__file__))


def _arg(flag, default):
    a = sys.argv
    return a[a.index(flag) + 1] if flag in a else default


DATA = _arg("--data", "/root/research_archive/losers_charts_20260913")
DB = _arg("--db", "/root/sclaw/backend/data/clean_daily.db")
OUT = _arg("--out", os.path.join(DATA, "enrich_metrics.json"))
CACHE = _arg("--cache", os.path.join(DATA, "cache_charts.json"))
CHIP_LOOKBACK_DAYS = int(_arg("--chip-lookback", "500"))   # 筹码衰减回看天数
FAST, SLOW, SIG = 12, 26, 9


# ---------------- MACD ----------------
def ema(x, n):
    a = 2.0 / (n + 1)
    out = np.empty_like(x, dtype=float)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def macd(closes):
    dif = ema(closes, FAST) - ema(closes, SLOW)
    dea = ema(dif, SIG)
    return dif, dea, (dif - dea) * 2.0   # A股口径：红绿柱 = 2*(DIF-DEA)


def classify_state(hist, tol=1e-9):
    """与 self-evolving-stock/regime_matrix.classify_state 同规格。"""
    last, prev = float(hist[-1]), float(hist[-2])
    if last > tol:
        return "S1" if last > prev + tol else "S2"
    if prev <= 0 and abs(last) < abs(prev) - tol:
        return "S3"
    return "S4"


# ---------------- 筹码分布 ----------------
def chips(rows):
    """rows: [(date,o,h,l,c,turn)] 升序 → 每日筹码统计。
    标准衰减模型：第 j 日的筹码 w_j = tr_j * Π_{j<k<=t}(1-tr_k)
    """
    n = len(rows)
    cost = np.array([(r[1] + r[2] + r[3] + r[4]) / 4.0 for r in rows])   # 当日均价（前复权）
    close = np.array([r[4] for r in rows])
    tr = np.array([min(max(float(r[5] or 0.0) / 100.0, 0.0), 0.9) for r in rows])
    w = np.zeros(n)
    out = {}
    for i in range(n):
        w[:i] *= (1.0 - tr[i])
        w[i] = tr[i]
        s = w[:i + 1].sum()
        if s <= 0:
            out[rows[i][0]] = None
            continue
        cs, ws = cost[:i + 1], w[:i + 1]
        win = float(ws[cs <= close[i]].sum() / s)
        order = np.argsort(cs)
        cw = np.cumsum(ws[order])
        cw /= cw[-1]
        p10 = float(cs[order][min(np.searchsorted(cw, 0.05), i)])
        p90 = float(cs[order][min(np.searchsorted(cw, 0.95), i)])
        out[rows[i][0]] = {
            "win": round(win, 4),
            "cost": round(float(cs.dot(ws) / s), 4),
            "conc": round((p90 - p10) / (p90 + p10), 4) if (p90 + p10) > 0 else None,
            "over": round(1.0 - win, 4),
            "turn": round(float(rows[i][5] or 0.0), 3),
        }
    return out


def main():
    cache = json.load(open(CACHE, encoding="utf-8"))
    uniq = {}
    for c in cache["charts"]:
        uniq.setdefault(c["code"], []).append(c)
    con = sqlite3.connect(DB)
    res, report = {}, []
    for code, cs in sorted(uniq.items()):
        want = sorted({b[0] for c in cs for b in c["bars"]})
        lo, hi = want[0], want[-1]
        rows = con.execute(
            "select date, open, high, low, close, turn from daily "
            "where code=? and date<=? order by date", (code, hi)).fetchall()
        if not rows:
            report.append((code, "无数据", 0, 0))
            continue
        rows = [r for r in rows if r[0] >= _shift_back(con, lo, CHIP_LOOKBACK_DAYS)]
        closes = np.array([r[4] for r in rows], dtype=float)
        dif, dea, hist = macd(closes)
        cm = chips(rows)
        d = {}
        for i, r in enumerate(rows):
            if r[0] not in want and r[0] not in cm:
                continue
            if r[0] < lo:
                continue          # 只保留图窗内的（MACD 已用全历史预热）
            c = cm.get(r[0]) or {}
            d[r[0]] = {
                "dif": round(float(dif[i]), 4), "dea": round(float(dea[i]), 4),
                "hist": round(float(hist[i]), 4), "win": c.get("win"),
                "cost": c.get("cost"), "conc": c.get("conc"),
                "over": c.get("over"), "turn": c.get("turn"),
            }
        res[code] = d
        # 自检：用重算的 MACD 判 S 态，与策略标签比对
        bad = tot = 0
        for c in cs:
            hist_by_date = {k: v["hist"] for k, v in d.items()}
            for t in c["trades"]:
                i = None
                ds = [k for k in d if k <= t["date"]]
                if len(ds) < 2:
                    continue
                seq = [d[k]["hist"] for k in ds[-61:]]
                if len(seq) < 3:
                    continue
                st = classify_state(np.array(seq))
                tot += 1
                bad += (st != t["S"])
        report.append((code, "OK", len(d), f"S态一致 {tot-bad}/{tot}" if tot else "-"))
    json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("写出:", OUT, os.path.getsize(OUT), "B")
    print(f"\n{'code':<9}{'状态':<6}{'日数':>6}  自检")
    tb = tt = 0
    for r in report:
        print(f"{r[0]:<9}{r[1]:<6}{r[2]:>6}  {r[3]}")
        if "一致" in str(r[3]):
            a, b = str(r[3]).split()[1].split("/")
            tb += int(b) - int(a); tt += int(b)
    if tt:
        print(f"\n★S 态自检汇总：{tt-tb}/{tt} 一致（不一致 {tb}，{tb/tt:.1%}）")


def _shift_back(con, date, days):
    r = con.execute("select date from daily where date<=date(?, ?) order by date desc limit 1",
                    (date, f"-{days} day")).fetchone()
    return r[0] if r else "1900-01-01"


if __name__ == "__main__":
    main()
