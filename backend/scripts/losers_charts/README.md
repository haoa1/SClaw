# losers_charts/ — 「最亏个股 × 最亏年份」买卖点图表报表

产出 2026-09-13（v2：筹码面板 + MACD 面板 + 开关修复）。回答的问题：**把最亏的股票逐票画出来** ——
每票取它**自己最亏的那一年**，在 K 线上标出买点/卖点，装配成一张自包含静态 HTML 报表。

## 文件

| 文件 | 作用 |
|---|---|
| `step4_render.py` | **渲染器**：读 `targets.json` + `cache_charts.json` → 每票一张 SVG（K线 + 成交量 + MACD + 筹码 + 累计贡献 + 仓位）→ 装配 `charts_report.html` |
| `check_overlap.js` | **几何量测 v2**（决定性验证）：月份刻度行 × 图例行重叠数 / 右面板标签是否越出 viewBox / 全图文字两两重叠 / 文字右越界。返回 `overlapPairs=… textOverlapTotal=… rightOutTotal=…` |
| `check_toggle.js` | **开关自检**：勾选「显示全部逐笔」→ `.full` 必须由 `display:none` 变可见（且可逆）。返回 `offShown/onShown/backToOffShown … verdict=` |
| `verify_charts_report.sh` | **一站式真浏览器验证**：A 产物完整性(mTLS curl) → B 页面加载 → C 几何 → D 开关 → E 视觉证据(OFF/ON 截图 md5 必须不同) → F JS 异常。`VERDICT=PASS/FAIL`，exit code 同步 |
| `step4_render.py.bak_pre_chips_20260913` | 打补丁前备份（19,734 B） |

## 用法

```bash
# 渲染（默认读 /root/research_archive/losers_charts_20260913/）
python3 step4_render.py
# 自定义路径
python3 step4_render.py --data DIR --targets F --cache F --outdir DIR --out NAME.html

# 验证（默认验本地权威产物；给 URL 则先拉线上字节再验同一套）
bash verify_charts_report.sh
bash verify_charts_report.sh https://garuda.yizhipotian.top:8443/static/losers_charts_20260913/charts_report.html
```

**输入件**（不在 git 里，落在 `/root/research_archive/losers_charts_20260913/`）：
`targets.json`（18 票 × 目标年份清单）、`cache_charts.json`（K线/日历/逐笔缓存，589 KB）、
`enrich_metrics.json`（step3b 产出的筹码/MAE 等指标，18 票）。

## 产物

- 唯一图 **18** 张（一票一年），viewBox `1216×776`
- 档分布 `{A: 538, C: 245, C-: 423}`（共 1206 笔）、格分布 `{D1×S1: 538, D2×S1: 252, D3×S1: 245, D4×S1: 171}`
- 默认可见：入场段三角 688 + 段末卖点；勾选开关后追加 **536** 个加仓点圆 → `.full` 元素合计 **1608**（全部在 SVG 内）
- 面板：MACD(柱 5087 + DIF/DEA 36) / 成交量 18 / 累计贡献 19 / 获利盘 36 / 偏离成本 18 / 筹码面积 18 + 均成本线 36 + 偏离线 18
- 线上：`https://garuda.yizhipotian.top:8443/static/losers_charts_20260913/charts_report.html`（mTLS 强制，无证书 403）
- md5 `a69a75bb509c7786f374e618fab2dbeb`，**5,160,079 B**

**复现性**：入库版重跑 → **字节完全一致**（`BYTE_IDENTICAL=yes`，渲染无时间戳/随机序）。

## 三个已修渲染缺陷（只有真浏览器/几何量测才发现）

1. **月份刻度行压在图例行上** —— 两条基线撞在 `y=620` vs `y=622` → `HGT 640 → 664`（各占一条基线）
2. **右面板「累计贡献/成交量」标签被 viewBox 裁掉**（只显示「累」「成」）—— 4 汉字 ≈40px 从 `x=1170` 起，越过 `W=1180` → `W 1180 → 1216`、`MR 16 → 52`
3. **「显示全部逐笔」开关是死的（2026-09-13 修）** —— CSS 写的是
   `#alltrades:checked ~ .wrap .full{display:inline}`，但 `#alltrades` 在 `.tgbar > label` **内部**，
   `.wrap` 是 `.tgbar` 的**兄弟**（不是 checkbox 的兄弟）⇒ 通用兄弟选择器 `~` 永不匹配，
   `fullShown` 恒为 0。修法：勾选时给 `document.body` 加 `showfull` 类（`change` 事件监听），
   CSS 改 `body.showfull .full{display:inline}`（不依赖 DOM 兄弟关系）。
   ⚠️ 该缺陷**静态自查完全看不出来**（HTML 里 CSS 规则和 checkbox 都在），只有「勾上再看 `getComputedStyle`」才暴露。

> 布局类问题优先调几何常量（`W`/`MR`/`HGT`），不要重构结构。
> 交互类问题**必须双向测**（OFF→ON→OFF），只测一个状态会把「死开关」当正常。

## v3（2026-09-13）：补上「大盘腿」——regime_matrix 的另一半

背景：`regime_matrix` 的每个格子是 **D×S**（大盘态×个股态），但 v2 报表只画了 S 腿，
于是「这格为什么给 A 100% / C- 10%」少了一半依据。v3 把 D 腿补上：

1. `step3c_index.py`（新增）—— 上证综指 000001 日线 MACD + D 态。口径＝生产策略自己的
   `regime_matrix.classify_state`，**与报表内 1341 笔逐一对账 100.00% 一致**才写出
   `index_metrics.json`（不一致直接报错、不出报表）。缓存 `index_daily_000001.csv`，离线可复现；
   指数不复权 ⇒ D 腿天然不受「脏基座（减法复权）」影响，这也是拿它做两腿对账的附带好处。
2. 每张逐票图新增**大盘 MACD 面板**（`DDY=436, DDH=56`）：红绿柱 + DIF/DEA + 底色＝当日 D 态，
   与个股 MACD 面板一一对应；右距 `MR 52→80`（要放得下「上证大盘 / MACD(D态)」两行标签）。
3. 报表新增 **§6 上证大盘 MACD 与 D 态总览**：窗口＝各票窗口的并集，附「逐年 D 态分布
   （交易日数）+ 主导态 + 上证涨跌」。

### v3 踩到的三个坑（全都属于「静态自查看不出来」）

- **校验器必须跟着产物一起演进**：总览插在页面最前 ⇒ `svg.chart[0]` 不再是逐票图，`check_overlap.js`
  的月份探针取到总览（无月刻度）⇒ `months[0]` undefined ⇒ **校验器自己 TypeError 崩掉**，
  三条 grep 判据全空 ⇒ 报成「重叠 / 越界」的**假失败**。修法：探针改为「第一张带月刻度的图」，
  并打印 `probe=1182x820@svg#2` 自证落点。
- **轴的年份标签不能只靠「距离闸门」**：窗口并集起于 2020-12（2020 只有 23 个交易日），
  4 字标签会与紧邻的 2021 压字；只加距离闸门则把 2021 挤掉 ⇒ 轴上出现 2020/2022
  「看起来跳年」。正解＝**结构性判据**：只跳过「被窗口左沿切断的开头残年」（i==0 且不足
  60 交易日）；**右沿残年（2026 仅 20 日）必须保留**。年份竖线一律照画。
- **段标签阈值只能往小调、不能往大调**：D1/D2＝红柱走强/走弱，几乎逐日翻转
  （2021 各 ~60 日 ⇒ 平均段长 ≈4 根）⇒ 总览里 `min_len=25` **一个标签都出不来**
  （实测 `dlabels=[]`，D 态整条变成不可读）。对齐个股图 `seg_labels(dst, min_len=8)`。

> 数量级提醒：v3 产物 = 18 逐票图 + 1 总览 = **19 张 `svg.chart`**；校验脚本里的 `svg=18` 须同步改 19。

## 验证铁律（踩过的坑）

- **自包含 HTML 的「通过」必须由真浏览器给出** —— 结构自检/`node --check`/字段对账全绿也能是**全白页**。
- **截图相同 ≠ 页面相同**：`scrollintoview` 这种指令看着「滚了」其实没滚，4 张截图会一模一样。
  必须用 `getBoundingClientRect` **回读落点**来证明。
- **文件重生成后必须重新 `open`**，否则 `eval`/截图仍在旧 DOM 上。
- 视觉缺陷要么用**眼睛**（截图），要么用**尺子**（几何量测）；纯文本自查对「重叠/裁切」天然失明。
- 字体：需 `fonts-noto-cjk`，否则截图里汉字是豆腐块（等于看不见中文内容）。
- **https（mTLS）站点浏览器进不去**：`agent-browser` 不带客户端证书，直接 `open` 只能看到 nginx 403 空白页
  （实测 `document.body.innerHTML.length=33`、`svg=0`），几何/开关检查会**全部假失败**。
  正解 = `curl --cert/--key` 先落到本地文件 → 浏览器开 `file://` 落地副本；无证书访问另测须 403。
- **`getComputedStyle` 别全量扫**：1608 个 `.full` 元素逐个体检会打爆 CDP
  （`✗ CDP command timed out: Runtime.evaluate`）⇒ 采样 40 个即可（开关是全局类，采样足够）。
- **工具 shell 是 `dash` 且不支持 `$(...)` 里再套引号**：`$(md5sum "$F" | cut -d' ' -f1)` 会
  `Syntax error: "(" unexpected` ⇒ 部署/校验脚本一律写成 `.sh` 文件再 `bash` 跑。
- **「阈值 / 闸门」类参数改完要数「产出条数」，不能只看「没报错」**：`dlabels=[]`（标签全丢）
  和 `overlapPairs=0`（确实没重叠）在文字输出里长得一样「都没问题」。v3 的 D 态标签就是这么
  静默丢光的 —— 判据要写成**计数断言**（本次：总览年份标签必须 6 枚 2021–2026、D 态标签 >0）。
