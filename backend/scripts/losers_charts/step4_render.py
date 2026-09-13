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

tg = json.load(open(TARGETS, encoding="utf-8"))
cache = json.load(open(CACHE, encoding="utf-8"))

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

# ---------- 几何 ----------
W, ML, MR = 1216, 64, 52   # MR 留 52px 给右侧「累计贡献/成交量」面板标签，避免被 viewBox 裁字
PW = W - ML - MR
PAY, PAH = 34, 340
PBY, PBH = 392, 62
PCY, PCH = 472, 100
PDY, PDH = 584, 22
HGT = 664   # 640→664：给「月份刻度行」和「图例行」各留一条独立基线，避免重叠


def esc(s):
    return html.escape(str(s), quote=True)


def build_svg(c):
    bars = c["bars"]
    n = len(bars)
    if n < 5:
        return '<div class="note">无K线数据</div>'
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
    # 逐日累计贡献
    cum, s = [], 0.0
    tmap = {t["date"]: t for t in c["trades"]}
    for b in bars:
        t = tmap.get(b[0])
        if t:
            s += t["contrib"]
        cum.append(s)
    cmax = max([abs(x) for x in cum] + [0.3])

    def YC(v):
        return PCY + PCH / 2 - v / cmax * PCH / 2

    P = []
    A = P.append
    A(f'<svg viewBox="0 0 {W} {HGT}" width="100%" class="chart" '
      f'xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,Segoe UI,sans-serif">')
    # 面板底
    for y0, h in ((PAY, PAH), (PBY, PBH), (PCY, PCH)):
        A(f'<rect x="{ML}" y="{y0}" width="{PW}" height="{h}" fill="#fbfbfd" stroke="#e3e6ea"/>')
    # 月份网格
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
    # 累计贡献 零线 + 左轴
    A(f'<line x1="{ML}" y1="{YC(0):.1f}" x2="{ML+PW}" y2="{YC(0):.1f}" stroke="#c8ced4"/>')
    A(f'<text x="{ML-6}" y="{YC(0)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">0</text>')
    A(f'<text x="{ML-6}" y="{YC(cmax)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">+{cmax:.1f}</text>')
    A(f'<text x="{ML-6}" y="{YC(-cmax)+3:.1f}" font-size="10" fill="#6b7280" text-anchor="end">-{cmax:.1f}</text>')
    A(f'<text x="{ML+PW+6}" y="{PCY+14}" font-size="10" fill="#9aa0a6">累计贡献</text>')
    A(f'<text x="{ML+PW+6}" y="{PBY+14}" font-size="10" fill="#9aa0a6">成交量</text>')

    # ---- K线 ----
    for i, (d, o, h, l, cl, v) in enumerate(bars):
        up = cl >= o
        col = UP if up else DN
        x = X(i)
        A(f'<line x1="{x:.1f}" y1="{YP(h):.1f}" x2="{x:.1f}" y2="{YP(l):.1f}" stroke="{col}" stroke-width="0.9"/>')
        y1, y2 = YP(max(o, cl)), YP(min(o, cl))
        A(f'<rect x="{x-bw/2:.1f}" y="{y1:.1f}" width="{bw:.1f}" height="{max(0.8, y2-y1):.1f}" '
          f'fill="{"#fff" if up else col}" stroke="{col}" stroke-width="0.7"/>')
        A(f'<rect x="{ML+step*i:.1f}" y="{PBY}" width="{step:.1f}" height="{PBH}" '
          f'fill="{col}" opacity="0.55"/>')
    # ---- 累计贡献折线 ----
    pts = " ".join(f"{X(i):.1f},{YC(cum[i]):.1f}" for i in range(n))
    A(f'<polyline points="{pts}" fill="none" stroke="#3b6fb6" stroke-width="1.3"/>')

    # ---- 档位带 ----
    A(f'<rect x="{ML}" y="{PDY}" width="{PW}" height="{PDH}" fill="#f7f8fa" stroke="#e3e6ea"/>')
    for i, b in enumerate(bars):
        t = tmap.get(b[0])
        if t:
            A(f'<rect x="{ML+step*i:.1f}" y="{PDY+2}" width="{max(1.0, step):.1f}" height="{PDH-4}" '
              f'fill="{TIER_C.get(t["tier"], "#ccc")}"/>')
    A(f'<text x="{ML-6}" y="{PDY+15}" font-size="10" fill="#6b7280" text-anchor="end">档位</text>')

    # ---- 买卖点 ----
    miss = 0
    for t in c["trades"]:
        i = idx.get(t["date"])
        if i is None:
            continue
        prof = t["r5"] > 0
        col = UP if prof else DN
        x0, y0 = X(i), YP(t["entry"])
        j = idx.get(t["exit_date"]) if t.get("exit_date") else None
        tip = (f'{t["date"]} {t["D"]}×{t["S"]} {t["tier"]}档 w={t["weight"]:.2f} '
               f'买{t["entry"]:.2f}')
        if j is not None and t.get("exit") is not None:
            x1, y1 = X(j), YP(t["exit"])
            A(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="{col}" '
              f'stroke-width="1" opacity="0.55"/>')
            A(f'<circle cx="{x1:.1f}" cy="{y1:.1f}" r="2.3" fill="{col}" stroke="#fff" stroke-width="0.5"/>')
            tip += f' → {t["exit_date"]} 卖{t["exit"]:.2f} ({t["r5"]:+.2%}) contrib {t["contrib"]:+.3f}'
        else:
            miss += 1
            tip += f' （{t["r5"]:+.2%}，无卖价）'
        A(f'<path d="M{x0:.1f},{y0+2:.1f} l-3.2,5.4 l6.4,0 z" fill="{BUY_C}" stroke="#fff" stroke-width="0.5">'
          f'<title>{esc(tip)}</title></path>')

    # ---- 逐日 hover（透明列，含 O/H/L/C/量 + 当日交易）----
    for i, (d, o, h, l, cl, v) in enumerate(bars):
        t = tmap.get(d)
        s = f'{d} O{o:.2f} H{h:.2f} L{l:.2f} C{cl:.2f} V{v:,.0f}'
        if t:
            s += f' | {t["D"]}×{t["S"]} {t["tier"]}档 w={t["weight"]:.2f} r5={t["r5"]:+.2%} contrib={t["contrib"]:+.3f}'
        A(f'<rect x="{ML+step*i:.1f}" y="{PAY}" width="{step:.1f}" height="{PDY+PDH-PAY}" '
          f'fill="transparent"><title>{esc(s)}</title></rect>')

    # ---- 图例 ----
    lx, ly = ML, HGT - 18
    A(f'<path d="M{lx},{ly} l-3.2,5.4 l6.4,0 z" fill="{BUY_C}" stroke="#fff"/>')
    A(f'<text x="{lx+10}" y="{ly+5}" font-size="11" fill="#4b5563">买点（策略建仓日）</text>')
    lx += 150
    A(f'<circle cx="{lx}" cy="{ly+3}" r="3" fill="{UP}"/>')
    A(f'<text x="{lx+10}" y="{ly+5}" font-size="11" fill="#4b5563">卖点·赚（5日后平仓）</text>')
    lx += 175
    A(f'<circle cx="{lx}" cy="{ly+3}" r="3" fill="{DN}"/>')
    A(f'<text x="{lx+10}" y="{ly+5}" font-size="11" fill="#4b5563">卖点·亏</text>')
    lx += 110
    A(f'<line x1="{lx}" y1="{ly+3}" x2="{lx+22}" y2="{ly+3}" stroke="#8a8f98" stroke-width="1"/>')
    A(f'<text x="{lx+28}" y="{ly+5}" font-size="11" fill="#4b5563">持仓连线（买→卖）</text>')
    lx += 175
    for t in ("A", "C", "C-"):
        A(f'<rect x="{lx}" y="{ly-2}" width="12" height="9" fill="{TIER_C[t]}"/>')
        A(f'<text x="{lx+16}" y="{ly+5}" font-size="11" fill="#4b5563">{TIER_LBL[t]}</text>')
        lx += 78
    if miss:
        A(f'<text x="{ML+PW}" y="{ly+5}" font-size="11" fill="#b45309" text-anchor="end">'
          f'{miss} 笔无卖价（图上只画买点）</text>')
    A('</svg>')
    return "".join(P)


def chart_card(c):
    tname = c["name"] or ""
    tag = TIER_C.get("A")  # 仅用于配色占位
    dist = collections.Counter(t["tier"] for t in c["trades"])
    dist_s = " · ".join(f'{k}档 {dist[k]}' for k in ("A", "C", "C-", "D") if dist.get(k))
    cells = collections.Counter(t["D"] + "×" + t["S"] for t in c["trades"])
    cells_s = " · ".join(f"{k} {v}" for k, v in cells.most_common())
    rows = []
    for t in sorted(c["trades"], key=lambda x: x["date"]):
        pnl = t["r5"] > 0
        cls = "pl-u" if pnl else "pl-d"
        ex = t.get("exit")
        exs = ("%.2f" % ex) if ex is not None else "—"
        rows.append(
            "<tr><td>%s</td><td>%s×%s</td><td>%s</td><td class='r'>%.2f</td>"
            "<td class='r'>%.2f</td><td>%s</td><td class='r'>%s</td>"
            "<td class='r %s'>%+.3f%%</td><td class='r %s'>%+.4f</td></tr>"
            % (t["date"], t["D"], t["S"], t["tier"], t["weight"], t["entry"],
               t["exit_date"] or "—", exs, cls, t["r5"] * 100, cls, t["contrib"]))
    return f'''<section class="card" id="{c["code"]}_{c["year"]}">
  <h3>{c["code"]} {esc(tname)} <span class="yr">{c["year"]}</span>
      <span class="kind">{esc(c["kind"])}</span></h3>
  <div class="kv">
    <span>该年 ∑贡献 <b class="{'pl-d' if c['sum_contrib']<0 else 'pl-u'}">{c['sum_contrib']:+.2f}</b></span>
    <span>笔数 <b>{c["n_trades"]}</b></span>
    <span>均 5日收益 <b class="{'pl-d' if (c['mean_r5'] or 0)<0 else 'pl-u'}">{(c['mean_r5'] or 0):+.3%}</b></span>
    <span>胜率 <b>{(c['win'] or 0):.1%}</b></span>
  </div>
  <div class="sub">档位：{esc(dist_s)} ｜ 格：{esc(cells_s)}</div>
  {build_svg(c)}
  <details><summary>逐笔明细（{c["n_trades"]} 笔，按日期）</summary>
  <div class="tw"><table><thead><tr><th>买入日</th><th>格</th><th>档</th><th>权重</th><th>买价</th>
  <th>卖出日</th><th>卖价</th><th>r5</th><th>贡献</th></tr></thead>
  <tbody>{"".join(rows)}</tbody></table></div></details>
</section>'''


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

cards = "".join(chart_card(c) for c in charts)

HTML = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>最亏股票 · 买卖点标记 · regime_matrix 2020-2026</title>
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
</style></head><body>
<header>
  <h1>最亏的股票 · 买卖点标记（regime_matrix · 2020-2026）</h1>
  <div class="meta">数据源：<code>clean_daily.db</code>（v2 干净前复权基座 · inode 6720536）｜
   评估口径：建仓日 + 5 个交易日平仓（h=5）｜ 逐笔 {sum(v["n"] for v in years.values()):,} 笔 ｜
   生成时间 <span id="gen">—</span></div>
</header>
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
    <li>悬停任意一根 K 线可看当日 O/H/L/C/量 + 当日信号（格/档/权重/r5/贡献）。</li>
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

<h2>5 · 逐票图</h2>
{cards}

<section class="box">
  <h2>6 · 口径与出处</h2>
  <ul class="tips">
    <li>「该年」＝建仓日（entry）所在自然年；跨年持仓按建仓日归年。</li>
    <li>卖点＝买点 + 5 个交易日（用全市场交易日历推进，源 <code>clean_daily.db</code> 的 date 全集，共 {len(cache["calendar"])} 日）。</li>
    <li>买价＝CSV 的 <code>entry</code>（建仓当日收盘，前复权）；卖价＝K 线表当日收盘。</li>
    <li>原始逐笔（196 万笔全量）：同目录 <code>losers_full.csv.gz</code>。</li>
  </ul>
</section>
</div>
<script>document.getElementById('gen').textContent=new Date().toLocaleString('zh-CN');</script>
</body></html>'''

open(OUT, "w", encoding="utf-8").write(HTML)
print("写盘:", OUT, f"{os.path.getsize(OUT)/1024/1024:.2f} MB")
print("图数:", len(charts))
print("档分布:", dict(ag_t))
print("格分布:", dict(ag_c))
