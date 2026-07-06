---
description: 股票多维度分析团队协同研究能力 — 价格/技术/基本面/行业概念全链路分析，提供投资决策支持、风险评估、市场复盘
categories: [finance, stock, analysis, a-share]
scripts:
  - market_data_fetcher_cn.py: A股行情+技术指标获取（腾讯行情+新浪K线+ta指标）
  - analysis_data_bridge.py: 统一数据桥 — 价格+技术+财务+行业信息合并JSON
  - chart_generator.py: 生成K线/MACD/RSI/走势图表
  - html_report_generator.py: 生成HTML研究报告（Jinja2模板）
  - image_fetcher.py: 获取公司Logo/产品图片
  - sniper_limit_up.py: 狙击涨停板选股策略引擎 (曹达<狙击涨停板>) — 大盘情绪扫描/首板评分/连板追踪/龙头评分/仓位计算
---

# 股票分析团队 📊

> 多角色团队协同完成股票的深度分析和投资决策支持。数据层使用腾讯实时行情 + 新浪K线 + AKShare财务数据，无需代理。

## 前置准备

依赖说明（已在服务器安装）：
```bash
pip install pandas numpy matplotlib beautifulsoup4 plotly akshare ta requests jinja2 lxml
```

**使用前请先 `load_skill stock-analysis-team` 加载本技能。**

## 数据层整合

### 快速通道 — 一键获取完整分析数据

```bash
run_script({skill: "stock-analysis-team", script: "analysis_data_bridge.py", args: "--symbol 600519.SH --market cn"})
```

输出 JSON 包含：
- `price_technical`：价格、技术指标(MA/MACD/RSI/布林带)、趋势分析
- `fundamentals.financial_abstract`：财务摘要（归母净利润、营收、毛利率、ROE等70+指标，最近4个季度）
- `fundamentals.financial_indicators`：财务指标（ROE、毛利率、净利率、资产负债率等60+指标）
- `fundamentals.industry_info`：所属行业板块 + 所属概念板块（BeautifulSoup解析新浪行业页）

### 生成技术图表

```bash
run_script({skill: "stock-analysis-team", script: "chart_generator.py", args: "--symbol 600519.SH --market cn --chart-type all --output-dir /tmp/charts"})
```

支持类型：`price`(走势图)、`candlestick`(K线图)、`macd`、`rsi`、`all`

### 生成HTML研究报告

```bash
# 1. 获取完整数据保存为JSON
run_script({skill: "stock-analysis-team", script: "analysis_data_bridge.py", args: "--symbol 600519.SH --market cn --output /tmp/report_data.json"})
# 2. 生成图表
run_script({skill: "stock-analysis-team", script: "chart_generator.py", args: "--symbol 600519.SH --market cn --chart-type all --output-dir /tmp/charts"})
# 3. 生成报告
run_script({skill: "stock-analysis-team", script: "html_report_generator.py", args: "--data /tmp/report_data.json --charts-dir /tmp/charts --output /tmp/report.html"})
```

## 标准分析流程（多角色团队协同）

当用户请求分析股票时，按以下步骤执行：

### 步骤1：股票代码识别
- 用户输入名称 → 调用 `run_script` 执行 Python 查询代码获取代码
- 支持格式：A股 600519.SH / 000858.SZ，美股 AAPL

### 步骤2：获取完整数据

```bash
run_script({skill: "stock-analysis-team", script: "analysis_data_bridge.py", args: "--symbol <代码> --market cn"})
```

### 步骤3：分析师团队协同工作

从步骤2的JSON中提取数据，逐角色分析：

**基本面分析师：**
- 评估财务健康状况：ROE、毛利率、净利率、资产负债率趋势
- 检查：营收增长率、利润增长率、现金流质量
- 关注：每股净资产 vs 股价（PE/PB是否合理）
- 陷阱信号：每股未分配利润为负（历史亏损）、商誉过大

**技术分析师：**
- 均线系统：MA5/MA10/MA20/MA60排列（多头/空头/缠绕）
- MACD：金叉/死叉/背离
- RSI：超买(>70)/超卖(<30)/中性
- 布林带：价格位置（上轨/中轨/下轨）
- 趋势分析：trend_analysis 字段的 ma_signal / macd_signal / rsi_signal

**情绪分析师：**
- 换手率：高换手（游资活跃）vs 低换手（机构锁仓）
- 涨跌幅与成交量配合关系
- 52周高低位置

### 步骤4：研究员团队辩论

**看多研究员：** 基于数据列出上涨理由（低估值、业绩拐点、技术底背离、板块热点）
**看空研究员：** 列出下跌风险（高估值、业绩下滑、技术破位、概念炒作退潮）

### 步骤5：风控评估

按1-10分评估风险等级：
- 估值风险：PE/PB历史分位
- 财务风险：负债率、现金流、盈利质量
- 技术风险：趋势强度
- 流动性风险：换手率、市值

### 步骤6：交易建议输出

综合所有分析，输出包含：推荐操作（买入/观望/卖出）、目标价位、止损价位、风险等级、核心逻辑

## 行业/概念信息说明

行业数据和概念板块来自新浪F10页面（BeautifulSoup解析）：
- 来源：http://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpOtherInfo/stockid/{code}/menu_num/2.phtml
- 包含：所属行业板块（申万一级行业）、所属概念板块（最多显示前10个+总数）
- 无需代理，直接HTTP访问

## 狙击涨停板选股策略引擎

> 基于《狙击涨停板——打板客高级进阶教程》(曹达) 的完整策略系统化

### 选股流水线 (五步)

```text
Step 1: 大盘情绪扫描 → 涨停数/跌停数/涨停跌停比/情绪分(1-10)
Step 2: 涨停板分析 → 连板检测(首板/二板/三板+)，流通市值/股价/换手率
Step 3: 首板评分 → 5维度评分(盘大小/股价/换手/板类型/强度) [0-10分]
Step 4: 龙头评分 → 寻龙诀7变量(政策/氛围/题材/高度/K线/技术/分时) [0-21分]
Step 5: 仓位计算 → 凯利公式 + 香农之妖(单只≤1/3, 总持仓≤2只, 现金≥1/3)
```

### 使用方法

```bash
# 完整选股流水线
run_script({skill: "stock-analysis-team", script: "sniper_limit_up.py", args: "--mode pipeline --capital 100000"})

# 保存结果为JSON
run_script({skill: "stock-analysis-team", script: "sniper_limit_up.py", args: "--mode pipeline --capital 100000 --output /tmp/sniper_result.json"})

# 仅情绪扫描
run_script({skill: "stock-analysis-team", script: "sniper_limit_up.py", args: "--mode scan"})

# 个股连板检测
run_script({skill: "stock-analysis-team", script: "sniper_limit_up.py", args: "--mode stock --symbol 000858.SZ"})
```

### 核心理念速查

| 策略 | 要点 | 脚本逻辑 |
|:----|:-----|:---------|
| **首板战法** | 早盘封板前排，流通盘3-7亿，中低价 | score_first_board() |
| **二板接力** | 放量实体换手板最佳，竞价高开>3% | board_count==2 |
| **天板有缝** | 盘中开板→急速回封，仓位1/3 | intraday gap detection |
| **大长腿** | 盘中深V→封板，仓位1/6~1/4 | (需要实时分时数据) |
| **寻龙诀** | 7变量综合评分≥60%即为龙头候选 | dragon_head_scoring() |
| **凯利公式** | f*=(bp-q)/b, 胜率=75%基准+评分增益 | calculate_position() |
| **香农之妖** | 单只≤1/3, 总持仓≤2只, 现金≥1/3 | position sizing limit |

### 注意事项
- 风险评分必须基于多维度综合判断，避免单一指标主导
- 数据源：A股腾讯实时行情 qt.gtimg.cn + 新浪历史K线 + AKShare财务数据
- 本skill不含美股数据（如需美股需 yfinance 数据源，但当前未集成）
- 选股结果仅供参考，实盘需结合人工判断和动态市场信息
