# losers_charts/ — 「最亏个股 × 最亏年份」买卖点图表报表

产出于 2026-09-13。回答的问题：**把最亏的股票逐票画出来** —— 每票取它**自己最亏的那一年**，
在 K 线上标出买点/卖点，装配成一张自包含静态 HTML 报表。

## 文件

| 文件 | 作用 |
|---|---|
| `step4_render.py` | **渲染器**：读 `targets.json` + `cache_charts.json` → 每票一张 SVG → 装配 `charts_report.html` |
| `check_overlap.js` | **几何量测**（决定性验证）：在真页面里用 `getBoundingClientRect` 量「月份刻度行 × 图例行」是否重叠、右面板标签是否越出 viewBox。返回 `overlapPairs=N` |
| `verify_charts_report.sh` | **真浏览器验证**：`agent-browser open` → viewport 1400×1500 → 跑 `check_overlap.js` → 逐卡滚动截图 → 打印 js errors |

## 用法

```bash
# 渲染（默认读 /root/research_archive/losers_charts_20260913/）
python3 step4_render.py
# 自定义路径
python3 step4_render.py --data DIR --targets F --cache F --outdir DIR --out NAME.html

# 验证（会重开页面，避免看到旧 DOM）
bash verify_charts_report.sh
```

**输入件**（不在 git 里，落在 `/root/research_archive/losers_charts_20260913/`）：
`targets.json`（18 票 × 目标年份清单）、`cache_charts.json`（K线/日历/逐笔缓存，589 KB）。

## 产物

- 唯一图 **18** 张（一票一年）
- 档分布 `{A: 538, C: 245, C-: 423}`、格分布 `{D1×S1: 538, D2×S1: 252, D3×S1: 245, D4×S1: 171}`
- 买点三角 1224 / 卖点圆 1242 / 逐笔明细行 1206
- 线上：`https://garuda.yizhipotian.top:8443/static/losers_charts_20260913/charts_report.html`（mTLS 强制）
- md5 `bb927f7c946ae5431a8def13b120ae65`，3,067,262 B

**复现性**：入库版重跑 → **字节完全一致**（已验 `BYTE_IDENTICAL=yes`）。

## 两个已修渲染缺陷（只有真浏览器/几何量测才发现）

1. **月份刻度行压在图例行上** —— 两条基线撞在 `y=620` vs `y=622` → `HGT 640 → 664`（各占一条基线）
2. **右面板「累计贡献/成交量」标签被 viewBox 裁掉**（只显示「累」「成」）—— 4 汉字 ≈40px 从 `x=1170` 起，越过 `W=1180` → `W 1180 → 1216`、`MR 16 → 52`

> 布局类问题优先调几何常量（`W`/`MR`/`HGT`），不要重构结构。

## 验证铁律（踩过的坑）

- **自包含 HTML 的「通过」必须由真浏览器给出** —— 结构自检/`node --check`/字段对账全绿也能是**全白页**。
- **截图相同 ≠ 页面相同**：`scrollintoview` 这种指令看着「滚了」其实没滚，4 张截图会一模一样。
  必须用 `getBoundingClientRect` **回读落点**来证明。
- **文件重生成后必须重新 `open`**，否则 `eval`/截图仍在旧 DOM 上。
- 视觉缺陷要么用**眼睛**（截图），要么用**尺子**（几何量测）；纯文本自检对「重叠/裁切」天然失明。
- 字体：需 `fonts-noto-cjk`，否则截图里汉字是豆腐块（等于看不见中文内容）。
