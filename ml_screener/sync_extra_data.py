#!/usr/bin/env python3
"""
sync_extra_data.py — 增量更新 估值/龙虎榜/指数 (对齐 v12 评分数据源)

数据源:
  估值  : 东方财富 RPT_VALUEANALYSIS_DET   (value_daily)
  龙虎榜: 东方财富 RPT_DAILYBILLBOARD_DETAILSNEW (lhb_daily)
  指数  : 腾讯 sh000001 日线               (sh000001_daily.json)

用法:
  python3 sync_extra_data.py               # 全部更新 (估值+龙虎榜+指数)
  python3 sync_extra_data.py --value       # 仅估值
  python3 sync_extra_data.py --lhb         # 仅龙虎榜
  python3 sync_extra_data.py --index       # 仅指数
  python3 sync_extra_data.py --status      # 仅查看各源最新日期

原理: 从 DB 最新日期+1 扫描到今日, 逐个工作日请求东财接口,
      count>0 视为交易日并拉取全市场数据, count=0 视为非交易日跳过.
"""
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

SCLAW_DATA_DIR = "/root/sclaw/data"
ML_DIR = "/root/sclaw/ml_screener"
EXTRA_DB = f"{SCLAW_DATA_DIR}/cloud_extra.db"
KLINE_DB = f"{SCLAW_DATA_DIR}/stock_history.db"
IDX_DAILY = f"{ML_DIR}/sh000001_daily.json"

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}
EM_API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
PAGE_SIZE = 500


def em_get(report, filt, page=1, page_size=PAGE_SIZE):
    url = (f"{EM_API}?reportName={report}&columns=ALL&pageSize={page_size}"
           f"&pageNumber={page}&sortColumns=TRADE_DATE&sortTypes=-1"
           f"&filter={urllib.parse.quote(filt)}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
    return (j.get("result") or {})


def fetch_em_all(report, filt, page_size=PAGE_SIZE, sleep=0.2):
    """分页拉取东财全部记录."""
    rows = []
    page = 1
    while True:
        res = em_get(report, filt, page, page_size)
        data = res.get("data") or []
        rows.extend(data)
        total = res.get("count") or len(rows)
        if len(rows) >= total or not data:
            break
        page += 1
        time.sleep(sleep)
    return rows


def workdays_between(start_date, end_date):
    """返回 [start, end] 之间的工作日列表 (YYYY-MM-DD)."""
    out = []
    d = start_date
    while d <= end_date:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def db_latest(con, table, col="date"):
    try:
        r = con.execute(f"SELECT MAX({col}) FROM {table}").fetchone()
        return r[0] if r and r[0] else None
    except Exception:
        return None


# ============ 估值 ============
VAL_MAP = {
    "SECURITY_CODE": "code",
    "PE_TTM": "pe_ttm",
    "PB_MRQ": "pb_mrq",
    "PS_TTM": "ps_ttm",
    "PCF_OCF_TTM": "pcf_ocf_ttm",
    "PEG_CAR": "peg",
    "TOTAL_MARKET_CAP": "total_mktcap",
    "NOTLIMITED_MARKETCAP_A": "float_mktcap",
    "FREE_SHARES_A": "free_shares",
}


def sync_value(verbose=True):
    con = sqlite3.connect(EXTRA_DB)
    latest = db_latest(con, "value_daily")
    start = date.fromisoformat(latest) + timedelta(days=1) if latest else date(2009, 1, 1)
    days = workdays_between(start, date.today())
    if not days:
        if verbose:
            print(f"  [value] 已是最新 ({latest}), 无需更新")
        con.close()
        return 0
    total_rows = 0
    for d in days:
        filt = f"(TRADE_DATE='{d}')"
        rows = fetch_em_all("RPT_VALUEANALYSIS_DET", filt)
        if not rows:
            continue  # 非交易日
        recs = []
        for r in rows:
            rec = {}
            ok = True
            for src, dst in VAL_MAP.items():
                v = r.get(src)
                if dst == "code":
                    v = str(v).zfill(6) if v is not None else None
                rec[dst] = v
                if dst == "code" and v is None:
                    ok = False
            if ok:
                rec["date"] = d
                recs.append(rec)
        con.executemany(
            "INSERT OR REPLACE INTO value_daily (code,date,pe_ttm,pb_mrq,ps_ttm,pcf_ocf_ttm,peg,"
            "total_mktcap,float_mktcap,free_shares) VALUES (:code,:date,:pe_ttm,:pb_mrq,:ps_ttm,"
            ":pcf_ocf_ttm,:peg,:total_mktcap,:float_mktcap,:free_shares)", recs)
        con.commit()
        total_rows += len(recs)
        if verbose:
            print(f"  [value] {d}: +{len(recs)} 条")
        time.sleep(0.3)
    con.close()
    return total_rows


# ============ 龙虎榜 ============
def sync_lhb(verbose=True):
    con = sqlite3.connect(EXTRA_DB)
    latest = db_latest(con, "lhb_daily")
    start = date.fromisoformat(latest) + timedelta(days=1) if latest else date(2009, 1, 1)
    days = workdays_between(start, date.today())
    if not days:
        if verbose:
            print(f"  [lhb] 已是最新 ({latest}), 无需更新")
        con.close()
        return 0
    total_rows = 0
    for d in days:
        filt = f"(TRADE_DATE='{d}')"
        rows = fetch_em_all("RPT_DAILYBILLBOARD_DETAILSNEW", filt)
        if not rows:
            continue  # 非交易日
        # 同一股票当天可能多条上榜原因 → 按 code 汇总净额
        agg = {}
        for r in rows:
            code = str(r.get("SECURITY_CODE") or "").zfill(6)
            net = r.get("BILLBOARD_NET_AMT") or 0
            agg[code] = agg.get(code, 0) + net
        recs = [{"code": c, "date": d, "billboard_net": v} for c, v in agg.items()]
        con.executemany(
            "INSERT OR REPLACE INTO lhb_daily (code,date,billboard_net) VALUES (:code,:date,:billboard_net)",
            recs)
        con.commit()
        total_rows += len(recs)
        if verbose:
            print(f"  [lhb] {d}: +{len(recs)} 只")
        time.sleep(0.3)
    con.close()
    return total_rows


# ============ 指数 (上证指数) ============
def fetch_tencent_index(days=120):
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
           f"param=sh000001,day,,,{days},qfq")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        j = json.loads(r.read())
    d = (j.get("data") or {}).get("sh000001") or {}
    day = d.get("day") or d.get("qfqday") or []
    out = {}
    for row in day:
        if len(row) >= 2 and row[0]:
            try:
                out[str(row[0])] = float(row[2]) if row[2] not in (None, "") else None
            except (TypeError, ValueError):
                out[str(row[0])] = None
    return out


def sync_index(verbose=True):
    try:
        with open(IDX_DAILY) as f:
            idx = json.load(f)
    except Exception:
        idx = {"dates": [], "closes": []}
    cur_dates = set(idx.get("dates", []))
    new_map = fetch_tencent_index()
    added = 0
    for dt in sorted(new_map.keys()):
        if dt not in cur_dates:
            idx.setdefault("dates", []).append(dt)
            idx.setdefault("closes", []).append(new_map[dt])
            added += 1
    if added:
        # 保持排序
        pairs = sorted(zip(idx["dates"], idx["closes"]))
        idx["dates"] = [p[0] for p in pairs]
        idx["closes"] = [p[1] for p in pairs]
        with open(IDX_DAILY, "w") as f:
            json.dump(idx, f)
    if verbose:
        print(f"  [index] +{added} 天, 最新: {idx['dates'][-1] if idx['dates'] else 'N/A'} "
              f"收盘 {idx['closes'][-1] if idx['closes'] else 'N/A'}")
    return added


# ============ 换手率 (腾讯批量实时, 收盘后/周末=最后交易日) ============
QT_BATCH = 60


def fetch_tencent_turnover(codes):
    """codes: 6位纯数字列表 → {code: turnover_rate}. 腾讯实时, 收盘后/周末=最后交易日."""
    out = {}
    prefixed = []
    for c in codes:
        if c.startswith("6"):
            prefixed.append("sh" + c)
        elif c.startswith(("0", "3")):
            prefixed.append("sz" + c)
        else:
            continue  # 北交所等暂不支持
    for i in range(0, len(prefixed), QT_BATCH):
        chunk = prefixed[i:i + QT_BATCH]
        url = "https://qt.gtimg.cn/q=" + ",".join(chunk)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                txt = r.read().decode("gbk", errors="replace")
        except Exception:
            time.sleep(1.0)
            continue
        for line in txt.strip().split(";"):
            if "=" not in line or not line.strip():
                continue
            f = line.split("~")
            if len(f) > 50:
                code = f[2]
                try:
                    tr = float(f[38])
                except (TypeError, ValueError):
                    tr = None
                if tr is not None:
                    out[code] = tr
        time.sleep(0.15)
    return out


def sync_turnover(verbose=True, date_str=None):
    """增量: 取 stock_daily 最新日期, 若该日期换手率未同步则用腾讯补当日."""
    con = sqlite3.connect(KLINE_DB)
    if date_str is None:
        date_str = db_latest(con, "stock_daily")
    if not date_str:
        print("  [turnover] stock_daily 为空", file=sys.stderr)
        con.close()
        return 0
    have = con.execute(
        "SELECT COUNT(*) FROM stock_daily WHERE date=? AND turnover_rate>0", (date_str,)
    ).fetchone()[0]
    total = con.execute(
        "SELECT COUNT(*) FROM stock_daily WHERE date=?", (date_str,)
    ).fetchone()[0]
    if have >= total and total > 0:
        if verbose:
            print(f"  [turnover] {date_str} 已同步 ({have}/{total}), 跳过")
        con.close()
        return 0
    codes = [r[0] for r in con.execute(
        "SELECT code FROM stock_daily WHERE date=?", (date_str,))]
    con.close()
    if verbose:
        print(f"  [turnover] {date_str}: 拉取 {len(codes)} 只 (已有 {have})")
    tmap = fetch_tencent_turnover(codes)
    if not tmap:
        print(f"  [turnover] {date_str}: 腾讯无返回, 跳过")
        return 0
    try:
        tc = sqlite3.connect(f"{SCLAW_DATA_DIR}/daily_turnover.db")
        tc.executemany(
            "INSERT OR REPLACE INTO daily_turnover (code,date,turnover_rate) VALUES (?,?,?)",
            [(c, date_str, t) for c, t in tmap.items()])
        tc.commit()
        tc.close()
    except Exception as e:
        print(f"  [turnover] daily_turnover.db 写入失败: {e}", file=sys.stderr)
    con = sqlite3.connect(KLINE_DB)
    con.executemany(
        "UPDATE stock_daily SET turnover_rate=? WHERE code=? AND date=?",
        [(t, c, date_str) for c, t in tmap.items()])
    con.commit()
    con.close()
    if verbose:
        print(f"  [turnover] {date_str}: +{len(tmap)} 只")
    return len(tmap)


# ============ 状态 ============
def status():
    print("=== 数据源最新日期 ===")
    try:
        con = sqlite3.connect(KLINE_DB)
        k = db_latest(con, "stock_daily")
        con.close()
        print(f"  K线   stock_daily      : {k}")
    except Exception as e:
        print(f"  K线   stock_daily      : ERROR {e}")
    try:
        con = sqlite3.connect(EXTRA_DB)
        v = db_latest(con, "value_daily")
        l = db_latest(con, "lhb_daily")
        con.close()
        print(f"  估值   value_daily      : {v}")
        print(f"  龙虎榜 lhb_daily        : {l}")
    except Exception as e:
        print(f"  估值/龙虎榜             : ERROR {e}")
    try:
        con = sqlite3.connect(KLINE_DB)
        t = db_latest(con, "stock_daily")
        nz = con.execute("SELECT COUNT(*) FROM stock_daily WHERE date=? AND turnover_rate>0", (t,)).fetchone()[0]
        tot = con.execute("SELECT COUNT(*) FROM stock_daily WHERE date=?", (t,)).fetchone()[0]
        con.close()
        print(f"  换手率 stock_daily      : {t} 非0 {nz}/{tot}")
    except Exception as e:
        print(f"  换手率                   : ERROR {e}")
    try:
        with open(IDX_DAILY) as f:
            idx = json.load(f)
        print(f"  指数   sh000001_daily   : {idx['dates'][-1] if idx['dates'] else 'N/A'}")
    except Exception as e:
        print(f"  指数                     : ERROR {e}")


if __name__ == "__main__":
    args = sys.argv[1:]
    t0 = time.time()
    if "--status" in args:
        status()
        sys.exit(0)
    do_value = "--value" in args or not any(a in args for a in ("--lhb", "--index", "--turnover"))
    do_lhb = "--lhb" in args or not any(a in args for a in ("--value", "--index", "--turnover"))
    do_index = "--index" in args or not any(a in args for a in ("--value", "--lhb", "--turnover"))
    do_turnover = "--turnover" in args or not any(a in args for a in ("--value", "--lhb", "--index"))
    print("=== sync_extra_data ===")
    if do_value:
        n = sync_value()
        print(f"  估值更新完成: +{n} 条 ({time.time()-t0:.0f}s)")
    if do_lhb:
        n = sync_lhb()
        print(f"  龙虎榜更新完成: +{n} 条 ({time.time()-t0:.0f}s)")
    if do_index:
        n = sync_index()
        print(f"  指数更新完成: +{n} 天 ({time.time()-t0:.0f}s)")
    if do_turnover:
        n = sync_turnover()
        print(f"  换手率更新完成: +{n} 只 ({time.time()-t0:.0f}s)")
    print("=== 对齐检查 ===")
    status()
