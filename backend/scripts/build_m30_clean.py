#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_m30_clean.py — 建「干净 30 分钟库」clean_m30.db（前复权，与 clean_daily 严格自洽）

为什么需要它（2026-09-12 取证）:
  - 现有 30m 存在于脏库 stock_history.db 的 stock_kline_30m：腾讯 mkline 原始价 = **未复权**
  - 而日线 clean_daily.db 是 **前复权**
  - 凡是用「日线红柱 + 30m 绿柱」这类跨级别判定的信号，都在做**跨口径拼接**，除权日附近必然错

复权方案（关键设计）:
  不依赖任何外部复权因子，直接用「同一日」的两库关系反推标量：
      factor(code, date) = clean_daily.qfq_close(code,date) / raw_30m_close(code,date)
      其中 raw_30m_close = 该日最后一根 30m bar 的 close（14:30-15:00）
  把该日全部 30m bar 的 OHLC 乘 factor。
  ⇒ **聚合到日线必然等于 clean_daily 的 qfq close（构造性保证）**，且日内形态（比值/背驰）不变。
  amount 保持原值。

成交量口径（2026-09-12 归一到「手」，否则跨级别量能比较差 100 倍）:
  - 源 stock_kline_30m.volume = **股**（baostock/腾讯原生）  → 写库前 ÷100
  - 源 stock_kline_60m.volume = **手**（backfill_m30.py 写源时就 ÷100 了）→ 不再除
  - 目标口径 = 手：与 clean_daily.volume 一致，也与 src/tools/stock.ts 的
    "volume(成交量手)" 工具契约一致
  自证（每次构建末尾自动跑）: 同日同票 sum(分钟 volume) 必须 ≈ daily.volume
  （见 SRC_VOL_DIV + verify_volume_invariant()）

数据源:
  30m 原始: /root/sclaw/backend/data/stock_history.db :: stock_kline_30m  (code,datetime,open,high,low,close,volume,amount)
  日线前复权: /root/sclaw/backend/data/clean_daily.db :: daily (code,date,close)

产出: /root/sclaw/backend/data/clean_m30.db
  - m30(code,datetime,open,high,low,close,volume,amount)  前复权
  - adj_audit(code,date,raw_close,qfq_close,factor,flag)    每 (code,date) 一行，供审计
  - meta(key,value)                                        构建信息（源库 mtime/md5、行数、跨度）
  - m30_residue(...)                                       无法复权的残渣（缺 qfq 日线），默认不写入 m30

用法:
  python3 build_m30_clean.py [--period 30|60] [--limit N] [--codes 600519,000001] [--dry]
  # --period 30 (默认) → data/clean_m30.db   表 m30
  # --period 60        → data/clean_m60.db   表 m60
"""
import argparse
import hashlib
import os
import sqlite3
import sys
import time

SRC = "/root/sclaw/backend/data/stock_history.db"
DAILY = "/root/sclaw/backend/data/clean_daily.db"
OUT = "/root/sclaw/backend/data/clean_m30.db"

# 周期 → (源表, 产物库, 产物表名)
PERIODS = {
    30: ("stock_kline_30m", "clean_m30.db", "m30"),
    60: ("stock_kline_60m", "clean_m60.db", "m60"),
}

# 周期 → 源 volume 单位换算到「手」的除数（2026-09-12 实测取证）
#   30m 源=股 → /100 ；60m 源=手（backfill_m30.py 写源时已 /100）→ /1
# 目标: 与 clean_daily.volume、与 src/tools/stock.ts "volume(成交量手)" 契约一致
SRC_VOL_DIV = {30: 100.0, 60: 1.0}

FACTOR_MIN, FACTOR_MAX = 0.02, 50.0     # 合理复权因子区间
JUMP_WARN = 0.50                        # 相邻交易日因子跳变告警阈值

DDL_TMPL = """
CREATE TABLE IF NOT EXISTS {T} (
  code TEXT NOT NULL, datetime TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL,
  volume REAL, amount REAL,
  PRIMARY KEY (code, datetime)
);
CREATE INDEX IF NOT EXISTS idx_{T}_dt ON {T}(datetime);
CREATE TABLE IF NOT EXISTS {T}_residue (
  code TEXT, datetime TEXT, open REAL, high REAL, low REAL, close REAL,
  volume REAL, amount REAL, reason TEXT,
  PRIMARY KEY (code, datetime)
);
CREATE TABLE IF NOT EXISTS adj_audit (
  code TEXT, date TEXT, raw_close REAL, qfq_close REAL, factor REAL, flag TEXT,
  PRIMARY KEY (code, date)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def file_sig(p):
    if not os.path.exists(p):
        return "missing"
    st = os.stat(p)
    h = hashlib.md5()
    with open(p, "rb") as f:                    # 只哈希头 4MB，够做版本指纹
        h.update(f.read(4 * 1024 * 1024))
    return "size=%d mtime=%s md5head=%s" % (st.st_size, int(st.st_mtime), h.hexdigest()[:12])


def verify_volume_invariant(out, T, date):
    """口径自证: 同日同票 sum(分钟 volume) 必须 ≈ clean_daily.volume（同为「手」）。

    这是「volume 单位登记正确」的强不变量：若源单位记错（例如 30m 忘了 /100），
    中位比值会是 ~100 而不是 ~1，立刻暴露。返回 (ok|None, 说明文本)。
    """
    try:
        out.execute("ATTACH DATABASE 'file:%s?mode=ro' AS cd" % DAILY)
        rs = out.execute(
            "select cd.daily.volume, s.v from "
            "(select code, sum(volume) v from %s where substr(datetime,1,10)=? group by code) s "
            "join cd.daily on cd.daily.code = s.code and cd.daily.date = ? "
            "where cd.daily.volume > 0 and s.v > 0" % T, (date, date)).fetchall()
    except Exception as e:
        return None, "自证异常: %s" % e
    if not rs:
        return None, "无可比样本"
    ratios = sorted(dv / mv for dv, mv in rs)
    med = ratios[len(ratios) // 2]
    return (0.98 <= med <= 1.02), "可比 %d 只  median(daily/minute)=%.4f (期望≈1.0)" % (len(ratios), med)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 只股票（试跑）")
    ap.add_argument("--codes", default="", help="指定股票，逗号分隔")
    ap.add_argument("--dry", action="store_true", help="只算不写（打印统计）")
    ap.add_argument("--chunk", type=int, default=400, help="每批股票数")
    ap.add_argument("--period", type=int, default=30, choices=[30, 60],
                    help="分钟周期：30=建 clean_m30.db（默认），60=建 clean_m60.db")
    args = ap.parse_args()

    src_table, out_name, T = PERIODS[args.period]
    out_path = os.path.join(os.path.dirname(OUT), out_name)
    print("[i] period=%d  源表=%s  产物=%s  表名=%s" % (args.period, src_table, out_path, T))

    t0 = time.time()
    if os.path.exists(out_path) and not args.dry:
        bak = out_path + ".bak%d" % int(t0)
        os.rename(out_path, bak)
        print("[i] 旧库已备份 -> %s" % bak)

    src = sqlite3.connect("file:%s?mode=ro" % SRC, uri=True)
    cds = sqlite3.connect("file:%s?mode=ro" % DAILY, uri=True)

    # 分钟线的日期下界 → 只载入覆盖得到的那段日线（避免全库 780 万行拖慢启动）
    dlo = src.execute("select min(substr(datetime,1,10)) from %s" % src_table).fetchone()[0]
    print("[i] 载入 clean_daily 前复权收盘价 (date >= %s) ..." % dlo)
    qfq = {}
    for code, date, close in cds.execute(
            "select code, date, close from daily where close is not null and date >= ?", (dlo,)):
        qfq[(code, date)] = close
    print("    %d 条 (code,date)" % len(qfq))

    codes = [r[0] for r in src.execute("select distinct code from %s order by code" % src_table)]
    if args.codes:
        want = set(args.codes.split(","))
        codes = [c for c in codes if c in want]
    if args.limit:
        codes = codes[: args.limit]
    print("[i] 待处理股票 %d 只" % len(codes))

    out = None
    if not args.dry:
        if os.path.exists(out_path):
            os.remove(out_path)
        out = sqlite3.connect(out_path)
        out.executescript(DDL_TMPL.format(T=T))

    n_rows = n_adj = n_residue = 0
    bad_range, big_jump, no_qfq = [], [], []
    prev_factor = {}
    bars_per_day = {}
    dmin, dmax = "9999", "0000"
    vol_div = SRC_VOL_DIV[args.period]       # 源 volume → 手（见文件头「成交量口径」）

    for ci in range(0, len(codes), args.chunk):
        batch = codes[ci: ci + args.chunk]
        ph = ",".join("?" * len(batch))
        rows = src.execute(
            "select code, datetime, open, high, low, close, volume, amount "
            "from %s where code in (%s) order by code, datetime" % (src_table, ph),
            batch).fetchall()
        if not rows:
            continue
        # 该批每 (code,date) 的最后一根 bar
        last_of_day = {}
        for r in rows:
            last_of_day[(r[0], r[1][:10])] = r[5]
        # 该批因子
        fac = {}
        for (code, date), raw_close in last_of_day.items():
            qc = qfq.get((code, date))
            if not qc or not raw_close or raw_close <= 0:
                no_qfq.append((code, date))
                continue
            f = qc / raw_close
            flag = ""
            if not (FACTOR_MIN <= f <= FACTOR_MAX):
                bad_range.append((code, date, f))
                f = prev_factor.get(code, 1.0)          # 兜底：沿用前一交易日因子
                flag = "out_of_range"
            pf = prev_factor.get(code)
            if pf and abs(f / pf - 1) > JUMP_WARN:
                big_jump.append((code, date, pf, f))
                flag = (flag + ";big_jump") if flag else "big_jump"
            prev_factor[code] = f
            fac[(code, date)] = (f, flag)
        # 写出
        out_rows, res_rows, aud_rows = [], [], []
        for code, dt, o, h, l, c, v, a in rows:
            date = dt[:10]
            got = fac.get((code, date))
            if got is None:
                res_rows.append((code, dt, o, h, l, c, v, a, "no_qfq_daily"))
                continue
            f, flag = got
            # volume 归一到「手」（30m 源=股 → /100；60m 源已是手）；residue 保持源样不换算
            out_rows.append((code, dt, o * f, h * f, l * f, c * f,
                             (v / vol_div) if v is not None else v, a))
            if flag:
                aud_rows.append((code, date, last_of_day[(code, date)], qfq.get((code, date)), f, flag))
            else:
                aud_rows.append((code, date, last_of_day[(code, date)], qfq.get((code, date)), f, ""))
            dmin, dmax = min(dmin, date), max(dmax, date)
            bars_per_day[date] = bars_per_day.get(date, 0) + 1
        if out:
            out.executemany("insert or replace into %s values (?,?,?,?,?,?,?,?)" % T, out_rows)
            out.executemany("insert or replace into %s_residue values (?,?,?,?,?,?,?,?,?)" % T, res_rows)
            out.executemany("insert or replace into adj_audit values (?,?,?,?,?,?)", aud_rows)
            out.commit()
        n_rows += len(out_rows)
        n_residue += len(res_rows)
        print("  [%d/%d] %s..%s  bars=%d  残渣=%d  %.0fs" % (
            min(ci + args.chunk, len(codes)), len(codes), batch[0], batch[-1],
            len(out_rows), len(res_rows), time.time() - t0))

    if out:
        meta = {
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "period": str(args.period),
            "src_raw": "%s :: %s :: %s" % (src_table, SRC, file_sig(SRC)),
            "src_daily": "%s :: %s" % (DAILY, file_sig(DAILY)),
            "rows": str(n_rows), "residue": str(n_residue),
            "date_range": "%s ~ %s" % (dmin, dmax),
            "adjust": "qfq via same-day factor = clean_daily.qfq_close / raw_minute_last_close",
            "factor_range": "%s..%s" % (FACTOR_MIN, FACTOR_MAX),
            "volume_unit": "手",
            "volume_src_div": str(vol_div),
        }
        out.executemany("insert or replace into meta values (?,?)", list(meta.items()))
        out.commit()
        ok_v, msg_v = verify_volume_invariant(out, T, dmax)
        print("[i] 成交量口径自证(%s): %s" % (dmax, msg_v))
        if ok_v is False:
            out.close()
            print("[x] 口径自证失败: 分钟 volume 与 daily 不同量纲 → 检查 SRC_VOL_DIV")
            sys.exit(3)
        out.execute("insert or replace into meta values ('volume_verify',?)",
                    ("date=%s; %s" % (dmax, msg_v),))
        out.commit()
        out.close()

    n_days = len(bars_per_day)
    avg_bars = (sum(bars_per_day.values()) / n_days) if n_days else 0
    print()
    print("=== 构建结果 ===")
    print("%s 行数(前复权) = %d   残渣(缺日线) = %d   (code,date) 覆盖 %d 天" % (T, n_rows, n_residue, n_days))
    print("日期跨度: %s ~ %s   平均每日 bar 数 = %.1f" % (dmin, dmax, avg_bars))
    print("因子越界 = %d   因子跳变(>%.0f%%) = %d   缺 qfq 日线 = %d" % (
        len(bad_range), JUMP_WARN * 100, len(big_jump), len(no_qfq)))
    for t, arr in (("越界", bad_range), ("跳变", big_jump)):
        for x in arr[:5]:
            print("   %s: %s" % (t, x))
    print("耗时 %.0fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
