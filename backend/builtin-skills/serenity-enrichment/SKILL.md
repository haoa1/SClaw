---
description: Serenity 瓶颈投资法深度数据集成 — 对 chokepoint-screener-v2 快速扫描结果做六层全量 AKShare+autocli 验证，输出六层评分矩阵
categories: [finance, stock, a-share, serenity, chokepoint]
---

# Serenity 深度数据集成向导

> 用于 Serenity 瓶颈投资法 v2 的深度筛选环节。
> 在插件快速扫描后，对候选股票调用 AKShare + autocli + stock-analysis-team 做全量数据集成。

## 工作流程

### Step 1: 快速扫描 (插件)
运行 chokepoint-screener-v2 插件过滤全市场。输出 Top N 候选。

### Step 2: 逐一深度 enrichment

对每个候选（前 10-20 名），获取以下数据：

#### 2a. 基础 + 基本面 + 行业
调用 stock-analysis-team 的 analysis_data_bridge.py：
- price_technical: 价格/技术指标/趋势
- fundamentals.financial_abstract: 财务摘要（营收/利润/现金流）
- fundamentals.financial_indicators: 财务指标（毛利率/ROE/净利率/负债率等）
- fundamentals.industry_info: 申万行业板块 + 概念板块

#### 2b. 机构持仓 (Layer 5)
调用 AKShare stock_report_fund_hold(symbol="基金持仓", date="20260331")：
- 持有基金家数
- 持股总数、持股市值
- 持股变化（增仓/减仓/新进）
- 持股变动比例%

#### 2c. 十大流通股东 (Layer 5 补充)
调用 AKShare stock_circulate_stock_holder(symbol="股票代码")：
- 股东名称、持股数量、占流通股比例
- 股本性质（国有/境外法人/基金）
- 关注：社保基金/QFII/知名机构新进

#### 2d. 个股资金流向
调用 AKShare stock_individual_fund_flow(stock="代码", market="sh/sz")

### Step 3: 地缘催化 (Layer 4) — autocli 搜索
用 autocli 搜索该股票的新闻：
- autocli google search --query "股票名 出口管制 国产替代" --limit 5
- autocli google search --query "半导体 export control China" --limit 10
- autocli read URL --format md 提取正文

### Step 4: 六层评分标准

| Layer | 数据源 | 满分 | 规则 |
|-------|--------|------|------|
| L1 赛道 | industry_info | 20 | 属半导体/光刻/芯片/AI/国产替代概念=20 |
| L2 不可替代性 | 毛利率 | 20 | >70%=20, >50%=15, >30%=10 |
| L3 龙虾理论 | ROE+营收增率 | 20 | ROE>20%且营收增>20%=20, 其一=10 |
| L4 地缘催化 | autocli新闻 | 20 | 明确正面催化=20, 中性=10, 负面=0 |
| L5 机构验证 | fund_hold | 20 | 新进=20, 增仓=10, 减仓=-10 |
| L6 流动性 | (已含插件) | 已算入总分 | 不重复计分 |

### Step 5: 输出格式

对每个候选输出浓缩 JSON：
```json
{
  "code": "002371",
  "name": "北方华创",
  "scores": { "layer1": 20, "layer2": 15, "layer3": 10, "layer4": 20, "layer5": 10 },
  "total": 75,
  "data": {
    "industry": "半导体设备",
    "concepts": ["国产芯片", "集成电路"],
    "gross_margin": "42.8%",
    "roe": "18.5%",
    "institutional": "增仓 183->209家 (+5.2%)",
    "geopolitical_news": "美国对华半导体设备限制加码，国产替代加速"
  },
  "verdict": "重点挖掘 / 关注 / 观察 / 放弃"
}
```

## 数据源耗时

| 数据 | 获取方式 | 耗时 |
|------|---------|------|
| 价格/量/市值 | StockData 内置 | 秒级 |
| 行业+概念+财务 | analysis_data_bridge | ~3s/股 |
| 基金持仓变动 | AKShare stock_report_fund_hold | ~5s (全市场) |
| 十大流通股东 | AKShare stock_circulate_stock_holder | ~3s/股 |
| 地缘新闻 | autocli google search | ~3s/关键词 |
