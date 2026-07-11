#!/usr/bin/env bash
# ==============================================================
#  API 全接口手动测试脚本
#  分层测试：从最基础的系统级 → 到高级组合功能
#
#  用法：
#    bash test-api.sh            ← 跑全部层级
#    bash test-api.sh 1          ← 只跑 Level 1
#    bash test-api.sh 1 2 3      ← 跑 Level 1~3
#    bash test-api.sh --list     ← 列出所有接口
# ==============================================================
set -e
API="http://localhost:3001"
PASS=0
FAIL=0

# ==============================================================
# 工具函数
# ==============================================================
ok()   { PASS=$((PASS+1)); echo -e "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ❌ $1"; echo "     $2"; }

api_get() {
  local desc="$1" url="$2"
  local result=$(curl -s "$API$url" 2>&1)
  if [ -z "$result" ]; then fail "$desc" "empty response"; return 1; fi
  if echo "$result" | grep -q '"error"'; then
    local err=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null || echo "$result")
    fail "$desc" "error: $err"
    return 1
  fi
  ok "$desc"
  echo "$result" | python3 -m json.tool 2>/dev/null || echo "$result"
  echo ""
}

api_post() {
  local desc="$1" url="$2" body="$3"
  # 用 node 发请求避免 curl 的 Content-Type 丢失问题
  local result=$(node -e "
    const http = require('http');
    const p = $body;
    const r = http.request({
      hostname: 'localhost', port: 3001, path: '$url', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(p)) }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        console.log(JSON.stringify({status: res.statusCode, body: JSON.parse(d)}));
      });
    });
    r.write(JSON.stringify(p)); r.end();
  " 2>&1)
  
  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status'] < 500" 2>/dev/null; then
    ok "$desc"
  else
    fail "$desc" "$result"
  fi
  echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  Status:', d['status'])
b = d['body']
if 'error' in b:
    print('  Error:', b['error'], b.get('detail',''))
else:
    if 'stats' in b:
        s=b['stats']
        print(f'  Stocks: {s.get(\"totalStocks\",\"?\")} Matched: {s.get(\"matchedStocks\",\"?\")}')
    elif 'data' in b and isinstance(b['data'], list):
        print(f'  K-lines: {len(b[\"data\"])} rows')
        print(f'  Range: {b[\"data\"][0][\"date\"]} ~ {b[\"data\"][-1][\"date\"]}')
    elif 'plugins' in b:
        print(f'  Plugins: {len(b[\"plugins\"])}')
    elif 'strategies' in b:
        print(f'  Strategies: {len(b[\"strategies\"])}')
    else:
        keys = list(b.keys())[:5]
        print(f'  Keys: {keys}')
" 2>/dev/null
  echo ""
}


# ==============================================================
#  Layer 1: 系统基础（无依赖，一启动就可用）
# ==============================================================
level1() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Layer 1: 系统基础                                      ║"
  echo "║   系统级接口，无任何依赖，服务启动就能用                   ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  api_get  "1.1 健康检查"         "/api/health"
  api_get  "1.2 插件列表"         "/api/plugins"
  api_get  "1.3 策略列表"         "/api/strategies"
}

# ==============================================================
#  Layer 2: 数据获取（依赖数据源：腾讯行情 + SQLite）
# ==============================================================
level2() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Layer 2: 数据获取                                      ║"
  echo "║   选股的原材料——行情数据 + K线数据                        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  api_post "2.1 刷新数据缓存"     "/api/data/refresh" '{}'
  api_get  "2.2 个股K线(日线)"    "/api/stock/600519/kline?market=SH&days=30"
  api_get  "2.3 个股K线(创业板)"   "/api/stock/300378/kline?market=SZ&days=60"
}

# ==============================================================
#  Layer 3: 选股执行（依赖 Layer 1 + 2）
# ==============================================================
level3() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Layer 3: 选股执行                                      ║"
  echo "║   在实时行情上跑策略——核心功能                             ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  echo "--- 3.1 缠论日线第一类买点 ---"
  api_post "缠论日线第一类买点" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-buy-points","strategyId":"chan-first-buy","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.2 缠论30分钟第二类买点 ---"
  api_post "缠论30分钟第二类买点" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-buy-points","strategyId":"chan-second-buy","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.3 缠论底分型 ---"
  api_post "缠论底分型" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-theory-screener","strategyId":"chan-fractal","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.4 缠论底背驰 ---"
  api_post "缠论底背驰" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-theory-screener","strategyId":"chan-divergence","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.5 缠论第三类买点 ---"
  api_post "缠论第三类买点" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-theory-screener","strategyId":"chan-third-buy","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.6 做T五维精选（最常用日间策略）---"
  api_post "做T五维精选" "/api/screen" \
    '{"strategies":[{"pluginId":"sclaw-dt-filter","strategyId":"dt-filter","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.7 缠论5条件选股全面版（组合策略）---"
  api_post "缠论5条件选股全面版" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-5filters-screener","strategyId":"chan-5filters-main","params":{}}],"market":["SH","SZ"]}'

  echo "--- 3.8 多策略组合（第一类+第二类买点同时跑）---"
  api_post "缠论买卖点组合" "/api/screen" \
    '{"strategies":[{"pluginId":"chan-buy-points","strategyId":"chan-first-buy","params":{}},{"pluginId":"chan-buy-points","strategyId":"chan-second-buy","params":{}}],"market":["SH","SZ"]}'
}

# ==============================================================
#  Layer 4: 回测（依赖 Layer 3 的策略 + 历史数据）
# ==============================================================
level4() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Layer 4: 回测                                          ║"
  echo "║   用历史数据验证策略效果——比选股更高一级                   ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  api_get  "4.1 回测配置" "/api/backtest/config"

  echo "--- 4.2 缠论第一类买点回测 ---"
  api_post "缠论第一类买点回测" "/api/backtest/run" \
    '{"strategies":[{"pluginId":"chan-buy-points","strategyId":"chan-first-buy","params":{}}],"startDate":"2026-06-01","endDate":"2026-07-10","initialCapital":100000}'
}

# ==============================================================
#  Layer 5: 定时任务（依赖 Layer 3）
# ==============================================================
level5() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Layer 5: 定时任务                                      ║"
  echo "║   把选股自动化——定期执行 + 报告                            ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  api_get  "5.1 任务列表"   "/api/scheduler/tasks"
  api_get  "5.2 任务队列"   "/api/scheduler/queue"

  echo "--- 5.3 创建定时选股任务 ---"
  api_post "创建定时任务" "/api/scheduler/tasks" \
    '{"type":"screen","cronExpr":"0 9 * * 1-5","strategies":[{"pluginId":"chan-buy-points","strategyId":"chan-first-buy","params":{}}],"label":"工作日晨选-缠论第一类买点","email":""}'

  echo "--- 5.4 清理刚才创建的测试任务 ---"
  # 获取第一个任务ID并删除
  local task_id=$(curl -s "$API/api/scheduler/tasks" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('tasks',d.get('data',[])); print(t[0]['id'] if t else '')" 2>/dev/null)
  if [ -n "$task_id" ]; then
    api_get "删除测试任务" "/api/scheduler/tasks/$task_id"
  else
    echo "  ⏭️  无任务可清理"
  fi
}

# ==============================================================
#  Layer 6: 高级功能（独立模块，依赖外部系统）
# ==============================================================
level6() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Layer 6: 高级功能                                      ║"
  echo "║   登录/用户/聊天/盯盘/Garuda管理等                        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  api_get  "6.1 当前用户"       "/api/me"
  api_get  "6.2 用户配置"       "/api/user/config"
  api_get  "6.3 盯盘任务"       "/api/watch/tasks"
  api_get  "6.4 Garuda健康"    "/api/admin/garuda/health"
  api_get  "6.5 Garuda任务"    "/api/admin/garuda/tasks"

  echo "--- 6.6 聊天（发条简单消息） ---"
  api_post "聊天接口" "/api/chat" \
    '{"message":"你好，今天有什么选股机会？","mode":"screen","strategies":[{"pluginId":"chan-buy-points","strategyId":"chan-first-buy","params":{}}]}'

  echo "--- 6.7 交易接口（只测健康，不实际交易） ---"
  api_get  "交易系统健康" "/api/trade/health"
}

# ==============================================================
#  打印 API 总览
# ==============================================================
print_overview() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║                 SClaw API 接口全景图                             ║"
  echo "╠══════════════════════════════════════════════════════════════════╣"
  echo "║                                                                    ║"
  echo "║  Layer 1: 系统基础                                                ║"
  echo "║    GET  /api/health         健康检查                               ║"
  echo "║    GET  /api/plugins        插件列表（含策略元信息）                ║"
  echo "║    GET  /api/strategies     策略列表                               ║"
  echo "║                                                                    ║"
  echo "║  Layer 2: 数据获取                                                ║"
  echo "║    POST /api/data/refresh   刷新数据缓存                           ║"
  echo "║    GET  /api/stock/:code/kline  个股K线（日线/任意周期）            ║"
  echo "║                                                                    ║"
  echo "║  Layer 3: 选股执行 ⭐核心                                          ║"
  echo "║    POST /api/screen         执行选股（任意策略组合）                ║"
  echo "║      ├─ chan-first-buy      日线第一类买点  ← 我们的新插件          ║"
  echo "║      ├─ chan-second-buy     30分钟第二类买点                       ║"
  echo "║      ├─ chan-fractal        缠论底分型                             ║"
  echo "║      ├─ chan-divergence     缠论底背驰                             ║"
  echo "║      ├─ chan-third-buy      第三类买点                             ║"
  echo "║      ├─ dt-filter           做T五维精选（涨幅+量比+换手+市值）     ║"
  echo "║      ├─ chan-5filters-main  缠论5条件选股全面版                    ║"
  echo "║      └─ six-filters         六维精选                               ║"
  echo "║                                                                    ║"
  echo "║  Layer 4: 回测                                                    ║"
  echo "║    GET  /api/backtest/config   回测配置                            ║"
  echo "║    POST /api/backtest/run      运行回测                            ║"
  echo "║                                                                    ║"
  echo "║  Layer 5: 定时任务                                                ║"
  echo "║    GET  /api/scheduler/tasks     任务列表                          ║"
  echo "║    POST /api/scheduler/tasks     创建任务                          ║"
  echo "║    DELETE /api/scheduler/tasks/:id  删除任务                       ║"
  echo "║    PUT   /api/scheduler/tasks/:id/toggle  启停                     ║"
  echo "║    POST  /api/scheduler/tasks/:id/run    立即执行                  ║"
  echo "║                                                                    ║"
  echo "║  Layer 6: 高级功能                                                ║"
  echo "║    GET  /api/me              当前用户                              ║"
  echo "║    POST /api/chat            聊天对话                              ║"
  echo "║    GET  /api/watch/tasks     盯盘任务                              ║"
  echo "║    GET  /api/admin/garuda/*  Garuda管理                            ║"
  echo "║    GET  /api/trade/*         交易接口                              ║"
  echo "║                                                                    ║"
  echo "╚══════════════════════════════════════════════════════════════════════╝"
}

# ==============================================================
#  主入口
# ==============================================================
main() {
  # 先测服务是否活着
  if ! curl -sf "$API/api/health" > /dev/null 2>&1; then
    echo "❌ 服务未运行！请先启动: pm2 start dist/index.js"
    exit 1
  fi

  print_overview

  if [ $# -eq 0 ]; then
    # 全跑
    level1
    level2
    level3
    level4
    level5
    level6
  else
    for arg in "$@"; do
      case $arg in
        --list) print_overview; exit 0 ;;
        1) level1 ;;
        2) level2 ;;
        3) level3 ;;
        4) level4 ;;
        5) level5 ;;
        6) level6 ;;
        *) echo "未知层级: $arg (可用: 1-6)"; exit 1 ;;
      esac
    done
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Done!  ✅ $PASS passed, ❌ $FAIL failed"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "测试切入点建议:"
  echo "  新手:  Layer 1 → Layer 2 → Layer 3 (按顺序理解全链路)"
  echo "  调试:  直接跑对应层级的分层测试"
  echo "  验证:  bash test-api.sh 3   (只测选股)"
}

main "$@"
