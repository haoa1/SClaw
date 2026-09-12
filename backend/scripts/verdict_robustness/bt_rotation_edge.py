#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rotation edge test — 止损后轮动的收益来源到底存不存在?

问题: 旧裁决(Step6)称 "survivor_eq: sl=0 +149.85% → sl=3 +633.06%"，
      即止损把收益放大4倍。但持有到期实现下(bt_avoid_toxic)止损是净损失。
      唯一还能解释旧结论的机制 = 「止损腾出资金 → 轮动到池子平均/新标的」。
      若被止损的票在"止损点之后到期末"跑输池子 ⇒ 轮动有正收益 ⇒ 止损可能有价值。
      若跑赢池子 ⇒ 止损砍在反弹前 ⇒ 轮动也救不了。

口径:
  r_name_post = close[t+h]/close[t+k] - 1   (被止标的, k=止损发生日, 从止损日起算到期末)
  r_pool_post = 横截面等权 mean of 同式        (池子同期; 两个池: elig 全池 / sel 剔除腿)
  edge = r_name_post - r_pool_post            (负=被止票之后跑输=轮动有益)
"""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, "/root/sclaw/backend/scripts")
import bt_avoid_toxic as bt   # reuse load/build_factors

H = 10
EXCL = 0.40
MIN_AMT = 5e7
MIN_LISTED = 60
START, END = "2020-07-01", "2026-09-11"
SLS = [1.0, 2.0, 3.0, 5.0, 8.0]


def tstat(x):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) < 3:
        return float("nan"), float("nan"), len(x)
    sd = x.std(ddof=1)
    return float(x.mean()), (float(x.mean() / (sd / np.sqrt(len(x)))) if sd > 0 else float("nan")), len(x)


def main():
    m = bt.load(START, END)
    F = bt.build_factors(m)
    close = m["close"].values
    low = m["low"].values
    n, k = close.shape
    tradable = F["tradable"].values
    amt20 = F["amount_20"].values
    listed = F["listed_days"].values

    ranks = [pd.DataFrame(F[nm].values).rank(axis=1, pct=True, na_option="keep").values
             for nm in bt.FACTORS]
    st = np.stack(ranks)
    cnt = np.isfinite(st).sum(axis=0)
    tot = np.where(np.isfinite(st), st, 0.0).sum(axis=0)
    comp = np.where(cnt > 0, tot / np.maximum(cnt, 1), np.nan)

    reb = list(range(20 + MIN_LISTED, n - H, H))
    print("[rot] rebalances=%d 区间=%s~%s" % (len(reb), START, END), flush=True)

    for mode in ["low", "close"]:
        for sl_pct in SLS:
            sl = sl_pct / 100.0
            e_pool, e_sel = [], []
            p_name, p_pool, p_sel = [], [], []
            n_stop_tot = 0
            for t in reb:
                elig = (tradable[t] & np.isfinite(amt20[t]) & (amt20[t] >= MIN_AMT)
                        & (listed[t] >= MIN_LISTED) & np.isfinite(comp[t]))
                if elig.sum() < 20:
                    continue
                idxs = np.where(elig)[0]
                c = comp[t][idxs]
                sel = idxs[c <= np.quantile(c, 1 - EXCL)]
                if len(sel) < 5:
                    continue
                ent = close[t][sel]
                sp = ent * (1.0 - sl)
                kk = np.full(len(sel), H, dtype=int)
                done = np.zeros(len(sel), dtype=bool)
                for step in range(1, H + 1):
                    j = t + step
                    if j >= n:
                        break
                    px = close[j][sel] if mode == "close" else low[j][sel]   # ★子集索引, 防广播错配
                    hit = (~done) & np.isfinite(ent) & np.isfinite(px) & (px <= sp)
                    kk[hit] = step
                    done |= hit
                ok = done & np.isfinite(ent)
                if ok.sum() == 0:
                    continue
                jH = min(t + H, n - 1)
                nam = np.full(len(sel), np.nan)
                pool = np.full(len(sel), np.nan)
                poolsel = np.full(len(sel), np.nan)
                for step in np.unique(kk[ok]):
                    step = int(step)
                    j = t + step
                    if j >= n:
                        continue
                    msk = ok & (kk == step)
                    if not msk.any():
                        continue
                    cj = close[j]
                    nam[msk] = close[jH][sel][msk] / cj[sel][msk] - 1.0
                    r = close[jH][idxs] / cj[idxs] - 1.0
                    r = r[np.isfinite(r)]
                    if len(r) >= 20:
                        pool[msk] = r.mean()
                    r2 = close[jH][sel] / cj[sel] - 1.0
                    r2 = r2[np.isfinite(r2)]
                    if len(r2) >= 5:
                        poolsel[msk] = r2.mean()
                fin = np.isfinite(nam) & np.isfinite(pool)
                if fin.sum() < 3:
                    continue
                n_stop_tot += int(fin.sum())
                p_name.append(float(nam[fin].mean()))
                p_pool.append(float(pool[fin].mean()))
                e_pool.append(float((nam[fin] - pool[fin]).mean()))
                fin2 = np.isfinite(nam) & np.isfinite(poolsel)
                if fin2.sum() >= 3:
                    p_sel.append(float(poolsel[fin2].mean()))
                    e_sel.append(float((nam[fin2] - poolsel[fin2]).mean()))
            a = tstat(e_pool)
            b = tstat(e_sel)
            print("\n===== 口径=%s  sl=%.0f%%   被止样本=%d =====" % (mode, sl_pct, n_stop_tot))
            print("  止损后到期末:  被止票=%+.4f   全池=%+.4f   剔除腿=%+.4f"
                  % (np.nanmean(p_name), np.nanmean(p_pool),
                     np.nanmean(p_sel) if p_sel else float("nan")))
            print("  轮动边缘(被止票-全池 ) 均值=%+.5f t=%+.2f  n_期=%d   [负=砍掉换池子有益]" % a)
            print("  轮动边缘(被止票-剔除腿) 均值=%+.5f t=%+.2f  n_期=%d" % b)
    print("\n[rot] DONE")


if __name__ == "__main__":
    main()
