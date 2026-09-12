#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bt_alpha_deep.py — 只测 alpha 腿(只剔除不止损)的深挖, 重点是 H=5 vs H=10
回答: t=+2.22 是否稳健? H=5 的 t=+3.71 经过 ac1 折扣后还剩多少?

复用 in-tree v2 原生模块 bt_avoid_toxic (同源 clean_daily.db)。
"""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, "/root/sclaw/backend/scripts")
import bt_avoid_toxic as bt

START, END = "2020-07-01", "2026-09-11"
MIN_LISTED = 60
ALL5 = bt.FACTORS


def ac1_adjust_t(t, ac1):
    """AR(1) 方差膨胀校正: t_honest = t * sqrt((1-ac1)/(1+ac1))"""
    if not np.isfinite(ac1) or ac1 >= 1.0 or ac1 <= -1.0:
        return float("nan")
    return t * np.sqrt((1.0 - ac1) / (1.0 + ac1))


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

    st = np.stack([rk[x] for x in ALL5])
    cnt = np.isfinite(st).sum(axis=0)
    tot = np.where(np.isfinite(st), st, 0.0).sum(axis=0)
    comp = np.where(cnt > 0, tot / np.maximum(cnt, 1), np.nan)

    def run(h, excl, min_amt):
        """只剔除不止损: 等权持有到 t+h, 无止损"""
        reb = list(range(20 + MIN_LISTED, n - h, h))
        rows, trades, rand_ex = [], [], []
        rng = np.random.default_rng(7)
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
            rows.append({"date": dates[t], "strat": rs.mean(), "bench": b.mean(),
                         "n_pick": len(rs), "n_elig": len(b)})
            trades.extend(rs.tolist())
            picks = rng.integers(0, len(b), size=(200, len(rs)))
            rand_ex.append(float((b[picks].mean(axis=1) - b.mean()).mean()))
        R = pd.DataFrame(rows)
        R["date"] = pd.to_datetime(R["date"])
        R["excess"] = R["strat"] - R["bench"]
        R["year"] = R["date"].dt.year
        return R, np.array(trades), np.array(rand_ex)

    def report(h, excl, min_amt):
        R, tr, rex = run(h, excl, min_amt)
        ex = R["excess"].values
        nn = len(ex)
        sd = ex.std(ddof=1)
        t = ex.mean() / (sd / np.sqrt(nn)) if sd > 0 else float("nan")
        ac = float(np.corrcoef(ex[:-1], ex[1:])[0, 1]) if nn > 5 else float("nan")
        th = ac1_adjust_t(t, ac)
        eq = np.cumprod(1 + R["strat"].values)
        pk = np.maximum.accumulate(eq)
        cum_s = float(np.prod(1 + R["strat"]) - 1)
        cum_b = float(np.prod(1 + R["bench"]) - 1)
        pos = np.clip(ex, 0, None)
        tot_ = pos.sum()
        srt = np.sort(pos)[::-1]
        kk = max(1, int(len(srt) * 0.10))
        conc = srt[:kk].sum() / tot_ if tot_ > 0 else float("nan")
        print("=" * 84)
        print(f"### H={h}  excl={excl:.2f}  min_amt={min_amt:.0f}   (只剔除·不止损)")
        print("=" * 84)
        print(f"  n_期={nn}   超额/期={ex.mean():+.5f}   t={t:+.2f}   ac1={ac:+.3f}   "
              f"t(ac1校正)={th:+.2f}")
        print(f"  策略累计={cum_s*100:+.1f}%   基准累计={cum_b*100:+.1f}%   "
              f"maxdd={(eq/pk-1).min()*100:.1f}%")
        print(f"  逐笔胜率={(tr>0).mean()*100:.1f}%   平均逐笔={tr.mean()*100:+.3f}%   "
              f"n_trades={len(tr)}")
        print(f"  超额PnL集中度(前10%期)={conc*100:.1f}%   "
              f"随机子集超额={rex.mean():+.5f}  相对随机={ex.mean()-rex.mean():+.5f}")
        print("  --- 逐年 ---")
        for y, g in R.groupby("year"):
            sd_ = g["excess"].std(ddof=1)
            ty = g["excess"].mean() / (sd_ / np.sqrt(len(g))) if len(g) > 2 and sd_ > 0 else float("nan")
            print(f"    {y} n={len(g):3d} 超额={g['excess'].mean():+.4f} t={ty:+.2f} "
                  f"策略={(np.prod(1+g['strat'])-1)*100:+.1f}% 基准={(np.prod(1+g['bench'])-1)*100:+.1f}%")
        print("  --- 前后半段 OOS ---")
        for nm, g in (("前半", R.iloc[:nn // 2]), ("后半", R.iloc[nn // 2:])):
            sd_ = g["excess"].std(ddof=1)
            ty = g["excess"].mean() / (sd_ / np.sqrt(len(g))) if sd_ > 0 else float("nan")
            print(f"    {nm} n={len(g):3d} 超额={g['excess'].mean():+.5f} t={ty:+.2f} "
                  f"策略={(np.prod(1+g['strat'])-1)*100:+.1f}% 基准={(np.prod(1+g['bench'])-1)*100:+.1f}%")
        print(f"  --- 按年正负: {(R.groupby('year')['excess'].mean() > 0).sum()}/"
              f"{R['year'].nunique()} 年为正 ---")
        print()
        return R

    report(5, 0.30, 5e7)
    report(5, 0.40, 5e7)
    report(10, 0.40, 5e7)
    report(5, 0.30, 1e7)

    print("[out] deep dive done (no csv written)")


if __name__ == "__main__":
    main()
