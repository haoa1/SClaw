#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对 bt_avoid_toxic.py 输出做补充显著性检验（两腿 t 值 + SL 逐 sl 扫描）"""
import numpy as np
import pandas as pd

R = pd.read_csv("/tmp/bt_avoid_toxic_out.csv", parse_dates=["date"])
R["ex_ns"] = R["strat_noSL"] - R["bench"]     # 只剔除腿 超额
R["ex_sl"] = R["strat"] - R["bench"]          # 剔除+止损腿 超额
R["sl_cost"] = R["strat"] - R["strat_noSL"]   # 止损抵消


def tstat(x):
    x = np.asarray(x, float)
    sd = x.std(ddof=1)
    return x.mean(), (x.mean() / (sd / np.sqrt(len(x))) if sd > 0 else np.nan), len(x)


print("=== 三条腿的按日超额 + t 值 (n=%d 调仓) ===" % len(R))
for nm, col in [("只剔除不止损  ", "ex_ns"), ("剔除+止损sl3 ", "ex_sl"), ("止损抵消项    ", "sl_cost")]:
    m, t, n = tstat(R[col])
    print("  %s 均值=%+.5f  t=%+.2f  n=%d" % (nm, m, t, n))

print("\n=== 止损抵消项(sl_cost) 分年 ===")
R["year"] = R["date"].dt.year
for y, g in R.groupby("year"):
    m, t, n = tstat(g["sl_cost"])
    print("  %d n=%3d  sl_cost=%+.5f  t=%+.2f" % (y, n, m, t))

print("\n=== 止损被触发频率 & 触发后的机会成本 ===")
# sl_cost 均值 x 期数 -> 累计拖累(算术)
print("  止损抵消 总算术拖累 = %+.2f%% (142期 x 均值)" % (R["sl_cost"].mean() * len(R) * 100))
print("  只剔除 累计=%+.2f%%   剔除+止损 累计=%+.2f%%" %
      ((np.prod(1 + R["strat_noSL"]) - 1) * 100, (np.prod(1 + R["strat"]) - 1) * 100))

print("\n=== 剔除腿的年度稳定性 ===")
for y, g in R.groupby("year"):
    m, t, n = tstat(g["ex_ns"])
    print("  %d n=%3d  超额=%+.5f  t=%+.2f" % (y, n, m, t))

print("\n=== 剔除腿 分段 ===")
for nm, s, e in [("2020H2-2022", "2020-07-01", "2022-12-31"), ("2023", "2023-01-01", "2023-12-31"),
                 ("2024", "2024-01-01", "2024-12-31"), ("2025-2026", "2025-01-01", "2026-12-31")]:
    g = R[(R.date >= s) & (R.date <= e)]
    if len(g) < 5:
        continue
    m, t, n = tstat(g["ex_ns"])
    cum = (np.prod(1 + g["strat_noSL"]) - 1) * 100
    cumb = (np.prod(1 + g["bench"]) - 1) * 100
    print("  %-12s n=%3d 超额=%+.5f t=%+.2f  只剔除累计=%+.1f%% 基准=%+.1f%%" % (nm, n, m, t, cum, cumb))

print("\n=== PnL 集中度 (只剔除腿) ===")
pos = np.clip(R["strat_noSL"].values - R["bench"].values, 0, None)
print("  最赚10%%调仓日 贡献 = %.1f%%" % (np.sort(pos)[::-1][:14].sum() / pos.sum() * 100))
