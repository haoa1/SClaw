#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_minute_clean.py — clean_m30 / clean_m60 建库自证（Step2 验收 + Step6 量纲）

A. 行数守恒:   源表行数 - 产出行数 == residue 行数（残渣=该 code/date 缺 clean_daily 行）
B. 复权因子自证: 独立重算 factor = clean_daily.close / 源库当日最后一根 bar.close，
                 与产物 adj_audit.factor 逐条比对（必须 0 偏差）
C. 复权后聚合自洽: 产物当日最后一根 close == clean_daily.close（构造性保证）
D. 量额口径:   amount 不变；volume 按「源 → 手」的除数归一后必须与源一致
               （30m 源=股 → 产物 = 源/100；60m 源=手 → 产物 = 源）
E. 日内形态不变: OHLC 比值 (h/l, c/o) 复权前后一致
G. 量纲不变量: 同日同票 sum(分钟 volume) ≈ clean_daily.volume（同为「手」）
               —— 独立于构建脚本自证的第二次校验（防双端同时写错）

用法: python3 verify_minute_clean.py [--sample N] [--quick]
退出码: 0=全过, 1=有失败（供例行脚本判定）
"""
import argparse
import sqlite3

DATA = "/root/sclaw/backend/data"
SRC = sqlite3.connect("file:%s/stock_history.db?mode=ro" % DATA, uri=True)
CDS = sqlite3.connect("file:%s/clean_daily.db?mode=ro" % DATA, uri=True)
FAIL = []
CHECKED = 0

# period -> (源表, 产物库, 产物表, 源 volume → 手 的除数)
#   30m 源=股 → /100 ; 60m 源=手 → /1   (与 build_m30_clean.py 的 SRC_VOL_DIV 一致)
PERIODS = [
    (30, "stock_kline_30m", "clean_m30.db", "m30", 100.0),
    (60, "stock_kline_60m", "clean_m60.db", "m60", 1.0),
]


def check_period(period, srctab, dbfile, T, vol_div, sample):
    print("=" * 72)
    print("### period=%d  源表=%s  产物=%s::%s  源volume÷%g→手" % (period, srctab, dbfile, T, vol_div))
    c = sqlite3.connect("file:%s/%s?mode=ro" % (DATA, dbfile), uri=True)

    # --- A. 行数守恒 ---
    n_src = SRC.execute("SELECT COUNT(*) FROM %s" % srctab).fetchone()[0]
    n_out = c.execute("SELECT COUNT(*) FROM %s" % T).fetchone()[0]
    n_res = c.execute("SELECT COUNT(*) FROM %s_residue" % T).fetchone()[0]
    reasons = c.execute("SELECT reason, COUNT(*) FROM %s_residue GROUP BY reason" % T).fetchall()
    ok_a = (n_src - n_out == n_res)
    print("[A] 行数守恒: 源=%d 产物=%d 残渣=%d 源-产物=%d 差=%d %s"
          % (n_src, n_out, n_res, n_src - n_out, (n_src - n_out) - n_res, "OK" if ok_a else "!!! 不守恒"))
    print("    残渣原因: %s" % (reasons or "无"))
    if not ok_a:
        FAIL.append("A 行数不守恒 period=%d" % period)

    meta = dict(c.execute("SELECT key,value FROM meta").fetchall())
    print("    meta: built_at=%s range=%s rows=%s residue=%s volume_unit=%s"
          % (meta.get("built_at"), meta.get("date_range"), meta.get("rows"),
             meta.get("residue"), meta.get("volume_unit")))

    # --- B. 因子自证（抽样 sample 只，覆盖其全部日期）---
    codes = [r[0] for r in c.execute("SELECT DISTINCT code FROM %s ORDER BY code LIMIT %d" % (T, sample))]
    ph = ",".join("?" * len(codes))
    raw_last = {}
    for code, dt, cl in SRC.execute(
            "SELECT code, datetime, close FROM %s WHERE code IN (%s) ORDER BY code, datetime" % (srctab, ph), codes):
        raw_last[(code, dt[:10])] = cl          # 顺序遍历 → 自然保留当日最后一根
    qfq = {}
    for code, date, cl in CDS.execute("SELECT code, date, close FROM daily WHERE code IN (%s)" % ph, codes):
        qfq[(code, date)] = cl
    n_cmp = n_bad = 0
    worst = (0.0, None)
    for code, date, raw_c, qc, f, flag in c.execute(
            "SELECT code, date, raw_close, qfq_close, factor, flag FROM adj_audit WHERE code IN (%s)" % ph, codes):
        r2 = raw_last.get((code, date))
        q2 = qfq.get((code, date))
        if r2 is None or q2 is None:
            continue
        n_cmp += 1
        if r2 != raw_c or q2 != qc:
            n_bad += 1
            continue
        dev = abs((q2 / r2) - f) / f if f else 9
        if dev > worst[0]:
            worst = (dev, (code, date))
        if dev > 1e-9:
            n_bad += 1
    print("[B] 因子自证(抽样%d只, %d条): 源价/日线价不符=%d 因子偏差>1e-9=%d 最大偏差=%.2e %s"
          % (len(codes), n_cmp, n_bad, n_bad, worst[0], worst[1] or ""))
    if n_bad:
        FAIL.append("B 因子自证不符 period=%d (%d条)" % (period, n_bad))

    # --- C. 复权后聚合 == clean_daily.close ---
    ids = [r[0] for r in c.execute(
        "SELECT DISTINCT code||'|'||substr(datetime,1,10) FROM %s WHERE code IN (%s) LIMIT 3000" % (T, ph), codes)]
    n_c = n_cbad = 0
    ex = None
    for k in ids:
        code, date = k.split("|")
        row = c.execute("SELECT close FROM %s WHERE code=? AND substr(datetime,1,10)=? "
                        "ORDER BY datetime DESC LIMIT 1" % T, (code, date)).fetchone()
        q = qfq.get((code, date))
        if row is None or q is None:
            continue
        n_c += 1
        rel = abs(row[0] - q) / q if q else 9
        if rel > 1e-6:
            n_cbad += 1
            if ex is None:
                ex = (code, date, row[0], q, rel)
    print("[C] 复权后日聚合 == clean_daily.close (抽样%d条): 不符=%d %s" % (n_c, n_cbad, ("例: %s" % (ex,)) if ex else ""))
    if n_cbad:
        FAIL.append("C 聚合口径不符 period=%d (%d条)" % (period, n_cbad))

    # --- D. 量额口径（volume 归一后 == 源；amount 原值） + E. 日内形态 ---
    n_d = n_dbad = n_ebad = 0
    dex = vex = None
    for code in codes[:40]:
        for dt, o, h, l, cl, v, a in c.execute(
                "SELECT datetime,open,high,low,close,volume,amount FROM %s WHERE code=? LIMIT 20" % T, (code,)):
            s = SRC.execute("SELECT open,high,low,close,volume,amount FROM %s WHERE code=? AND datetime=?"
                            % srctab, (code, dt)).fetchone()
            if not s:
                continue
            n_d += 1
            exp_v = (s[4] or 0) / vol_div
            if abs((a or 0) - (s[5] or 0)) > 1e-3:            # amount 不变
                n_dbad += 1
                if dex is None:
                    dex = (code, dt, a, s[5])
            if abs((v or 0) - exp_v) > max(1e-6, exp_v * 1e-9):  # volume 归一后相等
                n_dbad += 1
                if vex is None:
                    vex = (code, dt, v, exp_v)
            if s[3] and s[2] and s[1] and s[0]:
                r1 = (h / l if l else 0, cl / o if o else 0)
                r2 = (s[1] / s[2] if s[2] else 0, s[3] / s[0] if s[0] else 0)
                if abs(r1[0] - r2[0]) / r2[0] > 1e-6 or abs(r1[1] - r2[1]) / r2[1] > 1e-6:
                    n_ebad += 1
    print("[D] 量额口径(抽样%d条): 不符=%d amount例=%s volume例=%s" % (n_d, n_dbad, dex, vex))
    print("[E] 日内形态不变: 不符=%d" % n_ebad)
    if n_dbad:
        FAIL.append("D 量额口径不符 period=%d (%d条)" % (period, n_dbad))
    if n_ebad:
        FAIL.append("E 日内形态被改动 period=%d" % period)

    # --- F. 因子连续性 ---
    flags = c.execute("SELECT flag, COUNT(*) FROM adj_audit GROUP BY flag ORDER BY 2 DESC").fetchall()
    fmin, fmax = c.execute("SELECT MIN(factor),MAX(factor) FROM adj_audit").fetchone()
    print("[F] adj_audit 标记: %s；因子范围 %.6f ~ %.6f" % (flags, fmin, fmax))

    # --- G. 量纲不变量（独立复算：同日同票 sum(分钟 volume) ≈ daily.volume）---
    day = meta.get("date_range", " ~ ").split(" ~ ")[-1].strip() or None
    if day:
        try:
            c.execute("ATTACH DATABASE 'file:%s/clean_daily.db?mode=ro' AS cd" % DATA)
            rows = c.execute(
                "SELECT cd.daily.volume, s.v FROM "
                "(SELECT code, SUM(volume) v FROM %s WHERE substr(datetime,1,10)=? GROUP BY code) s "
                "JOIN cd.daily ON cd.daily.code=s.code AND cd.daily.date=? "
                "WHERE cd.daily.volume>0 AND s.v>0" % T, (day, day)).fetchall()
            ratios = sorted(dv / mv for dv, mv in rows)
            med = ratios[len(ratios) // 2] if ratios else None
            ok_g = med is not None and 0.98 <= med <= 1.02
            print("[G] 量纲不变量(%s): 可比%d只 median(daily/minute)=%s %s"
                  % (day, len(rows), ("%.4f" % med) if med is not None else "n/a", "OK" if ok_g else "!!!"))
            if not ok_g:
                FAIL.append("G 量纲不变量失败 period=%d (median=%s)" % (period, med))
        except Exception as e:
            print("[G] 量纲不变量: 异常 %s（不判失败，仅提示）" % e)
            FAIL.append("G 量纲自证异常 period=%d: %s" % (period, e))

    c.close()
    print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=400, help="因子自证抽样股票数")
    ap.add_argument("--quick", action="store_true", help="快速模式(抽样 80 只)")
    a = ap.parse_args()
    sample = 80 if a.quick else a.sample
    for period, srctab, dbfile, T, vol_div in PERIODS:
        check_period(period, srctab, dbfile, T, vol_div, sample)
    print("=" * 72)
    if FAIL:
        print("VERIFY_RESULT: FAIL ❌ " + "; ".join(FAIL))
        return 1
    print("VERIFY_RESULT: OK ✅ 全部通过（A行数/B因子/C聚合/D量额/E形态/G量纲）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
