#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bt_grid.py — 一次性加载, 内部跑网格, 判定「避开超涨毒性排除」是否稳健可落地

问题: bt_avoid_toxic 只测了单点(H=10, excl=0.40, min_amt=5e7)。
      落地前必须知道: 是否依赖单一参数? 哪个因子在起作用? 样本外是否还在?

网格: 因子集(ALL5 + 5个单因子) x H{5,10,20} x excl{0.30,0.40,0.50} x min_amt{5e7,1e8}
另附: 逐年 / 前后半段OOS / PnL集中度 / 随机基线 / 期间超额的自相关(检验 t 值是否被序列相关高估)
"""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, "/root/sclaw/backend/scripts")
import bt_avoid_toxic as bt

START, END = "2020-07-01", "2026-09-11"
MIN_LISTED = 60
ALL5 = bt.FACTORS


def stats(ex):
    ex = np.asarray(ex, float)
    ex = ex[np.isfinite(ex)]
    n = len(ex)
    if n < 5:
        return dict(n=n, mean=float("nan"), t=float("nan"), ac1=float("nan"))
    sd = ex.std(ddof=1)
    t = ex.mean() / (sd / np.sqrt(n)) if sd > 0 else float("nan")
    ac1 = float(np.corrcoef(ex[:-1], ex[1:])[0, 1]) if n > 5 else float("nan")
    return dict(n=n, mean=float(ex.mean()), t=float(t), ac1=ac1)


def main():
    m = bt.load(START, END)
    F = bt.build_factors(m)
    close = m["close"].values
    n, k = close.shape
    tradable = F["tradable"].values
    listed = F["listed_days"].values
    amt20 = F["amount_20"].values
    dates = m["close"].index

    rk = {}
    for nm in ALL5:
        rk[nm] = pd.DataFrame(F[nm].values).rank(axis=1, pct=True, na_option="keep").values

    def comp_of(fs):
        st = np.stack([rk[x] for x in fs])
        cnt = np.isfinite(st).sum(axis=0)
        tot = np.where(np.isfinite(st), st, 0.0).sum(axis=0)
        return np.where(cnt > 0, tot / np.maximum(cnt, 1), np.nan)

    def run(fs, h, excl, min_amt):
        comp = comp_of(fs)
        reb = list(range(20 + MIN_LISTED, n - h, h))
        rows, trades = [], []
        rng = np.random.default_rng(7)
        rand_ex = []
        for t in reb:
            elig = (tradable[t] & np.isfinite(amt20[t]) & (amt20[t] >= min_amt)
                    & (listed[t] >= MIN_LISTED) & np.isfinite(comp[t]))
            if elig.sum() < 20:
                continue
            idxs = np.where(elig)[0]
            c = comp[t][idxs]
            sel = idxs[c <= np.quantile(c, 1 - excl)]
            if len(sel) < 5:
                continue
            j = min(t + h, n - 1)
            r_all = close[j][idxs] / close[t][idxs] - 1.0
            msk = np.isfinite(r_all)
            if msk.sum() < 20:
                continue
            b = r_all[msk]
            rs = close[j][sel] / close[t][sel] - 1.0
            rs = rs[np.isfinite(rs)]
            if len(rs) < 5:
                continue
            rows.append({"date": dates[t], "strat": rs.mean(), "bench": b.mean()})
            trades.extend(rs.tolist())
            picks = rng.integers(0, len(b), size=(200, len(rs)))
            rand_ex.append(float((b[picks].mean(axis=1) - b.mean()).mean()))
        R = pd.DataFrame(rows)
        R["date"] = pd.to_datetime(R["date"])
        R["excess"] = R["strat"] - R["bench"]
        R["year"] = R["date"].dt.year
        return R, np.array(trades), rand_ex

    print("\n################ 网格 1: 因子集 (excl=0.40, H=10, min_amt=5e7) ################", flush=True)
    print("  %-16s %6s %10s %8s %8s %10s %9s %8s" % ("因子", "n_期", "超额/期", "t值", "ac1", "累计", "maxdd", "胜率"))
    grid1 = {}
    for fs, tag in [(ALL5, "ALL5(5因子)")] + [([x], x) for x in ALL5]:
        R, tr, rex = run(fs, 10, 0.40, 5e7)
        s = stats(R["excess"])
        eq = np.cumprod(1 + R["strat"].values); pk = np.maximum.accumulate(eq)
        cum = float(np.prod(1 + R["strat"]) - 1)
        grid1[tag] = (R, tr, rex, s, cum)
        print("  %-16s %6d %+10.5f %+8.2f %+8.3f %9.1f%% %8.1f%% %7.1f%%"
              % (tag, s["n"], s["mean"], s["t"], s["ac1"], cum * 100, (eq / pk - 1).min() * 100,
                 (tr > 0).mean() * 100), flush=True)

    print("\n################ 网格 2: H x 剔除比例 (ALL5, min_amt=5e7) ################", flush=True)
    print("  %4s %7s %6s %10s %8s %8s %10s %9s %8s" % ("H", "excl", "n_期", "超额/期", "t值", "ac1", "累计", "maxdd", "胜率"))
    for h in (5, 10, 20):
        for ex_ in (0.30, 0.40, 0.50):
            R, tr, rex = run(ALL5, h, ex_, 5e7)
            s = stats(R["excess"])
            eq = np.cumprod(1 + R["strat"].values); pk = np.maximum.accumulate(eq)
            print("  %4d %7.2f %6d %+10.5f %+8.2f %+8.3f %9.1f%% %8.1f%% %7.1f%%"
                  % (h, ex_, s["n"], s["mean"], s["t"], s["ac1"], (np.prod(1 + R["strat"]) - 1) * 100,
                     (eq / pk - 1).min() * 100, (tr > 0).mean() * 100), flush=True)

    print("\n################ 网格 3: 流动性门槛 (ALL5, H=10, excl=0.40) ################", flush=True)
    for ma in (1e7, 5e7, 1e8, 3e8):
        R, tr, rex = run(ALL5, 10, 0.40, ma)
        s = stats(R["excess"])
        eq = np.cumprod(1 + R["strat"].values); pk = np.maximum.accumulate(eq)
        print("  min_amt=%8.0f万  n_期=%3d 超额/期=%+.5f t=%+.2f 累计=%+.1f%% maxdd=%.1f%% 胜率=%.1f%% n选=%.0f"
              % (ma / 1e4, s["n"], s["mean"], s["t"], (np.prod(1 + R["strat"]) - 1) * 100,
                 (eq / pk - 1).min() * 100, (tr > 0).mean() * 100, len(tr) / max(s["n"], 1)), flush=True)

    print("\n################ 主口径深挖 (ALL5, H=10, excl=0.40, min_amt=5e7) ################", flush=True)
    R, tr, rex = grid1["ALL5(5因子)"]
    s = stats(R["excess"])
    print("  超额/期=%+.5f  t=%+.2f  期间自相关ac1=%+.3f  (|ac1|小 ⇒ t 值未被序列相关虚高)" % (s["mean"], s["t"], s["ac1"]))
    print("  逐笔胜率=%.1f%%  (基准逐笔胜率另算)  平均逐笔=%+.3f%%" % ((tr > 0).mean() * 100, tr.mean() * 100))
    pos = np.clip(R["excess"].values, 0, None); tot = pos.sum()
    srt = np.sort(pos)[::-1]; kk = max(1, int(len(srt) * 0.10))
    print("  超额PnL集中度: 前10%%期贡献=%.1f%%" % (srt[:kk].sum() / tot * 100))
    print("  随机基线: 同规模随机子集超额=%+.5f vs 策略=%+.5f" % (np.mean(rex), s["mean"]))
    print("  逐年:")
    for y, g in R.groupby("year"):
        sd = g["excess"].std(ddof=1)
        t = g["excess"].mean() / (sd / np.sqrt(len(g))) if len(g) > 2 and sd > 0 else float("nan")
        print("    %d n=%3d 超额=%+.4f t=%+.2f 策略=%+.1f%% 基准=%+.1f%%"
              % (y, len(g), g["excess"].mean(), t, (np.prod(1 + g["strat"]) - 1) * 100,
                 (np.prod(1 + g["bench"]) - 1) * 100), flush=True)
    print("  前后半段 OOS:")
    h1 = R.iloc[:len(R) // 2]; h2 = R.iloc[len(R) // 2:]
    for nm, g in (("前半", h1), ("后半", h2)):
        sd = g["excess"].std(ddof=1)
        t = g["excess"].mean() / (sd / np.sqrt(len(g))) if sd > 0 else float("nan")
        print("    %s n=%3d 超额=%+.5f t=%+.2f 策略累计=%+.1f%% 基准累计=%+.1f%%"
              % (nm, len(g), g["excess"].mean(), t, (np.prod(1 + g["strat"]) - 1) * 100,
                 (np.prod(1 + g["bench"]) - 1) * 100))
    R.to_csv("/tmp/bt_grid_R.csv", index=False)
    print("\n[out] /tmp/bt_grid_R.csv\n[grid] DONE")


if __name__ == "__main__":
    main()
