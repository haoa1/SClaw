#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bt_avoid_toxic.py — 在干净日线(clean_daily.db)上验证
  「避开超涨毒性排除 + 止损 sl=3」是否真有 alpha

规格来源: memory/project/sclaw_winrate60_final_verdict.md (Step8 终局裁决)
  5 个负 IC 因子: momentum_20, ma_dev_20, turnover_20, amp_20, amt_ratio_20
  做法: 逐因子横截面百分位排名 -> 5 因子均值 -> 剔除最高的 40% -> 幸存者等权
  持有 H=10 交易日, 止损 sl=3% (期内 low 跌破 entry*(1-3%) 即在 -3% 处离场)

数据源(clean_daily.db, 腾讯 newfqkline / qfq):
  close = 前复权价; amount = 原始成交额(元); turn = 原始换手率(%); volume = 原始手(科创为股, 单位不一致)
  => 量能因子一律用 amount, 不用 volume

方法论四判据 (来自 sclaw_oversold_reversal_falsified.md):
  (1) 按日等权同口径对照基准   (2) PnL 集中度   (3) 按日 t 值 / n_eff   (4) 逐年分解
  另加: 随机基线 / H 扫描 / 样本外窗口

用法:
  python3 bt_avoid_toxic.py [--h 10] [--sl 3] [--exclude-top 0.40]
                            [--min-amount 5e7] [--start 2020-07-01] [--end 2026-09-11]
"""
import argparse
import sqlite3
import numpy as np
import pandas as pd

DB = "/root/sclaw/backend/data/clean_daily.db"
FACTORS = ["momentum_20", "ma_dev_20", "turnover_20", "amp_20", "amt_ratio_20"]


def load(start, end):
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    q = """select date, code, open, high, low, close, volume, amount, turn
           from daily where date>=? and date<=?"""
    df = pd.read_sql_query(q, c, params=(start, end))
    c.close()
    if df.empty:
        raise SystemExit("!! 空数据: 检查日期区间 %s~%s" % (start, end))
    print("[load] rows=%d codes=%d dates=%d" % (len(df), df.code.nunique(), df.date.nunique()), flush=True)
    m = {}
    for col in ["open", "high", "low", "close", "volume", "amount", "turn"]:
        m[col] = df.pivot(index="date", columns="code", values=col).astype("float64")
    close = m["close"]
    # 数据清洗: |日收益|>21% 视为数据错误(非真实交易), 置 NaN 剔除
    ret = close / close.shift(1) - 1.0
    bad = ret.abs() > 0.21
    nbad = int(bad.values.sum())
    if nbad:
        close = close.mask(bad)
        m["close"] = close
        print("[load] 清洗 |ret|>21%% 异常点 %d 个" % nbad, flush=True)
    m["preclose"] = close.shift(1)
    print("[load] matrix %s x %s" % close.shape, flush=True)
    return m


def build_factors(m):
    close, high, low, pre, turn, amt = (m["close"], m["high"], m["low"],
                                        m["preclose"], m["turn"], m["amount"])
    f = {}
    # 所有因子: 值越大 = 越"超涨/越毒" (负 IC)
    f["momentum_20"] = close / close.shift(20) - 1.0
    f["ma_dev_20"] = close / close.rolling(20).mean() - 1.0
    f["turnover_20"] = turn.rolling(20).mean()
    f["amp_20"] = ((high - low) / pre.replace(0, np.nan)).rolling(20).mean()
    f["amt_ratio_20"] = amt.rolling(5).mean() / amt.rolling(20).mean()   # 量能突增(用 amount, 避免 volume 除权阶跃)
    f["amount_20"] = amt.rolling(20).mean()
    f["listed_days"] = close.notna().cumsum()
    f["tradable"] = close.notna() & (close > 0) & (m["amount"].fillna(0) > 0)
    return f


def forward_with_stop(close, low, entry_idx, h, sl, mode="low"):
    """返回 (ret, exit_k)。等权入场价=close[t]; 持有 h 日。
    mode='low'  : 期内最低价跌破 entry*(1-sl) 即按 -sl% 精确成交离场(理想止损单, 对止损最有利)
    mode='close': 期内收盘价跌破 entry*(1-sl) 则按该日收盘价离场(更钝, 更接近人工盯盘)
    exit_k 用于判定是否触发止损(exk < h 即被止损)"""
    n, k = close.shape
    ent = close[entry_idx]
    res = np.full(k, np.nan)
    exk = np.full(k, h)
    done = np.zeros(k, dtype=bool)
    if sl <= 0:  # 不止损: 持有到期末
        fin = np.isfinite(ent)
        j = min(entry_idx + h, n - 1)
        res[fin] = close[j][fin] / ent[fin] - 1.0
        return res, exk
    stop_price = ent * (1.0 - sl)
    for step in range(1, h + 1):
        j = entry_idx + step
        if j >= n:
            break
        ok = (~done) & np.isfinite(ent) & np.isfinite(close[j])
        if mode == "close":
            hit = ok & (close[j] <= stop_price)
            res[hit] = close[j][hit] / ent[hit] - 1.0
        else:
            hit = ok & np.isfinite(low[j]) & (low[j] <= stop_price)
            res[hit] = -sl
        exk[hit] = step
        done |= hit
    fin = (~done) & np.isfinite(ent)
    j = min(entry_idx + h, n - 1)
    res[fin] = close[j][fin] / ent[fin] - 1.0
    exk[fin] = j - entry_idx
    return res, exk


def metrics(name, r, b, trades, ypr, span_years=None):
    r = np.asarray(r, float); b = np.asarray(b, float)
    ex = r - b
    eq = np.cumprod(1 + r); peak = np.maximum.accumulate(eq)
    tr = np.asarray(trades, float); tr = tr[np.isfinite(tr)]
    sd = np.std(ex, ddof=1)
    # 年化必须用真实跨度(调仓次数 x H / 252), 不能用 ypr(=252/H) 直接幂乘
    sy = span_years if span_years else (len(r) * (252.0 / ypr) / 252.0)
    cum = float(np.prod(1 + r) - 1)
    out = {"name": name, "n_reb": len(r),
           "cum_strat": cum,
           "cum_bench": float(np.prod(1 + b) - 1),
           "ann_strat": float((1 + cum) ** (1.0 / sy) - 1) if sy > 0 and cum > -1 else float("nan"),
           "maxdd": float((eq / peak - 1).min()),
           "mean_excess": float(ex.mean()),
           "t_excess": float(ex.mean() / (sd / np.sqrt(len(ex)))) if len(ex) > 2 and sd > 0 else float("nan"),
           "sharpe": float(r.mean() / np.std(r, ddof=1) * np.sqrt(ypr)) if np.std(r, ddof=1) > 0 else float("nan"),
           "n_trades": len(tr),
           "winrate": float((tr > 0).mean()) if len(tr) else float("nan"),
           "avg_trade": float(tr.mean()) if len(tr) else float("nan")}
    pos = np.clip(r, 0, None); tot = pos.sum()
    if tot > 0:
        srt = np.sort(pos)[::-1]; kk = max(1, int(len(srt) * 0.10))
        out["pnl_conc_top10"] = float(srt[:kk].sum() / tot)
    else:
        out["pnl_conc_top10"] = float("nan")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--h", type=int, default=10)
    ap.add_argument("--sl", type=float, default=3.0, help="止损百分比, 3 = -3%% (argparse 会做 %% 格式化, 故需转义)")
    ap.add_argument("--exclude-top", type=float, default=0.40)
    ap.add_argument("--min-amount", type=float, default=5e7, help="20日均成交额下限(元)")
    ap.add_argument("--start", default="2020-07-01")
    ap.add_argument("--end", default="2026-09-11")
    ap.add_argument("--min-listed", type=int, default=60)
    ap.add_argument("--sl-scan", default=None, help="逗号分隔止损扫描, 如 '0,1,2,3,5,8'; 给出则先打印扫描表")
    ap.add_argument("--sl-mode", default="low", choices=["low", "close"], help="止损触发口径")
    ap.add_argument("--out", default="/tmp/bt_avoid_toxic_out.csv")
    args = ap.parse_args()
    sl_list = [float(x) for x in args.sl_scan.split(",")] if args.sl_scan else [args.sl]
    print("[cfg] 参数=%s" % vars(args), flush=True)

    m = load(args.start, args.end)
    F = build_factors(m)
    close = m["close"].values; low = m["low"].values
    n, k = close.shape
    tradable = F["tradable"].values
    amt20 = F["amount_20"].values
    listed = F["listed_days"].values

    ranks = []
    for nm in FACTORS:
        ranks.append(pd.DataFrame(F[nm].values).rank(axis=1, pct=True, na_option="keep").values)
    # 手动求横截面均值, 避免 np.nanmean 对"全 NaN 行"触发 "Mean of empty slice" 告警
    stacked = np.stack(ranks)
    cnt = np.isfinite(stacked).sum(axis=0)
    tot = np.where(np.isfinite(stacked), stacked, 0.0).sum(axis=0)
    comp = np.where(cnt > 0, tot / np.maximum(cnt, 1), np.nan)   # 0..1, 越大越毒

    reb_idx = list(range(20 + args.min_listed, n - args.h, args.h))
    ypr = 252.0 / args.h

    def _simulate(sl, mode):
        """单次回测: 返回逐期 DataFrame + 逐笔 + 止损归因"""
        rows, trades_s, trades_b, rand_excess = [], [], [], []
        stop_frac, stop_wouldbe = [], []
        rng = np.random.default_rng(42)
        for t in reb_idx:
            elig = (tradable[t] & np.isfinite(amt20[t]) & (amt20[t] >= args.min_amount)
                    & (listed[t] >= args.min_listed) & np.isfinite(comp[t]))
            if elig.sum() < 20:
                continue
            idxs = np.where(elig)[0]
            c = comp[t][idxs]
            sel = idxs[c <= np.quantile(c, 1 - args.exclude_top)]
            if len(sel) < 5:
                continue
            r_sl, exk = forward_with_stop(close, low, t, args.h, sl, mode=mode)
            r_ns, _ = forward_with_stop(close, low, t, args.h, 0.0)
            b = r_ns[idxs]; b = b[np.isfinite(b)]
            ss = r_sl[sel]; ss = ss[np.isfinite(ss)]
            s_ns = r_ns[sel]; s_ns = s_ns[np.isfinite(s_ns)]
            if len(ss) < 5 or len(b) < 20 or len(s_ns) < 5:
                continue
            rows.append({"date": m["close"].index[t], "strat": ss.mean(), "strat_noSL": s_ns.mean(),
                         "bench": b.mean(), "bench_sl": r_sl[idxs][np.isfinite(r_sl[idxs])].mean(),
                         "n_pick": len(ss), "n_elig": len(b)})
            trades_s.extend(ss.tolist()); trades_b.extend(b.tolist())
            picks = rng.integers(0, len(b), size=(200, len(ss)))
            rand_excess.append(float((b[picks].mean(axis=1) - b.mean()).mean()))
            if sl > 0:
                raw_sl = r_sl[sel]; raw_ns = r_ns[sel]; raw_k = exk[sel]
                fin_ = np.isfinite(raw_sl) & np.isfinite(raw_ns)
                st = fin_ & (raw_k < args.h)
                if st.sum() > 0:
                    stop_frac.append(float(st[fin_].mean()))
                    stop_wouldbe.append(float(raw_ns[st].mean()))
        if not rows:
            return None
        R = pd.DataFrame(rows)
        R["date"] = pd.to_datetime(R["date"])
        R["excess"] = R["strat"] - R["bench"]
        R["excess_sl"] = R["strat"] - R["bench_sl"]
        R["year"] = R["date"].dt.year
        return {"R": R, "ts": trades_s, "tb": trades_b, "rand": rand_excess,
                "stop_frac": float(np.mean(stop_frac)) if stop_frac else float("nan"),
                "stop_wouldbe": float(np.mean(stop_wouldbe)) if stop_wouldbe else float("nan")}

    print("[bt] h=%d exclude_top=%.0f%% min_amt=%.0f万 rebalances=%d 区间=%s~%s 触发口径=%s sl扫描=%s"
          % (args.h, args.exclude_top * 100, args.min_amount / 1e4, len(reb_idx),
             args.start, args.end, args.sl_mode, sl_list), flush=True)

    res = {}
    for s in sl_list:
        res[s] = _simulate(s / 100.0, args.sl_mode)
        if res[s] is None:
            print("!! sl=%s 无有效调仓日" % s); return

    # ================= 止损参数扫描表 (决定性证据: 止损到底有没有正贡献) =================
    if len(sl_list) > 1:
        print("\n=========== 止损扫描 (口径=%s, H=%d, 剔除前%.0f%%) ==========="
              % (args.sl_mode, args.h, args.exclude_top * 100))
        print("  %5s %10s %11s %8s %9s %8s %8s %11s" %
              ("sl%", "累计", "超额/期", "t值", "最大回撤", "夏普", "止损率", "被止后终值"))
        for s in sl_list:
            if s == 0.0:
                continue
            r = res[s]; R0 = r["R"]
            d0 = metrics("s", R0["strat"], R0["bench"], r["ts"], ypr)
            print("  %5.0f %9.1f%% %+11.5f %+8.2f %8.1f%% %8.2f %7.1f%% %+10.2f%%"
                  % (s, d0["cum_strat"] * 100, d0["mean_excess"], d0["t_excess"], d0["maxdd"] * 100,
                     d0["sharpe"], r["stop_frac"] * 100, r["stop_wouldbe"] * 100))
        if 0.0 in res:
            rb = res[0.0]; db = metrics("b", rb["R"]["strat"], rb["R"]["bench"], rb["ts"], ypr)
            print("  参照 sl=0(只剔除不止损): 累计=%.1f%% 超额/期=%+.5f t=%+.2f 最大回撤=%.1f%% 夏普=%.2f"
                  % (db["cum_strat"] * 100, db["mean_excess"], db["t_excess"], db["maxdd"] * 100, db["sharpe"]))
        print("  注: 被止后终值 = 被止损标的若不止损、持到期末的平均收益; 越正 ⇒ 砍在反弹前(止损有害)")

    # ================= 主口径详细输出 =================
    sl = args.sl / 100.0
    # 注意: res 的键是 sl_list 的原始百分数(如 3.0), 而 sl 是小数(0.03) — 必须按原始值取,
    # 否则会静默 fallback 到 sl_list[0] 并把"不止损腿"标成"sl=3" (已踩过)
    _key = min(sl_list, key=lambda z: abs(z - args.sl))
    rr = res.get(_key) or res[sl_list[0]]
    print("[main] 详细输出口径 sl=%.0f%% (实测=%.1f%%)" % (args.sl, _key), flush=True)
    R = rr["R"]; trades_s = rr["ts"]; trades_b = rr["tb"]; rand_excess = rr["rand"]


    d = metrics("strat", R["strat"], R["bench"], trades_s, ypr)
    print("\n================ 主结果 (H=%d, sl=%.0f%%, 剔除前%.0f%%) ================" % (args.h, args.sl, args.exclude_top * 100))
    for kk in ["n_reb", "cum_strat", "cum_bench", "ann_strat", "maxdd", "sharpe", "mean_excess",
               "t_excess", "winrate", "n_trades", "avg_trade", "pnl_conc_top10"]:
        print("  %-14s %s" % (kk, round(d[kk], 4) if isinstance(d[kk], float) else d[kk]))

    print("\n--- 对照腿 (同池同持有期) ---")
    print("  基准 全池等权无止损     累计=%+.2f%%  逐笔胜率=%.2f%%" % (d["cum_bench"] * 100, metrics("b", R["bench"], R["bench"], trades_b, ypr)["winrate"] * 100))
    print("  全池等权+止损(不剔除)   累计=%+.2f%%  超额vs基准=%+.4f" % ((np.prod(1 + R["bench_sl"]) - 1) * 100, R["excess_sl"].mean()))
    print("  只剔除不止损           累计=%+.2f%%" % ((np.prod(1 + R["strat_noSL"]) - 1) * 100,))
    print("  => 剔除贡献 = %+.4f   止损贡献 = %+.4f" % (R["strat_noSL"].mean() - R["bench"].mean(), R["strat"].mean() - R["strat_noSL"].mean()))

    print("\n--- 逐年超额 (策略-基准, 同口径) ---")
    for y, g in R.groupby("year"):
        sd_ = g["excess"].std(ddof=1)
        t = g["excess"].mean() / (sd_ / np.sqrt(len(g))) if len(g) > 2 and sd_ > 0 else float("nan")
        print("  %d  n=%3d  超额=%+.4f  t=%+.2f  策略年内=%+.1f%%" % (y, len(g), g["excess"].mean(), t, (np.prod(1 + g["strat"]) - 1) * 100))

    print("\n--- 随机基线 (同规模随机子集 vs 全池, 200次/日) ---")
    print("  随机子集平均超额=%+.4f   策略超额=%+.4f   => 相对随机 %+.4f"
          % (np.mean(rand_excess), R["excess"].mean(), R["excess"].mean() - np.mean(rand_excess)))

    print("\n--- 分段(样本外) ---")
    for nm, s, e in [("2020H2-2022", "2020-07-01", "2022-12-31"), ("2023", "2023-01-01", "2023-12-31"),
                     ("2024", "2024-01-01", "2024-12-31"), ("2025-2026", "2025-01-01", "2026-12-31")]:
        g = R[(R.date >= s) & (R.date <= e)]
        if len(g) < 5:
            print("  %-12s 样本不足(%d)" % (nm, len(g))); continue
        sd_ = g["excess"].std(ddof=1)
        t = g["excess"].mean() / (sd_ / np.sqrt(len(g))) if sd_ > 0 else np.nan
        eq = np.cumprod(1 + g["strat"].values); pk = np.maximum.accumulate(eq)
        print("  %-12s n=%3d 超额=%+.4f t=%+.2f 策略累计=%+.1f%% 基准累计=%+.1f%% maxdd=%.1f%%"
              % (nm, len(g), g["excess"].mean(), t, (eq[-1] - 1) * 100, (np.prod(1 + g["bench"].values) - 1) * 100, (eq / pk - 1).min() * 100))

    neff = len(R) * args.h / 252.0
    print("\n--- 样本结构: 调仓%d次 x 持有%d日 = 跨度≈%.1f年; 因调仓间隔=H, 各期**互不重叠**, 故独立观测 n=%d (t 值有效) ---"
          % (len(R), args.h, neff, len(R)))
    R.to_csv(args.out, index=False)
    print("[out] %s" % args.out)


if __name__ == "__main__":
    main()
