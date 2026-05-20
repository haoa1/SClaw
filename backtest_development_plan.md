# 回测系统开发计划（v2）

> 基于现有代码审查（2026-05-20），重新规划升级路线

---

## 📊 已完成的底层

回测系统并非从零开始，以下模块**已就绪**：

| 模块 | 文件 | 说明 |
|------|------|------|
| SQLite 数据库层 | `backend/src/data/local-database.ts` | 完整 schema + CRUD，WAL 模式 |
| 数据管理器 | `backend/src/data/data-manager.ts` | JSON 迁移 / Tushare 按日拉取 / 完整性检查 |
| 数据已迁移 | `backend/data/stock_history.db` | 340MB，含 stock_daily / stock_info / index_daily 表 |
| 基准指数数据 | index_daily 表 | 沪深300 / 创业板指 / 上证指数 / 深证成指 |
| 基本回测引擎 | `backend/src/backtest/backtest-engine.ts` | 再平衡 + 持仓管理 + 基础指标 |
| 回测 API 路由 | `backend/src/routes/backtest.ts` | POST `/api/backtest/run` 等接口 |

---

## 🗺️ 四阶段开发路线

### 阶段一：引擎重构 — SQLite 数据源接入 + 基准对比（约 3-5 天）

**目标：** 让回测引擎从 SQLite 读取数据，而非旧的 JSON DataFetcher；加上基准对比

| # | 任务 | 文件 | 详情 |
|---|------|------|------|
| 1.1 | 创建 `BacktestDataProvider` 接口 | `backend/src/backtest/data-provider.ts` | 定义统一数据接口，支持 LocalDatabase + DataFetcher(旧) 两种实现 |
| 1.2 | 实现 `LocalDBDataProvider` | `backend/src/backtest/data-provider.ts` | 封装 LocalDatabase，提供 getSnapshotAtDate / getKLines / getStockInfo |
| 1.3 | 重构 BacktestEngine 使用 DataProvider | `backend/src/backtest/backtest-engine.ts` | 替换 DataFetcher 依赖 → DataProvider，删除 fetchStockBasic / klineCache 等过期逻辑 |
| 1.4 | 基准对比实现 | `backend/src/backtest/backtest-engine.ts` | 从 index_daily 读取沪深300/创业板指数据，计算 benchmarkReturn / 相对收益 / 超额收益 |
| 1.5 | 扩展回测指标 | `backend/src/backtest/backtest-engine.ts` | 增加 Alpha / Beta / Calmar 比率 / 信息比率 / 最大连续亏损天数 |
| 1.6 | 更新 types.ts | `backend/src/types/index.ts` | BacktestSummary 增加新指标字段 |
| 1.7 | 回测测试脚本 | `backend/test-backtest.mjs` | 更新脚本测试新引擎，验证基准对比 |

**验证：** `node backend/test-backtest.mjs` 跑通，输出含基准对比 + Alpha/Beta

---

### 阶段二：引擎增强 — 真实交易模拟（约 4-6 天）

**目标：** 接近实盘的回测质量，消除"收盘价买入""忽略停牌"等理想化假设

| # | 任务 | 文件 | 详情 |
|---|------|------|------|
| 2.1 | 复权数据处理 | `backend/src/backtest/adjustment.ts` | 从 Tushare 获取复权因子，实现前复权 / 后复权，K线数据统一转为后复权计算 |
| 2.2 | 涨跌停检查 | `backend/src/backtest/trading-rules.ts` | 按 market 判断涨停/跌停价（SH: ±10%, SZ主板: ±10%, 创业板/科创板: ±20%），再平衡日不可买入涨停股、不可卖出跌停股 |
| 2.3 | 停牌处理 | `backend/src/backtest/trading-rules.ts` | 停牌日不能交易；持仓股停牌期间按停牌前收盘价估值，不产生交易信号 |
| 2.4 | 滑点模型 | `backend/src/backtest/slippage.ts` | 固定滑点（默认 0.1%）+ 成交量比例滑点（按订单量占日成交量比例递增）|
| 2.5 | 成交量约束 | `backend/src/backtest/slippage.ts` | 单笔订单不超过日成交量的一定比例（默认 20%），超限部分按比例成交 |
| 2.6 | 止损止盈 | `backend/src/backtest/backtest-engine.ts` | 在每日估值环中检查：持仓亏损超过止损线（默认 -15%）或盈利超过止盈线（默认 +50%）时触发卖出 |
| 2.7 | 多时间维度分析 | `backend/src/backtest/backtest-engine.ts` | 按年/季/月拆分收益，输出细分表格 |

**验证：** 运行 3 个策略的回测，日志中能看到：涨停未买入记录、停牌持仓估值、止损失败记录

---

### 阶段三：参数优化器 + Walk-forward 验证（约 3-5 天）

**目标：** 用科学方法寻找最优参数、验证策略稳健性

| # | 任务 | 文件 | 详情 |
|---|------|------|------|
| 3.1 | 网格搜索引擎 | `backend/src/backtest/optimizer.ts` | 对策略参数进行全排列组合，跑回测，输出所有结果 + 排名 |
| 3.2 | 参数约束声明 | `backend/src/types/index.ts` | StrategyParam 增加 `optimizable: boolean` 字段，标记可优化参数及其范围 |
| 3.3 | Walk-forward 分析 | `backend/src/backtest/walk-forward.ts` | 滚动窗口：训练期(12月) → 验证期(3月)，滑动步长 3 月，输出各窗口收益/回撤稳定性 |
| 3.4 | 热力图输出 | `backend/src/backtest/optimizer.ts` | 2 参数优化的热力图 JSON 数据（供前端渲染） |
| 3.5 | 优化结果持久化 | `backend/src/data/local-database.ts` | 新增 optimization_results 表，保存最佳参数组合 |

**验证：** 对 ai-short-term 策略做 MA 周期优化（5/10/20/30/60），输出热力图

---

### 阶段四：前端回测 UI（约 5-7 天）

**目标：** 直接在浏览器配置回测、查看结果曲线

| # | 任务 | 文件 | 详情 |
|---|------|------|------|
| 4.1 | 回测配置页组件 | `frontend/src/pages/BacktestConfig.tsx` | 选择日期范围 / 策略 / 再平衡频率 / 初始资金 / 持仓上限 / 佣金 / 止损止盈线 |
| 4.2 | 策略多选 + 权重分配 | `frontend/src/components/BacktestStrategySelector.tsx` | 拖拽多选策略，可配置组合权重 |
| 4.3 | 净值曲线图 | `frontend/src/components/BacktestEquityChart.tsx` | 使用 ECharts / Recharts 绘制：策略净值 vs 基准净值 vs 回撤曲线 |
| 4.4 | 交易明细表 | `frontend/src/components/BacktestTradeTable.tsx` | 按日期排序，展示所有买入卖出记录，支持筛选/搜索 |
| 4.5 | 指标总览面板 | `frontend/src/components/BacktestMetricsPanel.tsx` | 卡片式展示：总收益 / 年化 / 夏普 / 最大回撤 / Alpha / Beta / Calmar 等 |
| 4.6 | 多策略对比模式 | `frontend/src/components/BacktestComparison.tsx` | 同时运行多个策略，叠加强度对比曲线 |
| 4.7 | 路由注册 | `frontend/src/App.tsx` | 添加 /backtest 路由 |
| 4.8 | API 扩展 | `backend/src/routes/backtest.ts` | 新增 SSE 流式回测（长任务友好）+ 历史回测结果存储/加载 |

**验证：** 打开 `http://localhost:5173/backtest` → 选择策略 → 点击运行 → 看到净值曲线和交易明细

---

## ⏱️ 时间线和优先级

```
阶段一 (3-5天)  ████████░░░░░░░░░░  最优先 — 核心瓶颈
  引擎重构 + SQLite + 基准对比

阶段二 (4-6天)  ░░░░████████░░░░░░  中优先 — 回测真实性
  涨跌停 / 停牌 / 滑点 / 止损

阶段三 (3-5天)  ░░░░░░░░██████░░░░  中优先 — 策略优化
  网格搜索 + Walk-forward

阶段四 (5-7天)  ░░░░░░░░░░░░██████  可并行 — 可视化
  前端回测 UI

总预估: 15-23 天
```

---

## 🧩 关键设计决策

### 数据流向（阶段一后）
```
回测请求
  │
  ▼
BacktestEngine.run(config)
  │
  ├─ LocalDBDataProvider.getSnapshotAtDate(date)
  │     └─ SQLite: stock_daily WHERE date = ?
  │
  ├─ StrategyEngine.execute(stocks, strategies)
  │     └─ 23 个策略插件，与筛选系统共享
  │
  ├─ BenchmarkDataProvider.getIndexKLines(code, start, end)
  │     └─ SQLite: index_daily WHERE code = ?
  │
  └─ 输出 BacktestResult (含 equityCurve.benchmark)
```

### SSE 流式回测（阶段四）
回测跑 23 个策略 × 3 年数据可能耗时 30s+，建议加 SSE 流式进度：
```
Event: progress  → { currentStep: 3/12, message: "Rebalancing 2025-03..." }
Event: period    → { date: "2025-03-01", holdings: [...], trades: [...] }
Event: complete  → { summary: BacktestSummary, equityCurve: [...] }
```

---

## 🚀 立即可以开始的步骤

**阶段一第 1 步：** 创建 `BacktestDataProvider` 接口，成本最低、收益最高

```typescript
// backend/src/backtest/data-provider.ts
export interface BacktestDataProvider {
  getSnapshotAtDate(date: string): Promise<StockData[]>;
  getStockKLines(code: string, startDate: string, endDate: string): Promise<KLineData[]>;
  getStockInfo(code: string): Promise<{ name: string; market: 'SH' | 'SZ' | 'BJ' } | undefined>;
  getIndexKLines(code: string, startDate: string, endDate: string): Promise<{ date: string; close: number }[]>;
}
```

实现 `LocalDBDataProvider` 封装 LocalDatabase，然后修改 BacktestEngine 的构造函数接收 DataProvider 替代 DataFetcher+TushareHistoricalDataFetcher。

---

**是否开始阶段一？**
