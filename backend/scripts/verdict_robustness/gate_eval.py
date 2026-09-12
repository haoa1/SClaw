#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gate_eval.py — 大盘腿闸门「是否有正贡献」的有界验证（指数级，只读）

问题（09-10 待决策）：
    大盘腿闸门（日线 MACD 红柱）一年只有 ~25.7% 交易日是开着的，
    即 74% 时间买点引擎结构性不可能出信号。这个闸门到底有没有正贡献？

方法（只做指数级第一性检查，不做个股 alpha 声称）：
    - 取 深证成指 399001 日线（baostock）
    - 闸门 = MACD hist > 0（红柱），与 buy_signal/scout 的日线共振同源定义
    - 对每个交易日 t，看未来 H 日指数收益 close[t+H]/close[t]-1
    - 比较 开闸日 vs 关闸日 的前瞻收益分布
    - ★n_eff 修正：闸门红柱区间天然聚成连续段，逐日样本高度自相关，
      故同时给出「每段只取第一日」的独立样本口径（方法论要求，防自欺）

输出：开/关闸的 n、前瞻收益 均值/中位、胜率、独立段口径。
判据：若开闸日前瞻收益不显著优于关闸日 → 闸门无择时价值 → 应降权/替换。
"""
import sys
import statistics as st
from datetime import date, timedelta

try:
    import baostock as bs
except ImportError:
    print("ERROR: baostock not installed")
    sys.exit(1)

INDEX = "sz.399001"      # 深证成指（与 buy_signal.INDEX_CODE=399001 一致）
YEARS = 4
H_LIST = (5, 10, 20)


def fetch_daily(code, start, end):
    lg = bs.login()
    if lg.error_code != "0":
        print("login failed", lg.error_msg)
        sys.exit(1)
    rs = bs.query_history_k_data_plus(
        code, "date,close", start_date=start, end_date=end,
        frequency="d", adjustflag="3")
    rows = []
    while rs.error_code == "0" and rs.next():
        d, c = rs.get_row_data()
        try:
            rows.append((d, float(c)))
        except ValueError:
            continue
    bs.logout()
    return rows


def ema(vals, n):
    k = 2.0 / (n + 1)
    out, prev = [], None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def macd_hist(closes, fast=12, slow=26, sig=9):
    ef, es = ema(closes, fast), ema(closes, slow)
    dif = [a - b for a, b in zip(ef, es)]
    dea = ema(dif, sig)
    return [(a - b) * 2 for a, b in zip(dif, dea)]


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def med(xs):
    return st.median(xs) if xs else float("nan")


def fwd(closes, t, h):
    return closes[t + h] / closes[t] - 1 if t + h < len(closes) else None


def summarize(name, idxs, closes, h):
    v = [r for t in idxs if (r := fwd(closes, t, h)) is not None]
    if not v:
        return f"{name}: n=0"
    win = sum(1 for x in v if x > 0) / len(v) * 100
    return (f"{name}: n={len(v):5d}  mean={mean(v)*100:+7.2f}%  "
            f"med={med(v)*100:+7.2f}%  win={win:5.1f}%")


def main():
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=365 * YEARS + 30)).isoformat()
    rows = fetch_daily(INDEX, start, end)
    if len(rows) < 300:
        print(f"数据不足: {len(rows)} 行")
        sys.exit(1)
    dates = [r[0] for r in rows]
    closes = [r[1] for r in rows]
    hist = macd_hist(closes)

    # 闸门状态（hist>0 = 红柱开闸）；前 slow+sig 根 MACD 未成熟，跳过
    warm = 35
    on = [t for t in range(warm, len(closes) - 1) if hist[t] > 0]
    off = [t for t in range(warm, len(closes) - 1) if hist[t] <= 0]
    tot = len(on) + len(off)

    print(f"标的 {INDEX}  样本 {dates[warm]} → {dates[-1]}  ({tot} 交易日)\n")
    print(f"闸门开启率: {len(on)/tot*100:.1f}%  ({len(on)}/{tot})  "
          f"—— 对照 09-10 实测 25.7%\n")

    # 独立段口径：连续开闸段只取第一日（消除自相关导致的高估 n）
    seg_starts, prev = [], None
    for t in range(warm, len(closes) - 1):
        cur = hist[t] > 0
        if cur and (prev is False):
            seg_starts.append(t)
        prev = cur
    runs = []
    i = warm
    while i < len(closes) - 1:
        if hist[i] > 0:
            j = i
            while j < len(closes) - 1 and hist[j] > 0:
                j += 1
            runs.append((i, j - 1))
            i = j
        else:
            i += 1
    run_lens = [b - a + 1 for a, b in runs]
    print(f"开闸区间段数: {len(runs)}  平均时长 {mean(run_lens):.1f} 日  "
          f"最长 {max(run_lens) if run_lens else 0} 日")
    print(f"★独立样本 n_eff = {len(runs)}（每段第一日）\n")

    for h in H_LIST:
        print(f"── 前瞻 {h} 交易日 ──")
        print("  " + summarize("开闸", on, closes, h))
        print("  " + summarize("关闸", off, closes, h))
        print("  " + summarize("★独立段首日", [a for a, _ in runs], closes, h))
        diff = mean([fwd(closes, t, h) for t in on if fwd(closes, t, h) is not None]) \
            - mean([fwd(closes, t, h) for t in off if fwd(closes, t, h) is not None])
        print(f"  → 开-关 差 {diff*100:+.2f}pp\n")

    print("注：本测试只回答「闸门是否对指数本身有择时价值」，")
    print("    不等价于个股 alpha（个股已有独立结论：无 alpha）。")


if __name__ == "__main__":
    main()
