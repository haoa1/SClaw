# -*- coding: utf-8 -*-
"""
impossible_days.py — 板块感知的「不可能日」检测（独立验收口径）

为什么需要板块感知（2026-09-12 修正）：
  固定 >11% 的阈值会把**合法**的 20% 涨跌幅（创业板/科创板）、30%（北交所）当成缺陷。
  必须先按代码前缀定「涨跌幅上限」，再判超额。

口径：
  |单日收益| > board_limit + TOL  → 计为不可能日
  排除每只股票的第一行（上市首日/数据起点无前收，本就不该有涨跌幅约束）

板块上限（宽口径，宁松勿严，避免假阳性）：
  688/689          科创板  20%
  300/301/302      创业板  20%
  8xx/4xx/920      北交所  30%
  其余（60x/00x/900 B股等） 主板    10%
  ST 股上限 5%（低于主板，不会造成假阳性，故不做识别）
"""
import sqlite3
import sys

TOL = 0.010          # 允许 1% 的取整/容差


def board_limit(code):
    c = code.strip()
    if c[:3] in ("688", "689"):
        return 0.20
    if c[:3] in ("300", "301", "302"):
        return 0.20
    if c[0] in ("4", "8") or c[:3] == "920":
        return 0.30
    return 0.10


def scan(path, label, limit_report=0):
    con = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    codes = [r[0] for r in con.execute("select distinct code from daily")]
    bad = []
    tot = 0
    for code in codes:
        lim = board_limit(code) + TOL
        prev = None
        first = True
        for d, cl in con.execute(
                "select date, close from daily where code=? and close is not null"
                " order by date", (code,)):
            if first:
                first = False
                prev = cl
                continue
            tot += 1
            if prev and prev > 0:
                r = cl / prev - 1.0
                if abs(r) > lim:
                    bad.append((code, d, prev, cl, r, lim))
            prev = cl
    print("=" * 74)
    print("[%s] %s" % (label, path))
    print("  codes=%d  相邻日对=%d  不可能日=%d  (%.4f%%)"
          % (len(codes), tot, len(bad), (100.0 * len(bad) / tot) if tot else 0))
    # 按股票聚合，看是否集中在少数壳股
    agg = {}
    for code, d, pv, cl, r, lim in bad:
        agg.setdefault(code, []).append((d, r))
    top = sorted(agg.items(), key=lambda kv: -len(kv[1]))[:limit_report or 8]
    for code, arr in top:
        worst = min(arr, key=lambda x: x[1])
        print("    %s  n=%-3d 最差 %s %+.1f%%" % (code, len(arr), worst[0], worst[1] * 100))
    return len(bad), tot, bad


if __name__ == "__main__":
    p1 = "/root/sclaw/backend/data/clean_daily.db"
    p2 = "/root/sclaw/backend/data/clean_daily_v2.db"
    n1, t1, _ = scan(p1, "PROD", 8)
    n2, t2, bad2 = scan(p2, "V2(构建中)", 8)
    print("=" * 74)
    print("对比: prod %d/%.4f%%  vs  v2 %d/%.4f%%"
          % (n1, 100.0 * n1 / t1, n2, 100.0 * n2 / t2))
    if n1 and n2:
        print("→ v2 校正倍数: %.1fx" % ((n1 / float(t1)) / (n2 / float(t2))))
    # 列出 v2 剩余缺陷的板块分布（判断是否只剩合理噪声）
    if bad2:
        from collections import Counter
        cb = Counter()
        for code, d, pv, cl, r, lim in bad2:
            cb["20%%板" % () if lim > 0.25 else ("30%%板" if lim > 0.15 else "10%%板")] += 1
        print("v2 剩余不可能日的板块分布:", dict(cb))
