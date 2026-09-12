#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gate_eval.py v2 — 大盘腿闸门「是否有正贡献」的有界验证（指数级，只读）

问题（09-10 待决策）：
    大盘腿闸门一年只有 ~25.7% 交易日开着 → 74% 时间买点引擎结构性不可能出信号。
    这个闸门到底有没有正贡献？

★v2 关键修正：v1 只测了「深证单指数红柱」，开启率 47.7%，
  与 09-10 实测的 25.7% 不符 → 说明生产闸门可能是「两指数共振」。
  本版同时测两种定义，先与记忆对账，再判贡献。

方法：
    - baostock 取 深证成指399001 + 上证000001 日线
    - 闸门定义A：399001 日线 MACD hist>0
    - 闸门定义B：399001 与 000001 同时 hist>0（共振）
    - 前瞻收益 close[t+H]/close[t]-1，H=5/10/20
    - ★n_eff：连续开闸段只取首日（日样本自相关严重，逐日 n 是虚高）
    - 判据：开闸日前瞻收益须显著优于关闸日；否则闸门无择时价值
"""
import sys
import statistics as st
from datetime import date, timedelta

import baostock as bs

INDEX_A = ("sz.399001", "深证成指")
INDEX_B = ("sh.000001", "上证指数")
YEARS = 4
H_LIST = (5, 10, 20)
WARM = 35


def fetch_daily(code, start, end):
    rs = bs.query_history_k_data_plus(
        code, "date,close", start_date=start, end_date=end,
        frequency="d", adjustflag="3")
    out = {}
    while rs.error_code == "0" and rs.next():
        d, c = rs.get_row_data()
        try:
            out[d] = float(c)
        except ValueError:
            continue
    return out


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


def tstat(xs):
    if len(xs) < 2:
        return float("nan")
    m, sd = mean(xs), st.stdev(xs)
    return m / (sd / len(xs) ** 0.5) if sd else float("nan")


def runs_of(flags, lo, hi):
    """返回 [start_idx, end_idx] 的连续 True 段"""
    out, i = [], lo
    while i < hi:
        if flags[i]:
            j = i
            while j < hi and flags[j]:
                j += 1
            out.append((i, j - 1))
            i = j
        else:
            i += 1
    return out


def evaluate(name, dates, closes, flags, lo, hi):
    on = [t for t in range(lo, hi) if flags[t]]
    off = [t for t in range(lo, hi) if not flags[t]]
    tot = len(on) + len(off)
    runs = runs_of(flags, lo, hi)
    lens = [b - a + 1 for a, b in runs]
    print(f"\n{'='*66}\n【{name}】开启率 {len(on)/tot*100:.1f}% ({len(on)}/{tot})  "
          f"段数 {len(runs)}  均长 {mean(lens):.1f}日  最长 {max(lens) if lens else 0}日")
    print(f"  ★独立样本 n_eff = {len(runs)}（自相关修正后）")
    for h in H_LIST:
        def fv(ts):
            return [closes[t + h] / closes[t] - 1 for t in ts if t + h < len(closes)]
        a, b = fv(on), fv(off)
        c = fv([x for x, _ in runs])
        print(f"  ── H={h:2d} ──")
        print(f"    开闸 n={len(a):4d} mean={mean(a)*100:+6.2f}% med={med(a)*100:+6.2f}% "
              f"win={sum(1 for x in a if x>0)/len(a)*100:4.1f}%")
        print(f"    关闸 n={len(b):4d} mean={mean(b)*100:+6.2f}% med={med(b)*100:+6.2f}% "
              f"win={sum(1 for x in b if x>0)/len(b)*100:4.1f}%")
        print(f"    ★段首 n={len(c):4d} mean={mean(c)*100:+6.2f}% med={med(c)*100:+6.2f}% "
              f"win={sum(1 for x in c if x>0)/len(c)*100:4.1f}%  t={tstat(c):+.2f}")
        print(f"    → 开-关 差 {(mean(a)-mean(b))*100:+.2f}pp；段首-关 差 {(mean(c)-mean(b))*100:+.2f}pp")


def main():
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=365 * YEARS + 30)).isoformat()
    lg = bs.login()
    if lg.error_code != "0":
        print("login failed", lg.error_msg)
        sys.exit(1)
    da = fetch_daily(INDEX_A[0], start, end)
    db = fetch_daily(INDEX_B[0], start, end)
    bs.logout()

    # 以深证日期序列为基准，对齐上证
    dates = sorted(set(da) & set(db))
    ca = [da[d] for d in dates]
    cb = [db[d] for d in dates]
    ha, hb = macd_hist(ca), macd_hist(cb)
    lo, hi = WARM, len(dates) - 1

    print(f"样本 {dates[lo]} → {dates[-1]}  ({hi-lo} 交易日)  "
          f"指数对: {INDEX_A[1]} + {INDEX_B[1]}")

    evaluate("定义A：深证单指数红柱", dates, ca, [h > 0 for h in ha], lo, hi)
    evaluate("定义B：两指数共振（深证 AND 上证 红柱）", dates, ca,
             [ha[t] > 0 and hb[t] > 0 for t in range(len(dates))], lo, hi)

    print(f"\n判据：段首口径（n_eff 修正）若 mean/median 不显著为正、或 t 值弱，")
    print("      则闸门对指数无择时价值 → 应考虑降权/替换。")


if __name__ == "__main__":
    main()
