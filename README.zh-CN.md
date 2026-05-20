<p align="center">


</p>

<h1 align="center">🦀 SClaw — AI 选股系统<


<p align="center">


  <>多策略选股   智能体  回测引擎  定时提醒</>


  <>插件化架构  写好自己的策略丢进 / 即可运行</>

</p>

---

> ⚠️ **免责声明**
>

>
> **中文:** 本软件仅供学习和研究用途。选股和回测结果不保证未来收益。投资决策前请自行充分调研。

---

## 目录


- [功能特性](#features--功能特性)

- [架构](#architecture--架构)

- [策略插件](#strategy-plugins--策略插件)

- [快速开始](#quick-start--快速开始)

- [部署指南](#deployment--部署指南)

- [API 参考](#api-reference--api-参考)

- [数据源](#data-sources--数据源)

- [AI 智能体](#ai-agent--ai-智能体)

- [测试](#testing--测试)

- [许可证](#license--许可证)


---

## 功能特性


### 多策略选股


` 目录即可使用。

涵盖做 T、短线、放量、均线偏离、震荡市等场景。

支持评分合并和并集模式，多策略命中才高亮。

按市场板块筛选，每个策略参数可调。


### AI 智能体


与 AI 对话即可完成选股、分析、策略管理。

股票查询、风险评估、策略生成与优化、文件操作、记忆召回。

支持 DeepSeek R1 深度思考模式。

每个用户独立会话和记忆。


### 回测引擎


任意日期范围的策略表现模拟。

初始资金、最大持仓、调仓频率、佣金、滑点全可配。

总收益、年化收益、最大回撤、夏普比率等 11 项指标。

5×3 市场状态热力图 + 12 月季节性分析。


### 定时选股


定时执行选股任务并通过邮件发送报告。

每个用户独立配置。


### 认证系统


普通用户角色。

配置、选股历史、操作日志持久化。


### 现代化界面


暗色主题。

支持排序筛选。

权益曲线图。

Markdown 渲染 + 流式输出。


---

## 架构


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

## 策略插件


` 目录，每个插件是一个文件夹，内含 `index.ts` 导出 `StockScreenerPlugin` 对象。无需配置，放入即用。


### 内置策略一览


 | 插件名 | 类型 | 描述 | 


 | | 做T | AI 做 T 精选 | 

 | | 做T | AI 做 T 精选 (备选模型) | 

 | | 做T | AI做T精选V1 | 

 | | 做T | AI做T精选V2 | 

 | | 短线 | AI短线精选 | 

 | | 短线 | AI短线精选V2 | 

 | | 放量 | AI放量上涨修正版 | 

 | | 震荡 | 震荡市猎手 | 

 | | 做T | 分时均线偏离做T | 

 | | 放量 | 简易放量上涨 | 

 | | 调试 | 字段调试工具 | 

 | | 示例 | 参考插件 | 


` 并修改逻辑即可，系统自动发现。


---

## 快速开始


### 环境要求


- **Tushare Pro token** — [free tier available / 免费注册](https://tushare.pro)

### 安装


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


### 配置


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


### 开发模式


```bash

# Terminal 1: Backend / 启动后端 (auto-reload via tsx watch)

cd backend && npm run dev


# Terminal 2: Frontend / 启动前端 (Vite dev server)

cd frontend && npm run dev

```


Open `http://localhost:5173` in your browser. / 打开浏览器访问 `http://localhost:5173`。

### 生产构建


```bash

# Backend / 构建后端

cd backend && npm run build


# Frontend / 构建前端

cd frontend && npm run build    # Output: frontend/dist/

```


---

## 部署指南


本节覆盖从本地开发到生产服务器的完整部署方案。

---

### 本地 PM2 部署


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


用 Nginx 代理前端静态文件，见下方 Option C。


---

### 阿里云 ECS 部署


Ubuntu 服务器。


#### 初始设置


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


#### 部署代码


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


#### PM2 启动


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


#### Nginx 反向代理


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


启用并启动:


```bash

ln -s /etc/nginx/sites-available/sclaw /etc/nginx/sites-enabled/

nginx -t            # Test config / 测试配置

systemctl restart nginx

```


</details>

#### 配置 HTTPS


```bash

# Install certbot / 安装 certbot

apt install -y certbot python3-certbot-nginx


# Get certificate / 获取证书

certbot --nginx -d your-domain.com


# Auto-renew / 自动续期

certbot renew --dry-run

```


#### 防火墙配置


```bash

# Allow HTTP/HTTPS / 允许 HTTP/HTTPS

ufw allow 80/tcp

ufw allow 443/tcp


# (Optional) Allow SSH / 允许 SSH

ufw allow 22/tcp


# Enable firewall / 启用防火墙

ufw enable

```


#### 监控


```bash

# PM2 monitor / PM2 监控

pm2 monit


# View logs / 查看日志

pm2 logs sclaw-backend


# Restart if needed / 重启

pm2 restart sclaw-backend

```


---

### Docker 部署


> Note: Dockerfile not included yet. Coming soon.
> 注意：Dockerfile 暂未提供，即将支持。


目前请使用 PM2 + Nginx 方式部署。

---

### 一键部署脚本


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


脚本自动处理:

安装 Node.js

创建目录结构

部署源代码

PM2 进程管理


` 目录结构配合 Git。


---

## API 参考


### 选股


 | | | 说明 | 


 | | plugins` | 列出所有插件和策略 | 

 | | strategies` | 列出所有可用策略 | 

 | | screen` | 执行选股 | 

 | | stream` | 流式返回选股结果 | 


### 回测


 | | | 说明 | 


 | | run` | 运行回测 | 

 | | cache` | 清除回测缓存 | 


### AI 智能体


 | | | 说明 | 


 | | send` | 发送消息给 AI | 

 | | stream` | 流式获取 AI 回复 | 

 | | clear` | 清空当前会话 | 

 | | history` | 获取聊天记录 | 


### 定时任务


 | | | 说明 | 


 | | schedule` | 列出定时任务 | 

 | | schedule` | 创建定时任务 | 

 | | :id` | 更新定时任务 | 

 | | :id` | 删除定时任务 | 


### 数据同步


 | | | 说明 | 


 | | status` | 数据同步状态 | 

 | | sync` | 触发数据同步 | 

 | | stock-names` | 同步股票名称 | 

 | | benchmarks` | 同步指数 | 

 | | cleanup` | 清理过期数据 | 


### 用户与认证


 | | | 说明 | 


 | | login` | 用户登录 | 

 | | logout` | 登出 | 

 | | me` | 当前用户信息 | 

 | | config` | 更新用户配置 | 

 | | screens` | 选股历史 | 

 | | logs` | 操作日志 | 


---

## 数据源


### 主要数据源)


约 5000 只 A 股日线数据

完整股票列表

沪深300、中证500、中证1000、创业板指

按交易日批量查询，一天一只 API 调用


### 东方财富 (Supplemental / 补充)


用于回退和验证


---

## AI 智能体


内置 AI 智能体（基于 DeepSeek）提供了自然语言控制能力：

 | 能力 | 说明 | 


 | **选股** | 通过对话选择和配置选股策略 | 

 | **分析结果** | 自然语言分析选股结果 | 

 | **生成策略** | 根据描述生成新策略 | 

 | **优化参数** | 基于回测的参数优化 | 

 | **风险评估** | 个股或组合风险评估 | 

 | **定时报告** | 设置定时邮件报告 | 

 | **记忆召回** | 跨会话回忆历史对话 | 


### 工具分类


- **文件操作** — read, write, edit, glob, grep
- **股票查询** — search, detail, k-line, market overview
- **策略验证** — list, run, validate
- **风险评估** — portfolio analysis, concentration, correlation
- **策略生成** — create from description
- **策略优化** — backtest-driven parameter tuning
- **前端操作** — trigger screening from chat
- **记忆召回** — search past conversations
- **调度管理** — create/update/delete scheduled tasks

---

## 测试


```bash

# Backend unit tests / 后端单元测试 (Vitest)

cd backend && npm test


# Frontend E2E tests / 前端 E2E 测试 (Playwright)

cd frontend && npm run test:e2e


# Watch mode / 监听模式

cd backend && npm run test:watch

```


---

## 许可证


基于 **Apache License 2.0** 发布。详见 `LICENSE` 文件。

---

<p align="center">


  <>本工具不构成投资建议请理性交易</>

</p>