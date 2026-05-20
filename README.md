<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-5.4+-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-18.3-61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Tushare_Pro-API-FF6B6B" alt="Tushare Pro">
</p>

<h1 align="center">🦀 SClaw — AI-Powered Stock Screener</h1>


<p align="center">
  <strong>Multi-strategy stock screening with AI agent, backtesting engine, and scheduled alerts.</strong>
  <br>
  <em>Plugin-based architecture — write your own strategies, plug them in, run them.</em>
  <br>

</p>


> ⚠️ **Disclaimer**

> **English:** This software is for educational and research purposes only. Stock screening and backtesting results do not guarantee future performance. Always conduct your own due diligence before making investment decisions.


## 📖 Table of Contents


- [Features](#features--功能特性)

- [Architecture](#architecture--架构)

- [Strategy Plugins](#strategy-plugins--策略插件)

- [Quick Start](#quick-start--快速开始)

- [Deployment](#deployment--部署指南)

- [API Reference](#api-reference--api-参考)

- [Data Sources](#data-sources--数据源)

- [AI Agent](#ai-agent--ai-智能体)

- [Testing](#testing--测试)

- [License](#license--许可证)


## 🚀 Features


### 📊 Multi-Strategy Screening


- **Plugin system** — strategies are self-contained plugins. Drop a new folder in `plugins/`, and it's ready.

- **23+ built-in strategies** — day trading, short-term momentum, volume surge, MA deviation, oscillation hunting, and more.

- **Multi-strategy scoring** — combine strategies with score merging or union mode.

- **Real-time filtering** — filter by market (SH/SZ/BJ), customize parameters for each strategy.


### 🤖 AI Agent


- **Conversational interface** — chat with AI to screen stocks, analyze results, manage strategies.

- **Tool-calling capabilities** — stock info, risk assessment, strategy generation & optimization, file ops, memory recall.

- **Thinking mode** — DeepSeek R1 support for complex multi-step analysis.

- **Per-user session** — each user has independent session and memory.


### 📈 Backtesting Engine


- **Historical simulation** — simulate strategy performance over any date range.

- **Configurable portfolio** — initial capital, max positions, rebalance frequency, commission, slippage models.

- **Performance metrics** — total return, annualized return, max drawdown, Sharpe ratio, win rate, profit factor, Calmar ratio, information ratio, alpha, beta.

- **Tech tree analysis** — 5×3 regime heatmap + 12-month seasonality.


### ⏰ Scheduled Screening


- **Cron-based** — scheduled screen jobs with email delivery.

- **Per-user schedules** — each user configures their own.


### 🛡️ Authentication


- **Session-based auth** — admin/user roles.

- **Persistent storage** — config, screen history, operation logs.


### 🎨 Modern UI


- **React 18 + TypeScript + Tailwind CSS + Vite** with dark theme.

- **Interactive results table** — with sorting, filtering, export.

- **Backtest charts** — equity curves via Recharts.

- **AI chat panel** — markdown rendering + streaming.


## 🧩 Architecture


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


## 🔌 Strategy Plugins


Strategies are loaded from `plugins/`. Each plugin is a folder with `index.ts` exporting a `StockScreenerPlugin`. No config — just drop it in and restart.




### Built-in Strategies


| Plugin | Type | Description |


| `ai-day-trade` | Day Trade | AI-powered day trading picks |

| `ai-daytrade-pick` | Day Trade | Alternative day trade model |

| `ai-daytrade-v1` | Day Trade | Day trade v1 enhanced |

| `ai-daytrade-v2` | Day Trade | Day trade v2 enhanced |

| `ai-short-term` | Short Term | Short-term momentum |

| `ai-short-term-v2` | Short Term | Enhanced short-term momentum |

| `ai-volume-surge` | Volume | Volume surge with correction |

| `oscillation-hunter` | Special | Oscillation market hunter |

| `ma-deviation-t` | Day Trade | MA deviation intraday |

| `simple-volume-surge` | Volume | Simple volume ratio |

| `debug-fields` | Debug | Field debugging tool |

| `example-plugin` | Demo | Reference plugin (PE |


> **Create your own**: Copy `plugins/example-plugin/` and modify the logic. The plugin system auto-discovers new additions.


## 🛠️ Quick Start


### Prerequisites


- **Node.js 22+** (for Tushare Pro integration)
- **npm 10+**
- **Tushare Pro token** — [free tier available

### Installation


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


### Configuration


Create `backend/.env`

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


### Development


```bash

# Terminal 1: Backend / 启动后端 (auto-reload via tsx watch)

cd backend && npm run dev


# Terminal 2: Frontend / 启动前端 (Vite dev server)

cd frontend && npm run dev

```


Open `http://localhost:5173` in your browser.

### Production Build


```bash

# Backend / 构建后端

cd backend && npm run build


# Frontend / 构建前端

cd frontend && npm run build    # Output: frontend/dist/

```


## 📦 Deployment


This section covers deployment scenarios from local dev to production servers.


### Option A: Local PM2 Deployment


PM2 keeps your app running persistently, auto-restarts on crash, and starts on boot.



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


> **Frontend production mode**: Serve `frontend/dist/` with Nginx (see Option C). Or use a simple Node.js static server.


### Option B: Alibaba Cloud ECS Deployment


This guide assumes a fresh CentOS/Ubuntu server.



#### 1. Initial Setup


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


#### 2. Deploy Code


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


#### 3. Start with PM2


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


#### 4. Nginx Reverse Proxy


<details>
<summary>Click to expand Nginx config

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


Enable and start


```bash

ln -s /etc/nginx/sites-available/sclaw /etc/nginx/sites-enabled/

nginx -t            # Test config / 测试配置

systemctl restart nginx

```


</details>

#### 5. HTTPS with Let's Encrypt


```bash

# Install certbot / 安装 certbot

apt install -y certbot python3-certbot-nginx


# Get certificate / 获取证书

certbot --nginx -d your-domain.com


# Auto-renew / 自动续期

certbot renew --dry-run

```


#### 6. Firewall Configuration


```bash

# Allow HTTP/HTTPS / 允许 HTTP/HTTPS

ufw allow 80/tcp

ufw allow 443/tcp


# (Optional) Allow SSH / 允许 SSH

ufw allow 22/tcp


# Enable firewall / 启用防火墙

ufw enable

```


#### 7. Monitoring


```bash

# PM2 monitor / PM2 监控

pm2 monit


# View logs / 查看日志

pm2 logs sclaw-backend


# Restart if needed / 重启

pm2 restart sclaw-backend

```


### Option C: Docker Deployment


> Note: Dockerfile not included yet. Coming soon.


For now, use PM2 + Nginx as described above.



### Option D: One-Click Script


SClaw includes `deploy.sh` for quick deployment on fresh servers.



```bash

# Upload the project to your server / 上传项目到服务器

# scp -r sclaw root@your_server_ip:/root/


# SSH into server / SSH 登录服务器

ssh root@your_server_ip


# Run deploy script / 运行部署脚本

cd /root/sclaw

bash deploy.sh

```


The script handles

- Node.js installation

- Directory structure creation

- Source code deployment

- PM2 process management


> **Note**: `deploy.sh` embeds all source code inline. It's designed for quick re-deployment on servers without git access. For normal development, use the `backend/` + `frontend/` structure with git.


## 📡 API Reference


### Screening


| Method | Endpoint | Description |


| GET | `/api/plugins` | List all plugins & strategies |

| GET | `/api/strategies` | List all available strategies |

| POST | `/api/screen` | Execute stock screening |

| POST | `/api/screen/stream` | Streaming screen results (SSE) |


### Backtesting


| Method | Endpoint | Description |


| POST | `/api/backtest/run` | Run backtest |

| POST | `/api/backtest/cache` | Clear backtest cache |


### AI Agent


| Method | Endpoint | Description |


| POST | `/api/chat/send` | Send message to AI |

| GET | `/api/chat/stream` | Stream AI response (SSE) |

| POST | `/api/chat/clear` | Clear current session |

| GET | `/api/chat/history` | Get chat history |


### Scheduler


| Method | Endpoint | Description |


| GET | `/api/schedule` | List scheduled tasks |

| POST | `/api/schedule` | Create scheduled task |

| PUT | `/api/schedule/:id` | Update scheduled task |

| DELETE | `/api/schedule/:id` | Delete scheduled task |


### Data Sync


| Method | Endpoint | Description |


| GET | `/api/data/status` | Data sync status |

| POST | `/api/data/sync` | Trigger data sync |

| POST | `/api/data/sync/stock-names` | Sync stock names |

| POST | `/api/data/sync/benchmarks` | Sync benchmarks |

| POST | `/api/data/cleanup` | Clean stale data |


### User & Auth


| Method | Endpoint | Description |


| POST | `/api/auth/login` | User login |

| POST | `/api/auth/logout` | Logout |

| GET | `/api/user/me` | Current user info |

| PUT | `/api/user/config` | Update user config |

| GET | `/api/user/screens` | Screen history |

| GET | `/api/user/logs` | Operation logs |


## 🗄️ Data Sources


### Tushare Pro (Primary


- **Daily K-line** — OHLCV for ~5000 A-share stocks since 2020

- **Stock names** — full listing with market codes

- **Benchmark indexes** — CSI 300, CSI 500, CSI 1000, ChiNext

- **Efficient query** — per-trading-day batch strategy (1 call = all stocks for 1 day)


### East Money


- **Supplementary historical data** — for fallback and verification


## 🧠 AI Agent


The built-in AI agent (powered by DeepSeek) provides natural language control:


| Capability | Description |


| **Screen stocks** | Select and configure strategies by conversation |

| **Analyze results** | Natural language analysis of screening results |

| **Generate strategies** | Create new strategies from descriptions |

| **Optimize parameters** | Backtest-based parameter optimization |

| **Risk assessment** | Risk evaluation for stocks or portfolios |

| **Schedule reports** | Set up cron-based email reports |

| **Memory recall** | Recall past conversations across sessions |


### Tool Categories


- **File ops** — read, write, edit, glob, grep
- **Stock info** — search, detail, k-line, market overview
- **Strategy validation** — list, run, validate
- **Risk assessment** — portfolio analysis, concentration, correlation
- **Strategy generation** — create from description
- **Strategy optimization** — backtest-driven parameter tuning
- **Frontend actions** — trigger screening from chat
- **Memory recall** — search past conversations
- **Schedule management** — create/update/delete scheduled tasks


## 🧪 Testing


```bash

# Backend unit tests / 后端单元测试 (Vitest)

cd backend && npm test


# Frontend E2E tests / 前端 E2E 测试 (Playwright)

cd frontend && npm run test:e2e


# Watch mode / 监听模式

cd backend && npm run test:watch

```


## 📄 License


Distributed under the **Apache License 2.0**. See `LICENSE` for details.




<p align="center">
  Built with TypeScript, React, Express, and ❤️
  <br>
  Built by <strong>Jack</strong>
  <br>
  <em>Not financial advice. Trade responsibly.</em>
  <br>
  <em>。。</em>
</p>
