<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-5.4+-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-18.3-61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Tushare_Pro-API-FF6B6B" alt="Tushare Pro">
</p>

<h1 align="center">🦀 SClaw — AI-Powered Stock Screener / AI 选股系统</h1>

<p align="center">
  <strong>Multi-strategy stock screening with AI agent, backtesting engine, and scheduled alerts.</strong>
  <br>
  <em>Plugin-based architecture — write your own strategies, plug them in, run them.</em>
  <br>
  <strong>多策略选股 + AI 智能体 + 回测引擎 + 定时提醒</strong>
  <br>
  <em>插件化架构 — 写好自己的策略，丢进 plugins/ 即可运行</em>
</p>

---

> ⚠️ **Disclaimer / 免责声明**
>
> **English:** This software is for educational and research purposes only. Stock screening and backtesting results do not guarantee future performance. Always conduct your own due diligence before making investment decisions.
>
> **中文:** 本软件仅供学习和研究用途。选股和回测结果不保证未来收益。投资决策前请自行充分调研。

---

## 📖 Table of Contents / 目录

- [Features / 功能特性](#features--功能特性)
- [Architecture / 架构](#architecture--架构)
- [Strategy Plugins / 策略插件](#strategy-plugins--策略插件)
- [Quick Start / 快速开始](#quick-start--快速开始)
- [Deployment / 部署指南](#deployment--部署指南)
- [API Reference / API 参考](#api-reference--api-参考)
- [Data Sources / 数据源](#data-sources--数据源)
- [AI Agent / AI 智能体](#ai-agent--ai-智能体)
- [Testing / 测试](#testing--测试)
- [License / 许可证](#license--许可证)

---

## 🚀 Features / 功能特性

### 📊 Multi-Strategy Screening / 多策略选股

- **Plugin system / 插件系统** — strategies are self-contained plugins. Drop a new folder in `plugins/`, and it's ready. / 每个策略是一个独立插件，放入 `plugins/` 目录即可使用。
- **23+ built-in strategies / 内置 23+ 策略** — day trading, short-term momentum, volume surge, MA deviation, oscillation hunting, and more. / 涵盖做 T、短线、放量、均线偏离、震荡市等场景。
- **Multi-strategy scoring / 多策略评分** — combine strategies with score merging or union mode. / 支持评分合并和并集模式，多策略命中才高亮。
- **Real-time filtering / 实时过滤** — filter by market (SH/SZ/BJ), customize parameters for each strategy. / 按市场板块筛选，每个策略参数可调。

### 🤖 AI Agent / AI 智能体

- **Conversational interface / 对话式交互** — chat with AI to screen stocks, analyze results, manage strategies. / 与 AI 对话即可完成选股、分析、策略管理。
- **Tool-calling capabilities / 工具调用** — stock info, risk assessment, strategy generation & optimization, file ops, memory recall. / 股票查询、风险评估、策略生成与优化、文件操作、记忆召回。
- **Thinking mode / 深度思考** — DeepSeek R1 support for complex multi-step analysis. / 支持 DeepSeek R1 深度思考模式。
- **Per-user session / 用户隔离** — each user has independent session and memory. / 每个用户独立会话和记忆。

### 📈 Backtesting Engine / 回测引擎

- **Historical simulation / 历史回测** — simulate strategy performance over any date range. / 任意日期范围的策略表现模拟。
- **Configurable portfolio / 可配投资组合** — initial capital, max positions, rebalance frequency, commission, slippage models. / 初始资金、最大持仓、调仓频率、佣金、滑点全可配。
- **Performance metrics / 绩效指标** — total return, annualized return, max drawdown, Sharpe ratio, win rate, profit factor, Calmar ratio, information ratio, alpha, beta. / 总收益、年化收益、最大回撤、夏普比率等 11 项指标。
- **Tech tree analysis / 技术树分析** — 5×3 regime heatmap + 12-month seasonality. / 5×3 市场状态热力图 + 12 月季节性分析。

### ⏰ Scheduled Screening / 定时选股

- **Cron-based / Cron 调度** — scheduled screen jobs with email delivery. / 定时执行选股任务并通过邮件发送报告。
- **Per-user schedules / 独立调度** — each user configures their own. / 每个用户独立配置。

### 🛡️ Authentication / 认证系统

- **Session-based auth / Session 认证** — admin/user roles. / 管理员/普通用户角色。
- **Persistent storage / 持久化** — config, screen history, operation logs. / 配置、选股历史、操作日志持久化。

### 🎨 Modern UI / 现代化界面

- **React 18 + TypeScript + Tailwind CSS + Vite** with dark theme. / 暗色主题。
- **Interactive results table / 交互式结果表** — with sorting, filtering, export. / 支持排序筛选。
- **Backtest charts / 回测图表** — equity curves via Recharts. / 权益曲线图。
- **AI chat panel / AI 聊天面板** — markdown rendering + streaming. / Markdown 渲染 + 流式输出。

---

## 🧩 Architecture / 架构

```
sclaw/
├── backend/                    # Express.js + TypeScript backend / 后端
│   └── src/
│       ├── agent/              # AI agent (LLM, tool execution, memory, compact)
│       ├── backtest/           # Backtesting engine & data provider / 回测引擎
│       ├── data/               # Data fetchers (East Money, Tushare Pro) / 数据获取
│       ├── email.ts            # SMTP email sender / 邮件发送
│       ├── plugin-system/      # Plugin manager (hot-reload via chokidar) / 插件热加载
│       ├── routes/             # REST API routes / API 路由
│       │   ├── api.ts          #   Screen & plugin endpoints / 选股与插件
│       │   ├── auth.ts         #   Authentication / 认证
│       │   ├── backtest.ts     #   Backtesting / 回测
│       │   ├── chat.ts         #   AI chat / AI 聊天
│       │   ├── scheduler.ts    #   Scheduled tasks / 定时任务
│       │   ├── data-sync.ts    #   Data synchronization / 数据同步
│       │   └── user.ts         #   User management / 用户管理
│       ├── scheduler.ts        # Cron-based task scheduler / Cron 调度器
│       ├── strategies/         # Strategy execution engine / 策略执行引擎
│       ├── tools/              # AI tool registry (10+ tools) / AI 工具注册
│       │   ├── file-tools.ts
│       │   ├── stock-info.ts
│       │   ├── strategy-validator.ts
│       │   ├── risk-assessment.ts
│       │   ├── strategy-generator.ts
│       │   ├── strategy-optimize.ts
│       │   ├── frontend-actions.ts
│       │   ├── memory-recall.ts
│       │   └── schedule-tools.ts
│       ├── types/              # Shared TypeScript types / 共享类型定义
│       └── user-store.ts       # Per-user persistent storage / 用户存储
├── frontend/                   # React + Vite + Tailwind frontend / 前端
│   └── src/
│       ├── components/         # UI components / UI 组件
│       │   ├── BacktestPanel.tsx   # Backtest UI / 回测面板
│       │   ├── ChatPanel.tsx       # AI chat UI / AI 聊天
│       │   ├── PluginPanel.tsx     # Plugin browser / 插件浏览
│       │   ├── ResultsTable.tsx    # Screening results / 选股结果表
│       │   ├── StrategyConfig.tsx  # Strategy configuration / 策略配置
│       │   └── ...
│       ├── api.ts              # API client / API 客户端
│       └── types/              # Frontend types / 前端类型
├── plugins/                    # Strategy plugins (hot-loadable) / 选股策略插件
│   ├── ai-day-trade/           # AI day trading / AI做T
│   ├── ai-short-term/          # AI short-term / AI短线
│   ├── ai-volume-surge/        # Volume surge / 放量上涨
│   ├── oscillation-hunter/     # Oscillation hunting / 震荡市猎手
│   ├── ma-deviation-t/         # MA deviation intraday / 均线偏离做T
│   ├── example-plugin/         # Reference plugin / 参考插件
│   └── ...
├── data/                       # Runtime data / 运行时数据
│   ├── chat/                   # Chat histories
│   └── users/                  # User data
└── deploy.sh                   # One-click deploy script / 一键部署脚本
```

---

## 🔌 Strategy Plugins / 策略插件

Strategies are loaded from `plugins/`. Each plugin is a folder with `index.ts` exporting a `StockScreenerPlugin`. No config — just drop it in and restart.

策略存放在 `plugins/` 目录，每个插件是一个文件夹，内含 `index.ts` 导出 `StockScreenerPlugin` 对象。无需配置，放入即用。

### Built-in Strategies / 内置策略一览

| Plugin / 插件名 | Type / 类型 | Description / 描述 |
|----------------|-------------|-------------------|
| `ai-day-trade` | Day Trade / 做T | AI-powered day trading picks / AI 做 T 精选 |
| `ai-daytrade-pick` | Day Trade / 做T | Alternative day trade model / AI 做 T 精选 (备选模型) |
| `ai-daytrade-v1` | Day Trade / 做T | Day trade v1 enhanced / AI做T精选V1 |
| `ai-daytrade-v2` | Day Trade / 做T | Day trade v2 enhanced / AI做T精选V2 |
| `ai-short-term` | Short Term / 短线 | Short-term momentum / AI短线精选 |
| `ai-short-term-v2` | Short Term / 短线 | Enhanced short-term momentum / AI短线精选V2 |
| `ai-volume-surge` | Volume / 放量 | Volume surge with correction / AI放量上涨修正版 |
| `oscillation-hunter` | Special / 震荡 | Oscillation market hunter / 震荡市猎手 |
| `ma-deviation-t` | Day Trade / 做T | MA deviation intraday / 分时均线偏离做T |
| `simple-volume-surge` | Volume / 放量 | Simple volume ratio / 简易放量上涨 |
| `debug-fields` | Debug / 调试 | Field debugging tool / 字段调试工具 |
| `example-plugin` | Demo / 示例 | Reference plugin (PE/PB/volume) / 参考插件 |

> **Create your own / 创建自己的策略**: Copy `plugins/example-plugin/` and modify the logic. The plugin system auto-discovers new additions. / 复制 `plugins/example-plugin/` 并修改逻辑即可，系统自动发现。

---

## 🛠️ Quick Start / 快速开始

### Prerequisites / 环境要求

- **Node.js 22+** (for Tushare Pro integration)
- **npm 10+**
- **Tushare Pro token** — [free tier available / 免费注册](https://tushare.pro)

### Installation / 安装

```bash
# Clone the repo / 克隆仓库
git clone https://github.com/your-username/sclaw.git
cd sclaw

# Install backend / 安装后端
cd backend
cp .env.example .env   # Edit TUSHARE_TOKEN / 编辑 TUSHARE_TOKEN
npm install

# Install frontend / 安装前端
cd ../frontend
npm install
```

### Configuration / 配置

Create `backend/.env` / 创建 `backend/.env`:

```env
# Required / 必填
TUSHARE_TOKEN=your_tushare_pro_token

# Optional / 可选 (for AI agent)
DEEPSEEK_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat

# Optional / 可选 (for email reports)
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_USER=your_email@163.com
SMTP_PASS=your_smtp_password

# Backend port (default: 3001)
PORT=3001
```

### Development / 开发模式

```bash
# Terminal 1: Backend / 启动后端 (auto-reload via tsx watch)
cd backend && npm run dev

# Terminal 2: Frontend / 启动前端 (Vite dev server)
cd frontend && npm run dev
```

Open `http://localhost:5173` in your browser. / 打开浏览器访问 `http://localhost:5173`。

### Production Build / 生产构建

```bash
# Backend / 构建后端
cd backend && npm run build

# Frontend / 构建前端
cd frontend && npm run build    # Output: frontend/dist/
```

---

## 📦 Deployment / 部署指南

This section covers deployment scenarios from local dev to production servers.

本节覆盖从本地开发到生产服务器的完整部署方案。

---

### Option A: Local PM2 Deployment / 本地 PM2 部署

PM2 keeps your app running persistently, auto-restarts on crash, and starts on boot.

PM2 保证进程持续运行、崩溃自动重启、开机自启。

```bash
# Install PM2 / 安装 PM2
npm install -g pm2

# Build / 先构建
cd /path/to/sclaw/backend && npm run build
cd /path/to/sclaw/frontend && npm run build

# Start backend with PM2 / 使用 PM2 启动后端
pm2 start dist/index.js --name sclaw-backend

# Save PM2 process list / 保存进程列表
pm2 save

# (Optional) Auto-start on boot / 设置开机自启
pm2 startup
```

> **Frontend production mode / 前端生产模式**: Serve `frontend/dist/` with Nginx (see Option C). Or use a simple Node.js static server. / 用 Nginx 代理前端静态文件，见下方 Option C。

---

### Option B: Alibaba Cloud ECS Deployment / 阿里云 ECS 部署

This guide assumes a fresh CentOS/Ubuntu server.
本指南假设全新 CentOS/Ubuntu 服务器。

#### 1. Initial Setup / 初始设置

```bash
# Update system / 更新系统
apt update && apt upgrade -y    # Ubuntu
# yum update -y                 # CentOS

# Install Node.js 22 / 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Verify / 验证
node --version   # Should be >= 22 / 应 >= 22
npm --version    # Should be >= 10 / 应 >= 10

# Install PM2 / 安装 PM2
npm install -g pm2

# Install Nginx / 安装 Nginx
apt install -y nginx
```

#### 2. Deploy Code / 部署代码

```bash
# Option 1: Git clone / 方式一：Git 克隆
git clone https://github.com/your-username/sclaw.git /root/sclaw
cd /root/sclaw

# Option 2: Upload via SCP / 方式二：SCP 上传
# From your local machine / 从本机执行:
# scp -r /path/to/sclaw root@your_server_ip:/root/sclaw

# Install dependencies / 安装依赖
cd /root/sclaw/backend && npm install
cd /root/sclaw/frontend && npm install

# Create .env / 创建环境变量
cp /root/sclaw/backend/.env.example /root/sclaw/backend/.env
# Edit TUSHARE_TOKEN, DEEPSEEK_API_KEY, etc. / 编辑配置
vi /root/sclaw/backend/.env

# Build / 构建
cd /root/sclaw/backend && npm run build
cd /root/sclaw/frontend && npm run build
```

#### 3. Start with PM2 / PM2 启动

```bash
cd /root/sclaw/backend

# Start backend / 启动后端
pm2 start dist/index.js --name sclaw-backend

# Start deploy script (if used) / 启动部署脚本（如果用 deploy.sh）
# pm2 start bash --name sclaw-deploy -- -c "cd /root/sclaw && bash deploy.sh"

# Save & enable auto-start / 保存并启用开机自启
pm2 save
pm2 startup
```

#### 4. Nginx Reverse Proxy / Nginx 反向代理

<details>
<summary>Click to expand Nginx config / 点击展开 Nginx 配置</summary>

```nginx
# /etc/nginx/sites-available/sclaw

server {
    listen 80;
    server_name your-domain.com;  # Your domain or IP / 域名或 IP

    # Frontend static files / 前端静态文件
    root /root/sclaw/frontend/dist;
    index index.html;

    # API proxy / API 反向代理
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;

        # SSE support (for streaming chat) / SSE 支持（流式聊天）
        proxy_set_header X-Accel-Buffering no;
        proxy_buffering off;
    }

    # SPA fallback / SPA 路由回退
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable and start / 启用并启动:

```bash
ln -s /etc/nginx/sites-available/sclaw /etc/nginx/sites-enabled/
nginx -t            # Test config / 测试配置
systemctl restart nginx
```

</details>

#### 5. HTTPS with Let's Encrypt / 配置 HTTPS

```bash
# Install certbot / 安装 certbot
apt install -y certbot python3-certbot-nginx

# Get certificate / 获取证书
certbot --nginx -d your-domain.com

# Auto-renew / 自动续期
certbot renew --dry-run
```

#### 6. Firewall Configuration / 防火墙配置

```bash
# Allow HTTP/HTTPS / 允许 HTTP/HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# (Optional) Allow SSH / 允许 SSH
ufw allow 22/tcp

# Enable firewall / 启用防火墙
ufw enable
```

#### 7. Monitoring / 监控

```bash
# PM2 monitor / PM2 监控
pm2 monit

# View logs / 查看日志
pm2 logs sclaw-backend

# Restart if needed / 重启
pm2 restart sclaw-backend
```

---

### Option C: Docker Deployment / Docker 部署

> Note: Dockerfile not included yet. Coming soon.
> 注意：Dockerfile 暂未提供，即将支持。

For now, use PM2 + Nginx as described above.
目前请使用 PM2 + Nginx 方式部署。

---

### Option D: One-Click Script / 一键部署脚本

SClaw includes `deploy.sh` for quick deployment on fresh servers.

SClaw 内置了 `deploy.sh` 一键部署脚本，适合全新服务器。

```bash
# Upload the project to your server / 上传项目到服务器
# scp -r sclaw root@your_server_ip:/root/

# SSH into server / SSH 登录服务器
ssh root@your_server_ip

# Run deploy script / 运行部署脚本
cd /root/sclaw
bash deploy.sh
```

The script handles / 脚本自动处理:
- Node.js installation / 安装 Node.js
- Directory structure creation / 创建目录结构
- Source code deployment / 部署源代码
- PM2 process management / PM2 进程管理

> **Note / 注意**: `deploy.sh` embeds all source code inline. It's designed for quick re-deployment on servers without git access. For normal development, use the `backend/` + `frontend/` structure with git. / `deploy.sh` 将源码内嵌在脚本中，适合服务器无法连接 Git 的场景。正常开发请使用 `backend/` + `frontend/` 目录结构配合 Git。

---

## 📡 API Reference / API 参考

### Screening / 选股

| Method | Endpoint | Description / 说明 |
|--------|----------|-------------------|
| GET | `/api/plugins` | List all plugins & strategies / 列出所有插件和策略 |
| GET | `/api/strategies` | List all available strategies / 列出所有可用策略 |
| POST | `/api/screen` | Execute stock screening / 执行选股 |
| POST | `/api/screen/stream` | Streaming screen results (SSE) / 流式返回选股结果 |

### Backtesting / 回测

| Method | Endpoint | Description / 说明 |
|--------|----------|-------------------|
| POST | `/api/backtest/run` | Run backtest / 运行回测 |
| POST | `/api/backtest/cache` | Clear backtest cache / 清除回测缓存 |

### AI Agent / AI 智能体

| Method | Endpoint | Description / 说明 |
|--------|----------|-------------------|
| POST | `/api/chat/send` | Send message to AI / 发送消息给 AI |
| GET | `/api/chat/stream` | Stream AI response (SSE) / 流式获取 AI 回复 |
| POST | `/api/chat/clear` | Clear current session / 清空当前会话 |
| GET | `/api/chat/history` | Get chat history / 获取聊天记录 |

### Scheduler / 定时任务

| Method | Endpoint | Description / 说明 |
|--------|----------|-------------------|
| GET | `/api/schedule` | List scheduled tasks / 列出定时任务 |
| POST | `/api/schedule` | Create scheduled task / 创建定时任务 |
| PUT | `/api/schedule/:id` | Update scheduled task / 更新定时任务 |
| DELETE | `/api/schedule/:id` | Delete scheduled task / 删除定时任务 |

### Data Sync / 数据同步

| Method | Endpoint | Description / 说明 |
|--------|----------|-------------------|
| GET | `/api/data/status` | Data sync status / 数据同步状态 |
| POST | `/api/data/sync` | Trigger data sync / 触发数据同步 |
| POST | `/api/data/sync/stock-names` | Sync stock names / 同步股票名称 |
| POST | `/api/data/sync/benchmarks` | Sync benchmarks / 同步指数 |
| POST | `/api/data/cleanup` | Clean stale data / 清理过期数据 |

### User & Auth / 用户与认证

| Method | Endpoint | Description / 说明 |
|--------|----------|-------------------|
| POST | `/api/auth/login` | User login / 用户登录 |
| POST | `/api/auth/logout` | Logout / 登出 |
| GET | `/api/user/me` | Current user info / 当前用户信息 |
| PUT | `/api/user/config` | Update user config / 更新用户配置 |
| GET | `/api/user/screens` | Screen history / 选股历史 |
| GET | `/api/user/logs` | Operation logs / 操作日志 |

---

## 🗄️ Data Sources / 数据源

### Tushare Pro (Primary / 主要数据源)

- **Daily K-line / 日K线数据** — OHLCV for ~5000 A-share stocks since 2020 / 约 5000 只 A 股日线数据
- **Stock names / 股票名称** — full listing with market codes / 完整股票列表
- **Benchmark indexes / 基准指数** — CSI 300, CSI 500, CSI 1000, ChiNext / 沪深300、中证500、中证1000、创业板指
- **Efficient query / 高效查询** — per-trading-day batch strategy (1 call = all stocks for 1 day) / 按交易日批量查询，一天一只 API 调用

### East Money / 东方财富 (Supplemental / 补充)

- **Supplementary historical data / 补充历史数据** — for fallback and verification / 用于回退和验证

---

## 🧠 AI Agent / AI 智能体

The built-in AI agent (powered by DeepSeek) provides natural language control:
内置 AI 智能体（基于 DeepSeek）提供了自然语言控制能力：

| Capability / 能力 | Description / 说明 |
|-------------------|-------------------|
| **Screen stocks / 选股** | Select and configure strategies by conversation / 通过对话选择和配置选股策略 |
| **Analyze results / 分析结果** | Natural language analysis of screening results / 自然语言分析选股结果 |
| **Generate strategies / 生成策略** | Create new strategies from descriptions / 根据描述生成新策略 |
| **Optimize parameters / 优化参数** | Backtest-based parameter optimization / 基于回测的参数优化 |
| **Risk assessment / 风险评估** | Risk evaluation for stocks or portfolios / 个股或组合风险评估 |
| **Schedule reports / 定时报告** | Set up cron-based email reports / 设置定时邮件报告 |
| **Memory recall / 记忆召回** | Recall past conversations across sessions / 跨会话回忆历史对话 |

### Tool Categories / 工具分类

- **File ops / 文件操作** — read, write, edit, glob, grep
- **Stock info / 股票查询** — search, detail, k-line, market overview
- **Strategy validation / 策略验证** — list, run, validate
- **Risk assessment / 风险评估** — portfolio analysis, concentration, correlation
- **Strategy generation / 策略生成** — create from description
- **Strategy optimization / 策略优化** — backtest-driven parameter tuning
- **Frontend actions / 前端操作** — trigger screening from chat
- **Memory recall / 记忆召回** — search past conversations
- **Schedule management / 调度管理** — create/update/delete scheduled tasks

---

## 🧪 Testing / 测试

```bash
# Backend unit tests / 后端单元测试 (Vitest)
cd backend && npm test

# Frontend E2E tests / 前端 E2E 测试 (Playwright)
cd frontend && npm run test:e2e

# Watch mode / 监听模式
cd backend && npm run test:watch
```

---

## 📄 License / 许可证

Distributed under the **Apache License 2.0**. See `LICENSE` for details.

基于 **Apache License 2.0** 发布。详见 `LICENSE` 文件。

---

<p align="center">
  Built with TypeScript, React, Express, and ❤️
  <br>
  Built by <strong>Jack</strong>
  <br>
  <em>Not financial advice. Trade responsibly.</em>
  <br>
  <em>本工具不构成投资建议。请理性交易。</em>
</p>
