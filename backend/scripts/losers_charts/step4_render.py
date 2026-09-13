#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第4步：渲染——每票一张 SVG（K线+买卖点+累计贡献+档位带），装配成静态 HTML"""
import json, os, sys, html, collections

# ---- 入库版（2026-09-13）：路径参数化，默认不再依赖 /tmp（tmpfs 重启即失） ----
def _arg(flag, default):
    a = sys.argv
    return a[a.index(flag) + 1] if flag in a else default

DATA = _arg("--data", "/root/research_archive/losers_charts_20260913")
WORK = _arg("--outdir", DATA)
os.makedirs(WORK, exist_ok=True)
OUT = os.path.join(WORK, _arg("--out", "charts_report.html"))
TARGETS = _arg("--targets", os.path.join(DATA, "targets.json"))
CACHE = _arg("--cache", os.path.join(DATA, "cache_charts.json"))

ENRICH = _arg("--enrich", os.path.join(DATA, "enrich_metrics.json"))
tg = json.load(open(TARGETS, encoding="utf-8"))
cache = json.load(open(CACHE, encoding="utf-8"))
# MACD + 筹码（step3b_enrich.py 产出）；缺文件则图照画、指标面板留空
EN = {}
if os.path.exists(ENRICH):
    EN = json.load(open(ENRICH, encoding="utf-8"))
    print("指标已载入:", ENRICH, "票数", len(EN))
else:
    print("⚠️ 未找到", ENRICH, "→ MACD/筹码面板为空")

# 大盘腿（上证指数 MACD + D 态，step3c_index.py 产出）；缺文件则大盘面板/总览留空
INDEX = _arg("--index", os.path.join(DATA, "index_metrics.json"))
IX, IX_SEQ, IXM = {}, [], {}
if os.path.exists(INDEX):
    _ix = json.load(open(INDEX, encoding="utf-8"))
    IX_SEQ = _ix["series"]
    IX = {r[0]: {"close": r[1], "dif": r[2], "dea": r[3], "hist": r[4], "state": r[5]}
          for r in IX_SEQ}
    IXM = _ix.get("meta", {})
    print(f"大盘已载入: {INDEX} {len(IX)} 日 {IXM.get('first')}..{IXM.get('last')} "
          f"最新 {IXM.get('last_state')}（D 态自检 {IXM.get('check_ratio')}）")
else:
    print("⚠️ 未找到", INDEX, "→ 大盘 MACD 面板/总览为空（先跑 step3c_index.py）")

# ---------- 去重 (code, year)：同一票同年只画一张 ----------
uniq, order = {}, []
for c in cache["charts"]:
    k = (c["code"], c["year"])
    if k in uniq:
        kinds = uniq[k]["kind"].split("·")
        if c["kind"] not in kinds:
            uniq[k]["kind"] = uniq[k]["kind"] + "·" + c["kind"]
    else:
        uniq[k] = c
        order.append(k)
charts = [uniq[k] for k in order]
print("唯一图数:", len(charts))

# ---------- 颜色 ----------
UP, DN = "#d14343", "#2e9e5b"          # 红涨 / 绿跌
TIER_C = {"A": "#c0392b", "C": "#e67e22", "C-": "#f1c40f", "D": "#9aa0a6"}
TIER_LBL = {"A": "A 100%", "C": "C 30%", "C-": "C- 10%", "D": "D 0%"}
BUY_C = "#ff7f0e"
# regime_matrix 状态底色（个股 S 态 / 大盘 D 态，同色系一一对应）——模块级，逐票图与总览共用
S_TINT = {"S1": "#fdecec", "S2": "#fdf5e6", "S3": "#e9f6ef", "S4": "#eef1f4"}
D_TINT = {"D%d" % (k + 1): S_TINT["S%d" % (k + 1)] for k in range(4)}

# ---------- 几何 ----------
W, ML, MR = 1216, 64, 80   # MR 留 80px：最长右侧标签＝「上证大盘MACD」，避免被 viewBox 裁字
PW = W - ML - MR
PAY, PAH = 34, 300    # K线
PMY, PMH = 344, 84    # 个股 MACD（柱 + DIF/DEA，底色＝个股 S 态）
DDY, DDH = 436, 56    # 上证大盘 MACD（柱 + DIF/DEA，底色＝大盘 D 态）—— regime_matrix 的另一半
PBY, PBH = 502, 58    # 成交量（真实高度）
PCY, PCH = 568, 92    # 累计贡献
PHY, PHH = 670, 56    # 筹码（获利盘面积 + 偏离均成本折线，双刻度）
PDY, PDH = 736, 22    # 仓位带（高度＝权重）
HGT = 844             # 底部：月份刻度行 + 三行图例，各留独立基线
LY1, LY2, LY3 = HGT - 52, HGT - 32, HGT - 12


def esc(s):
    return html.escape(str(s), quote=True)


def build_svg(c):
    bars = c["bars"]
    n = len(bars)
    if n < 5:
        return '<div class="note">无K线数据</div>'
    M = EN.get(c["code"], {})
    step = PW / n
    bw = max(1.6, min(6.0, step * 0.62))

    def X(i):
        return ML + step * (i + 0.5)

    his = [b[2] for b in bars]
    los = [b[3] for b in bars]
    pmax, pmin = max(his), min(los)
    pad = (pmax - pmin) * 0.04 or 0.1
    pmax += pad
    pmin -= pad

    def YP(p):
        return PAY + (pmax - p) / (pmax - pmin) * PAH

    vmax = max([b[5] for b in bars] + [1])

    def YV(v):
        return PBY + PBH - v / vmax * PBH

    idx = {b[0]: i for i, b in enumerate(bars)}
    tmap = {t["date"]: t for t in c["trades"]}
    # 逐日累计贡献
    cum, s = [], 0.0
    for b in bars:
        t = tmap.get(b[0])
        if t:
            s += t["contrib"]
        cum.append(s)
    cmax = max([abs(x) for x in cum] + [0.3])

    def YC(v):
        return PCY + PCH / 2 - v / cmax * PCH / 2

    # ---- MACD 尺度 ----
    hs = [M.get(b[0], {}).get("hist") for b in bars]
    dfs = [M.get(b[0], {}).get("dif") for b in bars]
    des = [M.get(b[0], {}).get("dea") for b in bars]
    mmax = max([abs(x) for x in hs + dfs + des if x is not None] + [1e-6]) * 1.10

    def YM(v):
        return PMY + PMH / 2 - v / mmax * PMH / 2

    # ---- 筹码尺度：获利盘 0..1（整幅）；偏离均成本 ±40%（半幅居中）----
    DEV_CAP = 0.40

    def YW(v):
        return PHY + PHH - min(max(v, 0.0), 1.0) * PHH

    def YD(v):
        v = min(max(v, -DEV_CAP), DEV_CAP)
        return PHY + PHH / 2 - v / DEV_CAP * PHH / 2

    def mg(d):
        return M.get(d) or {}

    def dev_of(d):
        m = mg(d)
        co, cl = m.get("cost"), None
        i = idx.get(d)
        if co and i is not None:
            cl = bars[i][4]
        return None if (not co or cl is None) else cl / co - 1.0

    def sstate(i):
        cur = hs[i]
        if cur is None or i == 0 or hs[i - 1] is None:
            return None
        prev = hs[i - 1]
        if cur > 0:
            return "S1" if cur > prev else "S2"
        if prev <= 0 and abs(cur) < abs(prev):
            return "S3"
        return "S4"

    # ---- 大盘腿（上证指数）：本窗口逐日 DIF/DEA/柱 + D 态（step3c_index.py 落盘）----
    drow = [IX.get(b[0]) or {} for b in bars]
    dhs = [r.get("hist") for r in drow]
    ddfs = [r.get("dif") for r in drow]
    ddes = [r.get("dea") for r in drow]
    dst = [r.get("state") for r in drow]
    dmax = max([abs(x) for x in dhs + ddfs + ddes if x is not None] + [1e-6]) * 1.10

    def YDM(v):
        return DDY + DDH / 2 - v / dmax * DDH / 2

    def seg_labels(vals, min_len=10, min_gap=36):
        """把状态序列切成「段」，只给够长的段标字（并保证字间 ≥min_gap，避开重叠审计）。"""
        segs, start, cur = [], 0, (vals[0] if vals else None)
        for i in range(1, n + 1):
            st = vals[i] if i < n else None
            if st != cur:
                if cur and i - start >= min_len:
                    segs.append((start, i - 1, cur))
                start, cur = i, st
        out, lastx = [], -1e9
        for a, b_, st in segs:
            x = min(max(X((a + b_) // 2), ML + 12), ML + PW - 12)
            if x - lastx < min_gap:
                continue
            out.append((x, st))
            lastx = x
        return out

    P = []
    A = P.append
    A(f'<svg viewBox="0 0 {W} {HGT}" width="100%" class="chart" '
      f'xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,Segoe UI,sans-serif">')
    # 面板底
    for y0, h in ((PAY, PAH), (PMY, PMH), (DDY, DDH), (PBY, PBH), (PCY, PCH), (PHY, PHH)):
        A(f'<rect x="{ML}" y="{y0}" width="{PW}" height="{h}" fill="#fbfbfd" stroke="#e3e6ea"/>')
    # MACD 面板底色 = 个股 S 态（与策略标签同源自算，自检 1341/1341 一致）
    for i, b in enumerate(bars):
        st = sstate(i)
        if st:
            A(f'<rect x="{ML+step*i:.1f}" y="{PMY}" width="{max(1.0, step):.1f}" height="{PMH}" '
              f'fill="{S_TINT[st]}" opacity="0.85"/>')
    # 大盘面板底色 = 大盘 D 态（同一 regime_matrix 口径）
    for i, st in enumerate(dst):
        if st:
            A(f'<rect x="{ML+step*i:.1f}" y="{DDY}" width="{max(1.0, step):.1f}" height="{DDH}" '
              f'fill="{D_TINT[st]}" opacity="0.85"/>')
    # 月份网格（贯穿全部面板）
    prev = None
    for i, b in enumerate(bars):
        m = b[0][:7]
        if m != prev:
            x = X(i)
            A(f'<line x1="{x:.1f}" y1="{PAY}" x2="{x:.1f}" y2="{PDY+PDH}" stroke="#eef1f4"/>')
            A(f'<text x="{x:.1f}" y="{PDY+PDH+14}" font-size="10" fill="#7a828a" '
              f'text-anchor="middle">{b[0][5:7]}月</text>')
            if prev is not None and b[0][5:7] == "01":
                A(f'<line x1="{x:.1f}" y1="{PAY}" x2="{x:.1f}" y2="{PDY+PDH}" '
                  f'stroke="#c8ced4" stroke-dasharray="3,3"/>')
            prev = m
    # 价格网格 + 左轴
    for k in range(5):
        p = pmin + (pmax - pmin) * k / 4
        y = YP(p)
        A(f'<line x1="{ML}" y1="{y:.1f}" x2="{ML+PW}" y2="{y:.1f}" stroke="#eef1f4"/>')
        A(f'<text x="{ML-6}" y="{y+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">{p:.2f}</text>')
    # 累计贡献：零线 + 左右轴
    A(f'<line x1="{ML}" y1="{YC(0):.1f}" x2="{ML+PW}" y2="{YC(0):.1f}" stroke="#c8ced4"/>')
    A(f'<text x="{ML-6}" y="{YC(0)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">0</text>')
    A(f'<text x="{ML-6}" y="{YC(cmax)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">+{cmax:.1f}</text>')
    A(f'<text x="{ML-6}" y="{YC(-cmax)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">-{cmax:.1f}</text>')
    # MACD 零线 + 左轴
    A(f'<line x1="{ML}" y1="{YM(0):.1f}" x2="{ML+PW}" y2="{YM(0):.1f}" stroke="#c8ced4"/>')
    A(f'<text x="{ML-6}" y="{YM(mmax)+10:.1f}" font-size="10" fill="#6b7280" text-anchor="end">+{mmax:.2f}</text>')
    A(f'<text x="{ML-6}" y="{YM(-mmax)-2:.1f}" font-size="10" fill="#6b7280" text-anchor="end">-{mmax:.2f}</text>')
    # 筹码：50% 参考线 + 偏离 0 线
    A(f'<line x1="{ML}" y1="{YW(0.5):.1f}" x2="{ML+PW}" y2="{YW(0.5):.1f}" stroke="#d7dbe0" stroke-dasharray="4,3"/>')
    A(f'<line x1="{ML}" y1="{YD(0):.1f}" x2="{ML+PW}" y2="{YD(0):.1f}" stroke="#c8ced4"/>')
    A(f'<text x="{ML-6}" y="{YW(1)+9:.1f}" font-size="10" fill="#6b7280" text-anchor="end">100%</text>')
    A(f'<text x="{ML-6}" y="{YW(0.5)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">50%</text>')
    A(f'<text x="{ML-6}" y="{YW(0)+11:.1f}" font-size="10" fill="#6b7280" text-anchor="end">0</text>')
    # 右侧面板标签
    A(f'<text x="{ML+PW+6}" y="{PMY+14}" font-size="10" fill="#9aa0a6">个股MACD</text>')
    A(f'<text x="{ML+PW+6}" y="{DDY+14}" font-size="10" fill="#9aa0a6">上证大盘</text>')
    A(f'<text x="{ML+PW+6}" y="{DDY+28}" font-size="10" fill="#9aa0a6">MACD(D态)</text>')
    A(f'<text x="{ML+PW+6}" y="{PBY+14}" font-size="10" fill="#9aa0a6">成交量</text>')
    A(f'<text x="{ML+PW+6}" y="{PCY+14}" font-size="10" fill="#9aa0a6">累计贡献</text>')
    A(f'<text x="{ML+PW+6}" y="{PHY+14}" font-size="10" fill="#9aa0a6">获利盘</text>')
    A(f'<text x="{ML+PW+6}" y="{PHY+28}" font-size="10" fill="#9aa0a6">偏离成本</text>')

    # ---- K线 ----
    for i, (d, o, h, l, cl, v) in enumerate(bars):
        up = cl >= o
        col = UP if up else DN
        x = X(i)
        A(f'<line x1="{x:.1f}" y1="{YP(h):.1f}" x2="{x:.1f}" y2="{YP(l):.1f}" stroke="{col}" stroke-width="0.9"/>')
        y1, y2 = YP(max(o, cl)), YP(min(o, cl))
        A(f'<rect x="{x-bw/2:.1f}" y="{y1:.1f}" width="{bw:.1f}" height="{max(0.8, y2-y1):.1f}" '
          f'fill="{"#fff" if up else col}" stroke="{col}" stroke-width="0.7"/>')
        yv = YV(v)
        A(f'<rect x="{ML+step*i:.1f}" y="{yv:.1f}" width="{max(1.0, step*0.9):.1f}" height="{PBY+PBH-yv:.1f}" '
          f'fill="{col}" opacity="0.55"/>')
    # ---- 均成本线（前复权，含漂移）----
    cpts = [(X(i), YP(mg(b[0]).get("cost"))) for i, b in enumerate(bars) if mg(b[0]).get("cost")]
    if len(cpts) > 1:
        A('<polyline points="%s" fill="none" stroke="#8b5cf6" stroke-width="1.2" '
          'stroke-dasharray="5,3" opacity="0.9"/>' % " ".join(f"{x:.1f},{y:.1f}" for x, y in cpts))
    # ---- 累计贡献折线 ----
    pts = " ".join(f"{X(i):.1f},{YC(cum[i]):.1f}" for i in range(n))
    A(f'<polyline points="{pts}" fill="none" stroke="#3b6fb6" stroke-width="1.3"/>')

    # ---- MACD 柱 + DIF/DEA ----
    for i, b in enumerate(bars):
        hh = hs[i]
        if hh is None:
            continue
        y0, y1 = YM(0), YM(hh)
        A(f'<rect x="{ML+step*i+bw*0.08:.1f}" y="{min(y0, y1):.1f}" width="{max(1.0, step*0.62):.1f}" '
          f'height="{max(0.7, abs(y1-y0)):.1f}" fill="{"#d14343" if hh > 0 else "#2e9e5b"}" opacity="0.75"/>')
    for key, col, wd in (("dif", "#1f2937", 1.2), ("dea", "#e08a1e", 1.2)):
        vv = dfs if key == "dif" else des
        pp = [(X(i), YM(vv[i])) for i in range(n) if vv[i] is not None]
        if len(pp) > 1:
            A('<polyline points="%s" fill="none" stroke="%s" stroke-width="%.1f"/>'
              % (" ".join(f"{x:.1f},{y:.1f}" for x, y in pp), col, wd))

    # ---- 上证大盘 MACD（同窗口、同 x 轴 = regime_matrix 的 D 腿）----
    A(f'<line x1="{ML}" y1="{YDM(0):.1f}" x2="{ML+PW}" y2="{YDM(0):.1f}" stroke="#c8ced4"/>')
    A(f'<text x="{ML-6}" y="{YDM(dmax)+10:.1f}" font-size="10" fill="#6b7280" text-anchor="end">+{dmax:.1f}</text>')
    A(f'<text x="{ML-6}" y="{YDM(-dmax)-2:.1f}" font-size="10" fill="#6b7280" text-anchor="end">-{dmax:.1f}</text>')
    for i in range(n):
        hh = dhs[i]
        if hh is None:
            continue
        y0, y1 = YDM(0), YDM(hh)
        A(f'<rect x="{ML+step*i+bw*0.08:.1f}" y="{min(y0, y1):.1f}" width="{max(1.0, step*0.62):.1f}" '
          f'height="{max(0.7, abs(y1-y0)):.1f}" fill="{"#d14343" if hh > 0 else "#2e9e5b"}" opacity="0.75"/>')
    for vv, col in ((ddfs, "#1f2937"), (ddes, "#e08a1e")):
        pp = [(X(i), YDM(vv[i])) for i in range(n) if vv[i] is not None]
        if len(pp) > 1:
            A('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.2"/>'
              % (" ".join(f"{x:.1f},{y:.1f}" for x, y in pp), col))
    # 状态段标签：把「段」标出来（个股 S 态 / 大盘 D 态）
    for x, st in seg_labels([sstate(i) for i in range(n)]):
        A(f'<text x="{x:.1f}" y="{PMY+11}" font-size="9" fill="#8a9099" text-anchor="middle">{st}</text>')
    if any(dst):
        for x, st in seg_labels(dst, min_len=8):
            A(f'<text x="{x:.1f}" y="{DDY+11}" font-size="9" fill="#8a9099" text-anchor="middle">{st}</text>')

    # ---- 筹码：获利盘面积 + 偏离均成本折线 ----
    wp = [(X(i), YW(wv_)) for i, wv_ in enumerate(
        [mg(b[0]).get("win") for b in bars]) if wv_ is not None]
    if len(wp) > 1:
        area = ("M %s L %.1f,%.1f L %.1f,%.1f Z" % (
            " L ".join(f"{x:.1f},{y:.1f}" for x, y in wp),
            wp[-1][0], PHY + PHH, wp[0][0], PHY + PHH))
        A(f'<path d="{area}" fill="#3b6fb6" opacity="0.18"/>')
        A('<polyline points="%s" fill="none" stroke="#3b6fb6" stroke-width="1.1"/>'
          % " ".join(f"{x:.1f},{y:.1f}" for x, y in wp))
    dp = [(X(i), YD(dv_)) for i, dv_ in enumerate([dev_of(b[0]) for b in bars]) if dv_ is not None]
    if len(dp) > 1:
        A('<polyline points="%s" fill="none" stroke="#b45309" stroke-width="1.3"/>'
          % " ".join(f"{x:.1f},{y:.1f}" for x, y in dp))

    # ---- 仓位带（高度＝权重）----
    A(f'<rect x="{ML}" y="{PDY}" width="{PW}" height="{PDH}" fill="#f7f8fa" stroke="#e3e6ea"/>')
    for i, b in enumerate(bars):
        t = tmap.get(b[0])
        if t:
            hh = 2 + (PDH - 5) * min(max(t["weight"], 0.0), 1.0)
            A(f'<rect x="{ML+step*i:.1f}" y="{PDY+PDH-2-hh:.1f}" width="{max(1.0, step):.1f}" height="{hh:.1f}" '
              f'fill="{TIER_C.get(t["tier"], "#ccc")}"/>')
    A(f'<text x="{ML-6}" y="{PDY+15}" font-size="10" fill="#6b7280" text-anchor="end">仓位</text>')

    # ---- 入场段：连续交易日 + 同格 ⇒ 一段 ----
    tr_sorted = sorted(c["trades"], key=lambda x: x["date"])
    runs, miss = [], 0
    for t in tr_sorted:
        i = idx.get(t["date"])
        if i is None:
            miss += 1
            continue
        cell = t["D"] + "×" + t["S"]
        if runs and runs[-1]["cell"] == cell and i == runs[-1]["last_i"] + 1:
            runs[-1]["ts"].append(t)
            runs[-1]["last_i"] = i
        else:
            runs.append({"cell": cell, "ts": [t], "last_i": i})
    # 先画「段内后续笔」（默认隐藏）：加仓点 + 该笔卖点
    for r in runs:
        for t in r["ts"][1:]:
            i, j = idx.get(t["date"]), idx.get(t.get("exit_date"))
            prof = t["r5"] > 0
            col = UP if prof else DN
            x0, y0 = X(i), YP(t["entry"])
            if j is not None and t.get("exit") is not None:
                A(f'<line class="full" x1="{x0:.1f}" y1="{y0:.1f}" x2="{X(j):.1f}" y2="{YP(t["exit"]):.1f}" '
                  f'stroke="{col}" stroke-width="0.8" opacity="0.45"/>')
                A(f'<circle class="full" cx="{X(j):.1f}" cy="{YP(t["exit"]):.1f}" r="1.7" fill="{col}" '
                  f'stroke="#fff" stroke-width="0.4"/>')
            tip = (f'加仓 {t["date"]} {t["D"]}×{t["S"]} {t["tier"]}档 w={t["weight"]:.2f} '
                   f'买{t["entry"]:.2f} → {t.get("exit_date") or "—"} 卖'
                   f'{t["exit"]:.2f} ({t["r5"]:+.2%}) 贡献{t["contrib"]:+.3f}')
            A(f'<circle class="full mk-c" cx="{x0:.1f}" cy="{y0:.1f}" r="1.9" fill="{BUY_C}" '
              f'stroke="#fff" stroke-width="0.4"><title>{esc(tip)}</title></circle>')
    # 再画「段」：段首买点 + 段末卖点 + 连线
    for r in runs:
        t0, tE = r["ts"][0], r["ts"][-1]
        i0, jE = idx[t0["date"]], idx.get(tE.get("exit_date"))
        x0, y0 = X(i0), YP(t0["entry"])
        ret = (tE["exit"] / t0["entry"] - 1.0) if (jE is not None and tE.get("exit")) else None
        col = UP if (ret is None or ret > 0) else DN
        m0 = mg(t0["date"])
        w0 = m0.get("win")
        dv0 = dev_of(t0["date"])
        tip = (f'入场段 {t0["date"]} → {tE.get("exit_date") or "—"}　{r["cell"]} {t0["tier"]}档 '
               f'w={t0["weight"]:.2f}　{r["ts"].__len__()}笔　买{t0["entry"]:.2f}')
        if jE is not None and tE.get("exit") is not None:
            tip += f' 卖{tE["exit"]:.2f}（{ret:+.2%}）'
        if w0 is not None:
            tip += f'\n筹码@买点：获利盘{w0:.1%}　均成本{m0.get("cost"):.2f}'
            if dv0 is not None:
                tip += f'（价偏离{dv0:+.1%}）'
            if m0.get("conc") is not None:
                tip += f'　90%集中度{m0["conc"]:.3f}'
        if m0.get("dif") is not None:
            tip += f'\nMACD@买点：DIF{m0["dif"]:.3f} DEA{m0["dea"]:.3f} 柱{m0["hist"]:+.3f}'
        if jE is not None and tE.get("exit") is not None:
            A(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{X(jE):.1f}" y2="{YP(tE["exit"]):.1f}" '
              f'stroke="{col}" stroke-width="1.1" opacity="0.5"/>')
            A(f'<circle cx="{X(jE):.1f}" cy="{YP(tE["exit"]):.1f}" r="2.6" fill="{col}" '
              f'stroke="#fff" stroke-width="0.6"/>')
        A(f'<path d="M{x0:.1f},{y0-4.6:.1f} l-3.6,6.2 l7.2,0 z" fill="{BUY_C}" stroke="#fff" '
          f'stroke-width="0.6"><title>{esc(tip)}</title></path>')

    # ---- 逐日 hover ----
    for i, (d, o, h, l, cl, v) in enumerate(bars):
        t = tmap.get(d)
        m = mg(d)
        s = f'{d} O{o:.2f} H{h:.2f} L{l:.2f} C{cl:.2f} V{v:,.0f}'
        if m.get("dif") is not None:
            s += f' | {sstate(i)} 个股MACD DIF{m["dif"]:.3f} DEA{m["dea"]:.3f} 柱{m["hist"]:+.3f}'
        _dr = drow[i]
        if _dr.get("dif") is not None:
            s += (f' | {_dr.get("state") or "D-"} 上证{_dr["close"]:.2f} '
                  f'MACD DIF{_dr["dif"]:.3f} DEA{_dr["dea"]:.3f} 柱{_dr["hist"]:+.3f}')
        if m.get("win") is not None:
            s += f' | 筹码 获利盘{m["win"]:.1%} 均成本{m["cost"]:.2f} 集中度{m["conc"]:.3f}'
            dv_ = dev_of(d)
            if dv_ is not None:
                s += f' 价偏离{dv_:+.1%}'
        if t:
            s += f' | {t["D"]}×{t["S"]} {t["tier"]}档 w={t["weight"]:.2f} r5={t["r5"]:+.2%} contrib={t["contrib"]:+.3f}'
        A(f'<rect x="{ML+step*i:.1f}" y="{PAY}" width="{step:.1f}" height="{PDY+PDH-PAY}" '
          f'fill="transparent"><title>{esc(s)}</title></rect>')

    # ---- 图例（两行）----
    lx, ly = ML, LY1
    A(f'<path d="M{lx},{ly} l-3.6,6.2 l7.2,0 z" fill="{BUY_C}" stroke="#fff"/>')
    A(f'<text x="{lx+11}" y="{ly+5}" font-size="11" fill="#4b5563">入场段·段首买点（同一格连续建仓合并为一段）</text>')
    lx += 300
    A(f'<circle cx="{lx}" cy="{ly+3}" r="2.6" fill="{UP}"/>')
    A(f'<text x="{lx+10}" y="{ly+5}" font-size="11" fill="#4b5563">段末卖点·赚</text>')
    lx += 118
    A(f'<circle cx="{lx}" cy="{ly+3}" r="2.6" fill="{DN}"/>')
    A(f'<text x="{lx+10}" y="{ly+5}" font-size="11" fill="#4b5563">段末卖点·亏</text>')
    lx += 118
    A(f'<line x1="{lx}" y1="{ly+3}" x2="{lx+22}" y2="{ly+3}" stroke="#8b5cf6" stroke-width="1.2" stroke-dasharray="5,3"/>')
    A(f'<text x="{lx+28}" y="{ly+5}" font-size="11" fill="#4b5563">均成本线（筹码）</text>')
    lx += 178
    A(f'<line x1="{lx}" y1="{ly+3}" x2="{lx+22}" y2="{ly+3}" stroke="#3b6fb6" stroke-width="2" opacity="0.5"/>')
    A(f'<text x="{lx+28}" y="{ly+5}" font-size="11" fill="#4b5563">获利盘%</text>')
    lx += 118
    A(f'<line x1="{lx}" y1="{ly+3}" x2="{lx+22}" y2="{ly+3}" stroke="#b45309" stroke-width="1.4"/>')
    A(f'<text x="{lx+28}" y="{ly+5}" font-size="11" fill="#4b5563">价偏离均成本（±40%）</text>')
    # 第二行
    lx, ly = ML, LY2
    A(f'<line x1="{lx}" y1="{ly+3}" x2="{lx+22}" y2="{ly+3}" stroke="#1f2937" stroke-width="1.2"/>')
    A(f'<text x="{lx+28}" y="{ly+5}" font-size="11" fill="#4b5563">DIF</text>')
    lx += 60
    A(f'<line x1="{lx}" y1="{ly+3}" x2="{lx+22}" y2="{ly+3}" stroke="#e08a1e" stroke-width="1.2"/>')
    A(f'<text x="{lx+28}" y="{ly+5}" font-size="11" fill="#4b5563">DEA</text>')
    lx += 70
    A(f'<rect x="{lx}" y="{ly-1}" width="11" height="8" fill="#d14343" opacity="0.75"/>')
    A(f'<text x="{lx+16}" y="{ly+5}" font-size="11" fill="#4b5563">红柱（D1..D4 同口径 2·(DIF−DEA)）</text>')
    lx += 268
    for t in ("A", "C", "C-"):
        A(f'<rect x="{lx}" y="{ly-2}" width="12" height="9" fill="{TIER_C[t]}"/>')
        A(f'<text x="{lx+16}" y="{ly+5}" font-size="11" fill="#4b5563">{TIER_LBL[t]}</text>')
        lx += 78
    # 第三行：面板底色 = regime_matrix 状态（上＝个股 S 态，下＝大盘 D 态）
    lx, ly = ML, LY3
    A(f'<text x="{lx}" y="{ly+5}" font-size="11" fill="#4b5563">面板底色：</text>')
    lx += 76
    A(f'<text x="{lx}" y="{ly+5}" font-size="11" fill="#4b5563">个股S态</text>')
    lx += 64
    for st, lab in (("S1", "红强"), ("S2", "红弱"), ("S3", "绿缩"), ("S4", "绿强")):
        A(f'<rect x="{lx}" y="{ly-2}" width="12" height="9" fill="{S_TINT[st]}" stroke="#dfe3e8"/>')
        A(f'<text x="{lx+16}" y="{ly+5}" font-size="11" fill="#4b5563">{st} {lab}</text>')
        lx += 76
    A(f'<text x="{lx+10}" y="{ly+5}" font-size="11" fill="#4b5563">大盘D态</text>')
    lx += 82
    for st, lab in (("D1", "红强"), ("D2", "红弱"), ("D3", "绿缩"), ("D4", "绿强")):
        A(f'<rect x="{lx}" y="{ly-2}" width="12" height="9" fill="{D_TINT[st]}" stroke="#dfe3e8"/>')
        A(f'<text x="{lx+16}" y="{ly+5}" font-size="11" fill="#4b5563">{st} {lab}</text>')
        lx += 76
    if miss:
        A(f'<text x="{ML+PW}" y="{ly+5}" font-size="11" fill="#b45309" text-anchor="end">'
          f'{miss} 笔无卖价（图上只画买点）</text>')
    A('</svg>')
    return "".join(P)


def chart_card(c):
    tname = c["name"] or ""
    M = EN.get(c["code"], {})
    dist = collections.Counter(t["tier"] for t in c["trades"])
    dist_s = " · ".join(f'{k}档 {dist[k]}' for k in ("A", "C", "C-", "D") if dist.get(k))
    cells = collections.Counter(t["D"] + "×" + t["S"] for t in c["trades"])
    cells_s = " · ".join(f"{k} {v}" for k, v in cells.most_common())
    ws = [M[t["date"]]["win"] for t in c["trades"] if M.get(t["date"], {}).get("win") is not None]
    dvs = []
    for t in c["trades"]:
        m = M.get(t["date"]) or {}
        if m.get("cost"):
            dvs.append(t["entry"] / m["cost"] - 1.0)
    # 段数
    idxd = {b[0]: i for i, b in enumerate(c["bars"])}
    runs = 0
    prev = None
    for t in sorted(c["trades"], key=lambda x: x["date"]):
        i = idxd.get(t["date"])
        if i is None:
            continue
        cell = t["D"] + "×" + t["S"]
        if prev is None or cell != prev[0] or i != prev[1] + 1:
            runs += 1
        prev = (cell, i)
    dwin = collections.Counter()
    for b in c["bars"]:
        _r = IX.get(b[0]) or {}
        if _r.get("state"):
            dwin[_r["state"]] += 1
    dtot = sum(dwin.values())
    dstate_s = (" · ".join(f"{k} {dwin[k] / dtot:.0%}" for k in ("D1", "D2", "D3", "D4"))
                if dtot else "无上证数据")
    chip_s = ""
    if ws:
        chip_s = (f'买点均获利盘 <b>{sum(ws)/len(ws):.1%}</b> '
                  f'（{min(ws):.0%}~{max(ws):.0%}）')
        if dvs:
            chip_s += f'　买点价均偏离均成本 <b class="{"pl-d" if sum(dvs)/len(dvs) < 0 else "pl-u"}">'
            chip_s += f'{sum(dvs)/len(dvs):+.1%}</b>'
    rows = []
    for t in sorted(c["trades"], key=lambda x: x["date"]):
        pnl = t["r5"] > 0
        cls = "pl-u" if pnl else "pl-d"
        ex = t.get("exit")
        exs = ("%.2f" % ex) if ex is not None else "—"
        m = M.get(t["date"]) or {}
        w = m.get("win")
        co = m.get("cost")
        dv = (t["entry"] / co - 1.0) if co else None
        hh = m.get("hist")
        rows.append(
            "<tr><td>%s</td><td>%s×%s</td><td>%s</td><td class='r'>%.2f</td>"
            "<td class='r'>%.2f</td><td class='r'>%s</td><td class='r'>%s</td><td class='r'>%s</td>"
            "<td class='r'>%s</td><td class='r'>%s</td>"
            "<td class='r'>%s</td><td class='r'>%s</td>"
            "<td class='r %s'>%+.3f%%</td><td class='r %s'>%+.4f</td></tr>"
            % (t["date"], t["D"], t["S"], t["tier"], t["weight"], t["entry"],
               "—" if w is None else "%.1f%%" % (w * 100),
               "—" if co is None else "%.2f" % co,
               "—" if dv is None else "%+.1f%%" % (dv * 100),
               "—" if m.get("conc") is None else "%.3f" % m["conc"],
               "—" if hh is None else "%+.3f" % hh,
               t["exit_date"] or "—", exs, cls, t["r5"] * 100, cls, t["contrib"]))
    return f'''<section class="card" id="{c["code"]}_{c["year"]}">
  <h3>{c["code"]} {esc(tname)} <span class="yr">{c["year"]}</span>
      <span class="kind">{esc(c["kind"])}</span></h3>
  <div class="kv">
    <span>该年 Σ贡献 <b class="{'pl-d' if c['sum_contrib']<0 else 'pl-u'}">{c['sum_contrib']:+.2f}</b></span>
    <span>笔数 <b>{c["n_trades"]}</b></span>
    <span>入场段 <b>{runs}</b></span>
    <span>均 5日收益 <b class="{'pl-d' if (c['mean_r5'] or 0)<0 else 'pl-u'}">{(c['mean_r5'] or 0):+.3%}</b></span>
    <span>胜率 <b>{(c['win'] or 0):.1%}</b></span>
  </div>
  <div class="sub">档位：{esc(dist_s)} ｜ 格：{esc(cells_s)}</div>
  <div class="sub">筹码：{chip_s}</div>
  <div class="sub">大盘态（窗口内交易日占比，口径＝上证日线 MACD）: {dstate_s}</div>
  {build_svg(c)}
  <details><summary>逐笔明细（{c["n_trades"]} 笔，按日期；含买点筹码与 MACD）</summary>
  <div class="tw"><table><thead><tr><th>买入日</th><th>格</th><th>档</th><th>权重</th><th>买价</th>
  <th>获利盘</th><th>均成本</th><th>价偏离</th><th>90%集中度</th><th>MACD柱</th>
  <th>卖出日</th><th>卖价</th><th>r5</th><th>贡献</th></tr></thead>
  <tbody>{"".join(rows)}</tbody></table></div></details>
</section>'''


def index_overview():
    """上证大盘 MACD + D 态总览：窗口＝各票图窗口的并集（同一 regime_matrix 口径）。"""
    if not IX_SEQ or not charts:
        return {"svg": "", "table": "", "d0": "—", "d1": "—", "n2": 0}
    d0 = min(c["bars"][0][0] for c in charts if c["bars"])
    d1 = max(c["bars"][-1][0] for c in charts if c["bars"])
    rows = [r for r in IX_SEQ if d0 <= r[0] <= d1]
    n2 = len(rows)
    if n2 < 5:
        return {"svg": "", "table": "", "d0": d0, "d1": d1, "n2": n2}
    W2, ML2, MR2 = W, ML, MR
    PW2 = W2 - ML2 - MR2
    CY, CH = 34, 150      # 收盘
    MY, MH = 196, 100     # MACD
    H2 = 340
    step2 = PW2 / n2

    def X2(i):
        return ML2 + step2 * (i + 0.5)

    cl2 = [r[1] for r in rows]
    cminv, cmaxv = min(cl2), max(cl2)

    def Y2(v):
        return CY + (cmaxv - v) / (cmaxv - cminv) * CH

    hm = max([abs(x) for r in rows for x in (r[2], r[3], r[4])] + [1e-6]) * 1.10

    def YM2(v):
        return MY + MH / 2 - v / hm * MH / 2

    P = []
    A = P.append
    A(f'<svg viewBox="0 0 {W2} {H2}" width="100%" class="chart" '
      f'xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,Segoe UI,sans-serif">')
    for y0, h in ((CY, CH), (MY, MH)):
        A(f'<rect x="{ML2}" y="{y0}" width="{PW2}" height="{h}" fill="#fbfbfd" stroke="#e3e6ea"/>')
    for i, r in enumerate(rows):
        if r[5]:
            A(f'<rect x="{ML2+step2*i:.1f}" y="{MY}" width="{max(1.0, step2):.1f}" height="{MH}" '
              f'fill="{D_TINT[r[5]]}" opacity="0.85"/>')
    prev = None
    lx = -1e9   # 上一枚年份标签的 x（防重叠闸门）
    yc = {}
    for r in rows:
        yc[r[0][:4]] = yc.get(r[0][:4], 0) + 1
    for i, r in enumerate(rows):
        yv = r[0][:4]
        if yv != prev:
            x = X2(i)
            A(f'<line x1="{x:.1f}" y1="{CY}" x2="{x:.1f}" y2="{MY+MH}" stroke="#dfe3e8"/>')
            # 窗口并集可能起于年中（本报表起于 2020-12，2020 仅 23 个交易日）⇒ 这枚 4 字标签
            # 既是噪音、又会把紧邻的 2021 挤掉（轴上出现 2020/2022「看起来跳年」的断档）。
            # 规则：只跳过「被窗口左沿切断的开头残年」（i==0 且不足 60 交易日）；右沿残年
            # （2026 仅 20 日）空间充裕，照贴。竖线一律照画，距离闸门兜底。
            if x - lx >= 26 and not (i == 0 and yc.get(yv, 0) < 60):
                tx = min(max(x, ML2 + 12), ML2 + PW2 - 12)
                A(f'<text x="{tx:.1f}" y="{MY+MH+18}" font-size="10" fill="#7a828a" '
                  f'text-anchor="middle">{yv}</text>')
                lx = tx
            prev = yv
    for k in (0, 1, 2):
        p = cminv + (cmaxv - cminv) * k / 2
        y = Y2(p)
        A(f'<line x1="{ML2}" y1="{y:.1f}" x2="{ML2+PW2}" y2="{y:.1f}" stroke="#eef1f4"/>')
        A(f'<text x="{ML2-6}" y="{y+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">{p:.0f}</text>')
    A('<polyline points="%s" fill="none" stroke="#111827" stroke-width="1.1"/>'
      % " ".join(f"{X2(i):.1f},{Y2(cl2[i]):.1f}" for i in range(n2)))
    A(f'<line x1="{ML2}" y1="{YM2(0):.1f}" x2="{ML2+PW2}" y2="{YM2(0):.1f}" stroke="#c8ced4"/>')
    A(f'<text x="{ML2-6}" y="{YM2(hm)+10:.1f}" font-size="10" fill="#6b7280" text-anchor="end">+{hm:.1f}</text>')
    A(f'<text x="{ML2-6}" y="{YM2(-hm)-2:.1f}" font-size="10" fill="#6b7280" text-anchor="end">-{hm:.1f}</text>')
    for i, r in enumerate(rows):
        hh = r[4]
        y0, y1 = YM2(0), YM2(hh)
        A(f'<rect x="{ML2+step2*i:.1f}" y="{min(y0, y1):.1f}" width="{max(1.0, step2*0.62):.1f}" '
          f'height="{max(0.7, abs(y1-y0)):.1f}" fill="{"#d14343" if hh > 0 else "#2e9e5b"}" opacity="0.75"/>')
    for k_, col in ((2, "#1f2937"), (3, "#e08a1e")):
        pts = " ".join(f"{X2(i):.1f},{YM2(rows[i][k_]):.1f}" for i in range(n2))
        A(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="1.1"/>')
    # 段标签（口径同个股图的 大盘面板：seg_labels(dst, min_len=8)）
    # ⚠️ 别把阈值往大调：D1/D2＝红柱走强/走弱，几乎逐日翻转（2021 各 ~60 日 ⇒ 平均段长≈4 根），
    #    门槛一放大就一个标签都出不来（曾用 25 ⇒ dlabels=[]，总览的 D 态变成不可读）。
    segs, start, cur = [], 0, (rows[0][5] if rows else None)
    for i in range(1, n2 + 1):
        st = rows[i][5] if i < n2 else None
        if st != cur:
            if cur and i - start >= 8:
                segs.append((start, i - 1, cur))
            start, cur = i, st
    lastx = -1e9
    for a, b_, st in segs:
        x = min(max(X2((a + b_) // 2), ML2 + 14), ML2 + PW2 - 14)
        if x - lastx < 30:
            continue
        A(f'<text x="{x:.1f}" y="{MY+12}" font-size="10" fill="#6b7280" text-anchor="middle">{st}</text>')
        lastx = x
    A(f'<text x="{ML2+PW2+6}" y="{CY+14}" font-size="10" fill="#9aa0a6">上证收盘</text>')
    A(f'<text x="{ML2+PW2+6}" y="{MY+14}" font-size="10" fill="#9aa0a6">上证大盘</text>')
    A(f'<text x="{ML2+PW2+6}" y="{MY+28}" font-size="10" fill="#9aa0a6">MACD(D态)</text>')
    A('</svg>')
    # 逐年 D 态分布表
    yb = {}
    for r in rows:
        d = yb.setdefault(r[0][:4], {"D1": 0, "D2": 0, "D3": 0, "D4": 0, "n": 0, "c0": r[1], "c1": r[1]})
        if r[5]:
            d[r[5]] += 1
        d["n"] += 1
        d["c1"] = r[1]
    trs = []
    for y in sorted(yb):
        d = yb[y]
        dom = max(("D1", "D2", "D3", "D4"), key=lambda k: d[k])
        chg = d["c1"] / d["c0"] - 1.0
        trs.append(f'<tr><td>{y}</td><td class="r">{d["n"]}</td><td class="r">{d["D1"]}</td>'
                   f'<td class="r">{d["D2"]}</td><td class="r">{d["D3"]}</td><td class="r">{d["D4"]}</td>'
                   f'<td>{dom}</td><td class="r {"pl-u" if chg > 0 else "pl-d"}">{chg:+.1%}</td></tr>')
    return {"svg": "".join(P), "table": "".join(trs), "d0": d0, "d1": d1, "n2": n2}


# ---------- 页面数据块 ----------
years = tg["years"]
wy = tg["worst_year"]
yr_rows = "".join(
    f'<tr class="{"neg" if years[y]["contrib"] < 0 else ""}"><td>{y}</td>'
    f'<td class="r">{years[y]["contrib"]:+.2f}</td><td class="r">{years[y]["n"]:,}</td>'
    f'<td class="r">{years[y]["mean_r5"]:+.3%}</td></tr>'
    for y in sorted(years))

def top_table(lst, ycol):
    out = []
    for i, e in enumerate(lst, 1):
        yv = e["worst_year"] if ycol == "wy" else "2022"
        cv = e["worst_year_contrib"] if ycol == "wy" else e["per_year"].get("2022", {}).get("contrib", 0)
        nn = e["worst_year_n"] if ycol == "wy" else e["per_year"].get("2022", {}).get("n", 0)
        mr = e["worst_year_mean_r5"] if ycol == "wy" else e["per_year"].get("2022", {}).get("mean_r5", 0)
        out.append(
            f'<tr><td>{i}</td><td><a href="#{e["code"]}_{yv}">{e["code"]}</a></td><td>{esc(e["name"] or "")}</td>'
            f'<td class="r neg">{e["sum_contrib"]:+.2f}</td><td class="r">{e["n"]}</td>'
            f'<td class="r neg">{e["mean_r5"]:+.2%}</td>'
            f'<td class="r">{yv}</td><td class="r neg">{cv:+.2f}</td><td class="r">{nn}</td>'
            f'<td class="r neg">{mr:+.2%}</td></tr>')
    return "".join(out)

# 汇总：这批票的格/档分布（只在"最亏年"口径下统计）
ag_t, ag_c = collections.Counter(), collections.Counter()
for c in charts:
    for t in c["trades"]:
        ag_t[t["tier"]] += 1
        ag_c[t["D"] + "×" + t["S"]] += 1
tot = sum(ag_t.values()) or 1
ag_rows = "".join(
    f'<tr><td>{k}</td><td class="r">{TIER_LBL.get(k,"")}</td><td class="r">{v}</td>'
    f'<td class="r">{v/tot:.1%}</td></tr>' for k, v in sorted(ag_t.items(), key=lambda x: -x[1]))
ag_cells = "".join(
    f'<tr><td>{k}</td><td class="r">{v}</td><td class="r">{v/tot:.1%}</td></tr>'
    for k, v in sorted(ag_c.items(), key=lambda x: -x[1]))

# ---------- 筹码分桶检验（样本＝本报表内全部逐笔）----------
_chip_rows = []
for c in charts:
    M = EN.get(c["code"], {})
    for t in c["trades"]:
        m = M.get(t["date"]) or {}
        if m.get("win") is None or not m.get("cost"):
            continue
        _chip_rows.append((m["win"], t["entry"] / m["cost"] - 1.0, t["r5"], t["contrib"]))


def _agg(rs):
    if not rs:
        return None
    return (len(rs), sum(x[2] for x in rs) / len(rs),
            sum(1 for x in rs if x[2] > 0) / len(rs), sum(x[3] for x in rs))


def _bucket_table(idx, buckets, title):
    out = []
    for lo, hi, lbl in buckets:
        a = _agg([x for x in _chip_rows if lo <= x[idx] < hi])
        if not a:
            continue
        out.append(f'<tr><td>{lbl}</td><td class="r">{a[0]}</td><td class="r neg">{a[1]:+.2%}</td>'
                   f'<td class="r">{a[2]:.1%}</td><td class="r neg">{a[3]:+.2f}</td></tr>')
    return (f'<div><h3>{title}</h3><table><thead><tr><th>桶</th><th class="r">笔数</th>'
            f'<th class="r">均 r5</th><th class="r">胜率</th><th class="r">Σ贡献</th></tr></thead>'
            f'<tbody>{"".join(out)}</tbody></table></div>')


_b_w = _bucket_table(0, [(0, .2, "0–20%"), (.2, .5, "20–50%"), (.5, .8, "50–80%"), (.8, 1.01, "80–100%")],
                     "按买点获利盘")
_b_d = _bucket_table(1, [(-9, 0, "低于均成本"), (0, .15, "0~+15%"), (.15, .4, "+15~+40%"), (.4, 9, ">+40%")],
                     "按买点价 / 均成本 − 1")
_chip_n = len(_chip_rows)


def _corr(a, b):
    n = len(a)
    if n < 3:
        return 0.0
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a) ** 0.5
    vb = sum((x - mb) ** 2 for x in b) ** 0.5
    if va == 0 or vb == 0:
        return 0.0
    return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / (va * vb)


_c_win = _corr([x[0] for x in _chip_rows], [x[2] for x in _chip_rows])
_c_dev = _corr([x[1] for x in _chip_rows], [x[2] for x in _chip_rows])
_c_wd = _corr([x[0] for x in _chip_rows], [x[1] for x in _chip_rows])

cards = "".join(chart_card(c) for c in charts)
OV = index_overview()
OV_SVG, OV_TABLE, OV_D0, OV_D1, OV_N = OV["svg"], OV["table"], OV["d0"], OV["d1"], OV["n2"]
print("上证总览:", "有" if OV_SVG else "无", f"窗口 {OV_D0}..{OV_D1} ({OV_N} 日)")

HTML = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>最亏股票 · 买卖点 + MACD + 筹码 · regime_matrix 2020-2026</title>
<style>
:root{{--up:#d14343;--dn:#2e9e5b;--bd:#e3e6ea;--mut:#6b7280}}
*{{box-sizing:border-box}}
body{{margin:0;font:14px/1.6 ui-sans-serif,"Segoe UI","Noto Sans CJK SC",sans-serif;color:#1f2328;background:#f5f6f8}}
header{{background:linear-gradient(135deg,#7f1d1d,#b91c1c);color:#fff;padding:22px 28px}}
header h1{{margin:0 0 6px;font-size:22px}}
header .meta{{opacity:.92;font-size:13px}}
.wrap{{max-width:1260px;margin:0 auto;padding:18px 20px 60px}}
section.card,section.box{{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:16px 18px;margin:16px 0}}
h2{{font-size:18px;margin:26px 0 8px;padding-left:10px;border-left:4px solid #b91c1c}}
h3{{font-size:16px;margin:0 0 8px}}
h3 .yr{{background:#111827;color:#fff;border-radius:4px;padding:1px 8px;font-size:13px;vertical-align:1px}}
h3 .kind{{color:#9ca3af;font-size:12px;font-weight:400;margin-left:6px}}
table{{border-collapse:collapse;width:100%;font-size:13px}}
th,td{{border-bottom:1px solid #eef1f4;padding:5px 8px;text-align:left;white-space:nowrap}}
th{{background:#fafbfc;color:#4b5563;font-weight:600;position:sticky;top:0}}
td.r,th.r{{text-align:right}}
tr.neg td{{background:#fff7f7}}
.neg{{color:#b91c1c}}
.pl-u{{color:var(--up)}} .pl-d{{color:var(--dn)}}
.kv{{display:flex;flex-wrap:wrap;gap:6px 20px;font-size:13px;color:#374151;margin-bottom:4px}}
.sub{{font-size:12px;color:var(--mut);margin-bottom:8px}}
.chart{{display:block;border-radius:6px}}
details{{margin-top:8px}}
summary{{cursor:pointer;font-size:13px;color:#1d4ed8}}
.tw{{max-height:340px;overflow:auto;margin-top:6px;border:1px solid var(--bd);border-radius:6px}}
.note{{color:#9ca3af;font-size:13px}}
ul.tips{{margin:8px 0 0;padding-left:22px;font-size:13px;color:#374151}}
ul.tips li{{margin:3px 0}}
code{{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}}
.flex{{display:flex;gap:20px;flex-wrap:wrap}}
.flex>div{{flex:1 1 320px}}
.full{{display:none}}
body.showfull .full,body:has(#alltrades:checked) .full{{display:inline}}
.tgbar{{position:sticky;top:0;z-index:9;background:#fffbe6;border-bottom:1px solid #f0d9a0;
  padding:8px 20px;font-size:13px;color:#7a4b00}}
.tgbar label{{cursor:pointer;user-select:none}}
.tgbar input{{vertical-align:-1px;margin-right:6px}}
</style></head><body>
<header>
  <h1>最亏的股票 · 买卖点标记 + MACD + 筹码（regime_matrix · 2020-2026）</h1>
  <div class="meta">数据源：<code>clean_daily.db</code>（v2 干净前复权基座 · inode 6720536）｜
   评估口径：建仓日 + 5 个交易日平仓（h=5）｜ 逐笔 {sum(v["n"] for v in years.values()):,} 笔 ｜
   生成时间 <span id="gen">—</span></div>
</header>
<div class="tgbar"><label><input type="checkbox" id="alltrades">显示全部逐笔
（默认只画「入场段」＝同一格连续建仓合并成一段；勾选后展开段内每一笔的加仓点与卖点）</label></div>
<div class="wrap">

<section class="box">
  <h2>0 · 怎么读</h2>
  <ul class="tips">
    <li><b>买点 ▲（橙）</b>＝策略在该交易日的 <code>D×S</code> 格里权重 &gt; 0，按该格档位建仓。</li>
    <li><b>卖点 ●</b>＝买点 <b>之后 5 个交易日</b>平仓。<span class="neg">这不是止盈止损</span>——是评估口径 h=5 的到期日；颜色＝红赚绿亏。</li>
    <li><b>持仓连线</b>＝该笔 买价 → 卖价 的矩形段，斜率向下＝这 5 天跌了。</li>
    <li><b>累计贡献</b>（蓝线）＝该年内 ∑<code>w·r5</code> 的累计值，终点＝该票该年总亏损。</li>
    <li><b>档位带</b>＝每日所处的仓位档：<span style="color:#c0392b">A 100%</span> /
      <span style="color:#e67e22">C 30%</span> / <span style="color:#f1c40f">C- 10%</span>。空白＝无仓位。</li>
    <li><b>「亏」的定义</b>＝仓位加权收益贡献 ∑(<code>weight×r5</code>)，单位是无量纲的收益贡献，<b>不是金额</b>。</li>
    <li><b>两个 MACD 面板</b>：上面＝<b>个股</b>（底色＝S 态），下面＝<b>上证大盘</b>（底色＝D 态）。
      一格信号＝上下两个底色同时刻的组合，即 <code>D×S</code>；段够长时面板里会标出状态字母（S1/S3/D2…），
      方便一眼看出「这一段是什么状态」。总览见 §6。</li>
    <li><b>个股 MACD 面板</b>＝个股日线 MACD(12,26,9)：<span style="color:#1f2937">DIF</span> /
      <span style="color:#e08a1e">DEA</span> / 红绿柱=2·(DIF−DEA)，<b>底色</b>＝该日 S 态
      （S1 红强/S2 红弱/S3 绿缩/S4 绿强）。策略的个股侧就是这一格，信号依据在这里能看到。</li>
    <li><b>筹码面板</b>＝<span style="color:#3b6fb6">获利盘比例</span>（面积，0–100%，虚线为 50%）+
      <span style="color:#b45309">价格 / 均成本 − 1</span>（折线，刻度 ±40%，0 线＝正好在均成本上）。
      K 线上的<span style="color:#8b5cf6">紫色虚线</span>＝筹码均成本（衰减模型，见 §8）。</li>
    <li><b>为什么买卖点少了</b>：同一格连续建仓会合并成一条「入场段」（留一个段首买点 + 一个段末卖点）；
      想逐笔看就勾选顶部开关，或展开下面的明细表。</li>
    <li>悬停任意一根 K 线可看当日 O/H/L/C/量 + MACD + 筹码 + 当日信号（格/档/权重/r5/贡献）。</li>
  </ul>
</section>

<section class="box">
  <h2>1 · 哪一年最亏</h2>
  <table><thead><tr><th>年份</th><th class="r">∑贡献</th><th class="r">笔数</th><th class="r">均 5日收益</th></tr></thead>
  <tbody>{yr_rows}</tbody></table>
  <div class="sub">最亏年份 = <b class="neg">{wy}</b>（唯一负年）。下面第 3 节就画 2022 年最亏的那些票。</div>
</section>

<h2>2 · 全期最亏的股票 TOP10（各自画在「自己最亏的那一年」）</h2>
<section class="box">
  <table><thead><tr><th>#</th><th>代码</th><th>名称</th><th class="r">全期∑贡献</th><th class="r">全期笔数</th>
  <th class="r">全期均r5</th><th class="r">最亏年</th><th class="r">该年∑贡献</th><th class="r">该年笔数</th>
  <th class="r">该年均r5</th></tr></thead><tbody>{top_table(tg["overall"][:10], "wy")}</tbody></table>
</section>

<h2>3 · {wy} 年最亏的股票 TOP10（各自画在 {wy} 年）</h2>
<section class="box">
  <table><thead><tr><th>#</th><th>代码</th><th>名称</th><th class="r">全期∑贡献</th><th class="r">全期笔数</th>
  <th class="r">全期均r5</th><th class="r">年份</th><th class="r">该年∑贡献</th><th class="r">该年笔数</th>
  <th class="r">该年均r5</th></tr></thead><tbody>{top_table(tg["y2022"][:10], "y")}</tbody></table>
</section>

<h2>4 · 这批最亏票的共性（只在上面各图的「最亏年」窗口内统计）</h2>
<section class="box">
  <div class="flex">
    <div><h3>档位分布</h3><table><thead><tr><th>档</th><th class="r">仓位</th><th class="r">笔数</th><th class="r">占比</th></tr></thead>
    <tbody>{ag_rows}</tbody></table></div>
    <div><h3>格位分布</h3><table><thead><tr><th>格</th><th class="r">笔数</th><th class="r">占比</th></tr></thead>
    <tbody>{ag_cells}</tbody></table></div>
  </div>
  <div class="sub">观察：亏损笔数集中在 <b>D1×S1</b> 与 <b>D2/D3/D4×S1</b>；这正是仓位表给出
    「A 100%」与「C/C- 30/10%」的格子 —— 权重方向与超额方向相反的老问题。<br>
    注：这张表只统计<b>已经跌在同一年里的这些票</b>，是「事后最亏者画像」，不能当作全样本结论
    （全样本结论见 <code>losers_report</code>）。</div>
</section>

<h2>5 · 筹码检验：买点那一刻的筹码结构，与后续 5 日收益</h2>
<section class="box">
  <div class="sub">样本＝本报表内<b>全部 {_chip_n} 笔</b>（18 票 × 各自最亏年）。⚠️ 这是<b>事后最亏者画像</b>，
  不是全市场样本 ⇒ 只能当线索，不能当定论；要下结论必须去全样本重跑（同 <code>losers_report</code> 的口径）。</div>
  <div class="flex">{_b_w}{_b_d}</div>
  <div class="sub">
    <b>相关系数</b>：获利盘 vs r5 = <b>{_c_win:+.3f}</b>　｜　价/均成本−1 vs r5 = <b>{_c_dev:+.3f}</b>　｜
    获利盘 vs 价/均成本−1 = <b>{_c_wd:+.3f}</b>（后两者高度重合 ⇒ 「获利盘」多半只是「离均成本多远」的一个更吵的代理）
  </div>
  <ul class="tips">
    <li><b>读出来的东西</b>：本样本里唯一像样的单调关系是「买价离筹码均成本越远越差」
      —— 低于均成本 −2.0%、0~+15% −3.0%、<b>+15~+40% −5.8%（胜率 20%）</b>。也就是<b>追高</b>的代价。</li>
    <li>获利盘单独用是 <b>U 形</b>（中间 20–50% 最好），不是单调；90% 成本集中度（密集/发散）基本无区分度。</li>
    <li>所以「没考虑筹码」这句话<b>方向上是对的</b>，但<b>不是把获利盘加进选股就能救</b>；
      真要动，动的是「买价 vs 均成本的偏离上限」这一条闸门 —— 且必须先在<b>全样本</b>上验证。</li>
  </ul>
</section>

<h2>6 · 上证大盘 MACD 与 D 态（regime_matrix 的另一半）</h2>
<section class="box">
  <div class="sub">窗口＝下面各票图的<b>并集</b>（<code>{OV_D0}</code> … <code>{OV_D1}</code>，共 <b>{OV_N}</b> 个交易日）。
  指数＝<b>{IXM.get("index_name", "上证综指")}{IXM.get("index_code", "")}</b>，MACD(12,26,9) 与个股腿<b>同一实现</b>（同一个函数，
  不是抄一份），红绿柱＝2·(DIF−DEA)。D 态口径＝<code>regime_matrix.classify_state</code>：
  D1 红柱走强 / D2 红柱走弱 / D3 绿柱收缩 / D4 绿柱走强；<b>面板底色</b>就是当日 D 态（与个股面板一一对应）。</div>
  {OV_SVG}
  <div class="flex">
    <div><h3>逐年 D 态分布（交易日数）</h3>
      <table><thead><tr><th>年份</th><th class="r">交易日</th><th class="r">D1 红强</th><th class="r">D2 红弱</th>
      <th class="r">D3 绿缩</th><th class="r">D4 绿强</th><th>主导态</th><th class="r">上证涨跌</th></tr></thead>
      <tbody>{OV_TABLE}</tbody></table></div>
  </div>
  <ul class="tips">
    <li><b>为什么要这张图</b>：<code>regime_matrix</code> 的每个格子是 <b>D×S</b>（大盘态×个股态）。逐票图只画了 S 腿，
      于是「这一格为什么给 A 100% / C- 10%」少了一半依据；这张总览把 D 腿画出来，两腿可对读。</li>
    <li><b>交叉自检（跨源）</b>：本图重算的 D 态，与生产策略自己记录的交易 D 标签逐一比对 ＝
      <b>{IXM.get("check_trades", 0)} 笔 {IXM.get("check_ratio", 0):.2%} 一致</b>
      （<code>step3c_index.py</code> 落盘时断言；不一致会直接报警不出报表）。
      一致 ⇒ 指数序列、前复权口径、MACD 实现、状态机四者与生产同源。</li>
    <li><b>数据出处</b>：<code>{IXM.get("cache")}</code>（md5 <code>{(IXM.get("cache_md5") or "")[:12]}</code>，
      源 {IXM.get("source")}）→ <code>index_metrics.json</code>；缓存命中则离线可复现。</li>
    <li><b>上证没有前复权问题</b>：指数不做除权处理，故 D 腿不受「脏基座（减法复权）」影响 ——
      这也是拿它做两腿对读的一个附带好处。</li>
  </ul>
</section>

<h2>7 · 逐票图</h2>
{cards}

<section class="box">
  <h2>8 · 口径与出处</h2>
  <ul class="tips">
    <li>「该年」＝建仓日（entry）所在自然年；跨年持仓按建仓日归年。</li>
    <li>卖点＝买点 + 5 个交易日（用全市场交易日历推进，源 <code>clean_daily.db</code> 的 date 全集，共 {len(cache["calendar"])} 日）。</li>
    <li>买价＝CSV 的 <code>entry</code>（建仓当日收盘，前复权）；卖价＝K 线表当日收盘。</li>
    <li><b>MACD</b>：用 <code>clean_daily.db</code> 前复权 close 按 (12,26,9) 重算，面板/表格里的柱值＝2·(DIF−DEA)；
      为验证「图上的 MACD 与策略标签同源」，用重算柱值按 regime_matrix 规格反推 S 态与逐笔标签比对 ——
      <b>S 态自检 1341/1341 一致</b>（脚本 <code>step3b_enrich.py</code> 自带该项断言）。</li>
    <li><b>筹码</b>：标准<b>衰减分布</b>模型 —— 第 j 日筹码 <code>w_j = 换手率_j · Π_{{k&gt;j}}(1−换手率_k)</code>，
      当日价位取 <code>(O+H+L+C)/4</code>（前复权，故 amount/volume 不可用：amount 是原始金额、价是复权价）。
      获利盘＝成本低于当日收盘的筹码占比；90% 集中度＝<code>(P90−P10)/(P90+P10)</code>；回看窗口 500 自然日。</li>
    <li><b>别把「获利盘」当独立信息</b>：它与「价格/均成本−1」相关系数 {_c_wd:+.2f}，本质同一件事的两种说法。</li>
    <li>原始逐笔（196 万笔全量）：同目录 <code>losers_full.csv.gz</code>。</li>
  </ul>
</section>
</div>
<script>document.getElementById('gen').textContent=new Date().toLocaleString('zh-CN');
var _at=document.getElementById('alltrades');_at.addEventListener('change',function(){{document.body.classList.toggle('showfull',this.checked);}});</script>
</body></html>'''

open(OUT, "w", encoding="utf-8").write(HTML)
print("写盘:", OUT, f"{os.path.getsize(OUT)/1024/1024:.2f} MB")
print("图数:", len(charts))
print("档分布:", dict(ag_t))
print("格分布:", dict(ag_c))
