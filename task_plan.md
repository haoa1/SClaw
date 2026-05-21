# SClaw (Stock Screener) — Task Plan

## 项目概述
全栈 TypeScript 插件化SClaw，支持动态加载选股策略插件，网页界面操作。

## 技术栈
- **前端**: React + Vite + TypeScript + TailwindCSS
- **后端**: Node.js + Express + TypeScript
- **插件系统**: 动态扫描 + Node `require()` 热加载
- **数据源**: 东方财富 A 股免费数据源

## 架构

```
stock-screener/
├── frontend/              # React + Vite 前端 ✅
│   ├── src/
│   │   ├── components/    # PluginPanel, StrategyConfig, StrategyParamInput, ResultsTable, LoadingSpinner
│   │   ├── types/         # 共享类型定义
│   │   ├── api.ts         # API 客户端
│   │   └── App.tsx        # 主应用（离线检测、插件加载、选股执行、结果展示）
│   └── package.json
├── backend/               # Express API 服务 ✅
│   ├── src/
│   │   ├── plugin-system/ # PluginManager — 扫描/加载/热重载/校验
│   │   ├── strategies/    # StrategyEngine — 多策略并行执行
│   │   ├── data/          # DataFetcher — 东方财富 API + 1min 缓存
│   │   ├── routes/        # RESTful API（插件/策略/选股/数据/K线）
│   │   └── types/         # 类型定义
│   └── package.json
├── plugins/               # 插件目录
│   └── example-plugin/    # 示例插件：低PE、放量上涨、破净 3个策略
├── task_plan.md           # 本文件
└── README.md              # (待完成)
```

## 插件接口

```typescript
interface StockScreenerPlugin {
  id: string; name: string; version: string; description: string;
  strategies: Strategy[];
}
interface Strategy {
  id: string; name: string; description: string;
  params: StrategyParam[];    // 可配置参数（前端自动渲染）
  execute: (data: StockData[], params) => FilterResult[];
}
```

## 完成状态

### Phase 1: 后端核心 ✅ 已完成
- ✅ 初始化项目结构
- ✅ Express + TypeScript 框架
- ✅ 东方财富数据获取层（全市场 + K线）
- ✅ 插件系统：目录扫描、动态加载、热重载（chokidar-like fs.watch）
- ✅ 策略执行引擎
- ✅ RESTful API（GET /api/plugins, /api/strategies, POST /api/screen, POST /api/data/refresh, GET /api/stock/:code/kline）

### Phase 2: 前端界面 ✅ 已完成
- ✅ React + Vite + TailwindCSS 初始化
- ✅ 离线检测 / 后端连接状态
- ✅ 插件管理面板（展开/折叠、添加/移除策略）
- ✅ 策略配置页面（参数表单自动生成）
- ✅ 选股结果表格（评分着色、指标格式化、信号标签）
- ✅ 统计栏（总股票、匹配数、命中率）
- ✅ CSV 导出
- ✅ Vite proxy -> 后端 :3001

### Phase 3: 示例插件 ✅ 已完成
- ✅ example-plugin 含 3 个策略：
  - **低市盈率选股** (low-pe)：PE < N，市值 > M
  - **放量上涨选股** (volume-surge)：涨幅 > N%，成交量 > M
  - **破净选股** (below-book-value)：PB < 1，可选要求 PE 为正

### Phase 4: 增强功能 ⏳ 待开始
- [ ] 选股结果历史记录
- [ ] 策略回测框架
- [ ] 定时自动选股
- [ ] 股票详情弹窗（K线图等）
- [ ] README + 启动文档

## 启动方式

```bash
# 后端
cd backend && npm run dev

# 前端
cd frontend && npm run dev

# 访问 http://localhost:5173
```
