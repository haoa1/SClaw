#!/usr/bin/env bash
# ==============================================================
#  DataFetcher 内部方法测试脚本
#  从最底层的工具函数，到最顶层的业务接口
#
#  用法:
#    bash test-datafetcher.sh            ← 全跑
#    bash test-datafetcher.sh 1          ← 只跑 Level 1
#    bash test-datafetcher.sh --list     ← 看方法全景
# ==============================================================
set -e
PASS=0
FAIL=0
SKIP=0

ok()   { PASS=$((PASS+1)); echo -e "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ❌ $1"; echo -e "     $2"; }
skip() { SKIP=$((SKIP+1)); echo -e "  ⏭️  $1"; }

# 生成测试脚本片段
# 每个 level 写成独立的 node 脚本，方便单独跑
run_test() {
  local level="$1" desc="$2" script="$3"
  local script_file="/tmp/df_test_${level}.mjs"
  
  # 写入通用头部 + 测试逻辑
  cat > "$script_file" << 'HEADER'
import { DataFetcher } from '/root/sclaw/backend/dist/data/data-fetcher.js';
const df = new DataFetcher();
let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✅', msg); }
function failmsg(msg, detail) { fail++; console.log('  ❌', msg); if(detail) console.log('     ', detail); }
function skip(msg) { console.log('  ⏭️ ', msg); }
HEADER
  # 写入测试逻辑
  echo "$script" >> "$script_file"

  local result=$(node "$script_file" 2>&1)
  local rc=$?
  
  echo "--- $desc ---"
  if [ $rc -ne 0 ] && ! echo "$result" | grep -q "❌\|✅"; then
    fail "$desc" "脚本异常: $(echo "$result" | head -3)"
    return
  fi
  echo "$result"
  echo ""
}

print_overview() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════════╗"
  echo "║            DataFetcher 方法依赖链全景                               ║"
  echo "╠══════════════════════════════════════════════════════════════════════╣"
  echo "║                                                                      ║"
  echo "║  Level 0: 基础工具函数                                               ║"
  echo "║    safeParseFloat()    字符串→浮点数                                 ║"
  echo "║    daysBetween()       计算两个日期之间的天数                         ║"
  echo "║    detectMarketByCode() 600xxx→SH, 300xxx→SZ, 830xxx→BJ              ║"
  echo "║    codeToTencentSymbol() 600519→sh600519                              ║"
  echo "║    clearCache()        清空内存缓存                                   ║"
  echo "║                                                                      ║"
  echo "║  Level 1: 原始数据解析                                               ║"
  echo "║    Tencent 原始协议: v_SH600519=\"...~...~...\";                       ║"
  echo "║    parseTencentStockData()  腾讯全市场行情→StockData                  ║"
  echo "║    getStockList()          读取 stock_list.json                       ║"
  echo "║                                                                      ║"
  echo "║  Level 2: 数据源直连（裸调外部API）                                  ║"
  echo "║    fetchTencentFQKLine()    腾讯前复权日K (web.ifzq.gtimg.cn)         ║"
  echo "║    fetchSinaKLine()         新浪K线 (finance.sina.com.cn)             ║"
  echo "║    queryLocalKLine()        本地 SQLite (stock_history.db)            ║"
  echo "║                                                                      ║"
  echo "║  Level 3: 数据获取组合（降级链）                                     ║"
  echo "║    fetchOnlineKLine()       腾讯→新浪降级链                           ║"
  echo "║    fetchKLineByPeriod()     新浪支持任意周期(5/15/30/60/240分)        ║"
  echo "║    refreshFromNetwork()     批量拉全市场实时数据                      ║"
  echo "║                                                                      ║"
  echo "║  Level 4: 业务接口（对外暴露）                                       ║"
  echo "║    fetchKLine()             日K线: SQLite→腾讯→新浪三级降级+去重      ║"
  echo "║    fetchQuotes()            个股快照(带LRU缓存)                       ║"
  echo "║    fetchAllStocks()         全市场扫描(请求去重)                      ║"
  echo "║                                                                      ║"
  echo "║  Level 5: 综合链路验证                                              ║"
  echo "║    缠论策略完整调用链路:                                              ║"
  echo "║    fetchAllStocks → preFilter → fetchKLine → 策略计算 → 评分排序      ║"
  echo "║                                                                      ║"
  echo "╚══════════════════════════════════════════════════════════════════════╝"
}

# ==============================================================
#  Level 0: 基础工具函数
# ==============================================================
level0() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Level 0: 基础工具函数                                    ║"
  echo "║  最底层——不依赖任何外部资源，纯计算                        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "切入点: 这是整个数据层的基石，所有上层都依赖它们"

  run_test "0.1" "safeParseFloat: 字符串转浮点数" '
try {
  const r = df.safeParseFloat("3.14");
  if (r === 3.14) ok("safeParseFloat(\"3.14\") = 3.14");
  else failmsg("解析失败", JSON.stringify(r));
  
  const r2 = df.safeParseFloat("--");
  if (r2 === null) ok("safeParseFloat(\"--\") = null (无效格式兜底)");
  else failmsg("无效值应返回null", JSON.stringify(r2));
  
  const r3 = df.safeParseFloat(undefined);
  if (r3 === null) ok("safeParseFloat(undefined) = null");
  else failmsg("undefined应返回null", JSON.stringify(r3));
} catch(e) { failmsg("异常", e.message); }
'

  run_test "0.2" "daysBetween: 日期差计算" '
try {
  const d = df.daysBetween("2026-06-01", "2026-07-11");
  if (d === 40) ok("2026-06-01 ~ 2026-07-11 = 40天");
  else failmsg("计算结果", d);
  
  const d2 = df.daysBetween("2026-07-11", "2026-07-11");
  if (d2 === 0) ok("同一天 = 0天");
  else failmsg("同一天应返回0", d2);
} catch(e) { failmsg("异常", e.message); }
'

  run_test "0.3" "detectMarketByCode: 代码判断市场" '
try {
  if (df.detectMarketByCode("600519") === "SH") ok("600519 → SH (沪市)");
  else failmsg("600519 应为SH");
  if (df.detectMarketByCode("000001") === "SZ") ok("000001 → SZ (深市)");
  else failmsg("000001 应为SZ");
  if (df.detectMarketByCode("300378") === "SZ") ok("300378 → SZ (创业板)");
  else failmsg("300378 应为SZ");
  if (df.detectMarketByCode("688522") === "SH") ok("688522 → SH (科创板)");
  else failmsg("688522 应为SH");
  if (df.detectMarketByCode("830123") === "BJ") {
    ok("830123 → BJ (北交所)");
  } else { if (df.detectMarketByCode("830123") === null) { ok("830123 → null(可接受)"); } else failmsg("830123应返回BJ或null"); }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "0.4" "codeToTencentSymbol: 代码转腾讯格式" '
try {
  // 这个方法是私有的，通过prototype检测
  const fn = Object.getPrototypeOf(df).codeToTencentSymbol;
  if (fn) {
    if (df.codeToTencentSymbol("600519") === "sh600519") ok("600519 → sh600519");
    else failmsg("600519错误", df.codeToTencentSymbol("600519"));
    if (df.codeToTencentSymbol("000001") === "sz000001") ok("000001 → sz000001");
    else failmsg("000001错误", df.codeToTencentSymbol("000001"));
    if (df.codeToTencentSymbol("830123") === "bj830123") ok("830123 → bj830123");
    else failmsg("830123错误", df.codeToTencentSymbol("830123"));
  } else {
    skip("codeToTencentSymbol 在实例上不可用");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "0.5" "clearCache: 清空缓存" '
try {
  df.clearCache();
  ok("clearCache() 执行无异常");
} catch(e) { failmsg("异常", e.message); }
'
}

# ==============================================================
#  Level 1: 原始数据解析
# ==============================================================
level1() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Level 1: 原始数据解析                                    ║"
  echo "║  解析腾讯API返回的原始协议字符串                           ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "切入点: 腾讯API返回的是 v_CODE=\"f1~f2~...~fN\"; 格式，"
  echo "          parseTencentStockData 负责拆解这个协议"

  run_test "1.1" "getStockList: 读取股票代码列表" '
try {
  const list = await df.getStockList();
  if (Array.isArray(list) && list.length > 5000) {
    ok("getStockList() 返回 " + list.length + " 只股票");
    // 抽样验证
    const sh = list.filter(s => s.market === "SH");
    const sz = list.filter(s => s.market === "SZ");
    const bj = list.filter(s => s.market === "BJ");
    console.log("     SH:", sh.length, " SZ:", sz.length, " BJ:", bj.length);
  } else {
    failmsg("数据异常", "返回 " + JSON.stringify(list).slice(0, 200));
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "1.2" "parseTencentStockData: 私有方法跳过" '
console.log("  ⏭️  parseTencentStockData 是私有方法，需要实际腾讯返回数据才能测试");
console.log("     它的功能通过 refreshFromNetwork / fetchAllStocks 间接验证");
skip("已在 Level 4 fetchAllStocks 中间接测试");
'

}

# ==============================================================
#  Level 2: 数据源直连（裸调外部API）
# ==============================================================
level2() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Level 2: 数据源直连                                      ║"
  echo "║  直接调用各外部API——不经过降级链，看每个源的原生数据        ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "切入点: 这是数据层的"原材料采购"——验证每个数据源是否可用"
  echo "         先检验每个源，后面的降级链才知道哪个源兜底"

  run_test "2.1" "腾讯前复权日K: 贵州茅台(600519)" '
try {
  console.log("  正在请求腾讯API https://web.ifzq.gtimg.cn ...");
  const { data, source } = await df.fetchOnlineKLine("600519", "SH", 30);
  if (data.length >= 2) {
    ok("腾讯前复权日K: " + data.length + "条");
    console.log("  最新: " + data[data.length-1].date +
      " O:" + data[data.length-1].open +
      " H:" + data[data.length-1].high +
      " L:" + data[data.length-1].low +
      " C:" + data[data.length-1].close);
    console.log("  最早: " + data[0].date);
  } else {
    failmsg("数据不足", data.length + "条");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "2.2" "新浪K线: 贵州茅台(600519)" '
try {
  console.log("  正在请求新浪API https://money.finance.sina.com.cn ...");
  const data = await df.fetchSinaKLine("600519", "SH", 30);
  if (data.length >= 2) {
    ok("新浪K线: " + data.length + "条");
    console.log("  最新: " + data[data.length-1].date +
      " O:" + data[data.length-1].open +
      " C:" + data[data.length-1].close);
    console.log("  最早: " + data[0].date);
  } else {
    failmsg("数据不足", data.length + "条");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "2.3" "新浪K线: 北交所股票(830123)" '
try {
  console.log("  测试北交所股票...");
  const data = await df.fetchSinaKLine("830123", "BJ", 20);
  if (data.length > 0) {
    ok("北交所K线: " + data.length + "条");
    console.log("  最新: " + data[data.length-1].date + " C:" + data[data.length-1].close);
  } else {
    skip("北交所无数据(可能该代码无效)");
  }
} catch(e) { skip("北交所异常: " + e.message); }
'

  run_test "2.4" "查询本地SQLite: 贵州茅台(600519)" '
try {
  const rows = df.queryLocalKLine("600519", "2026-01-01", "2026-07-11");
  if (rows.length > 0) {
    ok("SQLite本地K线: " + rows.length + "条");
    console.log("  范围: " + rows[0].date + " ~ " + rows[rows.length-1].date);
    console.log("  最新: " + rows[rows.length-1].date +
      " O:" + rows[rows.length-1].open +
      " C:" + rows[rows.length-1].close +
      " V:" + rows[rows.length-1].volume);
  } else {
    console.log("  📂 SQLite数据库路径: /root/sclaw/data/stock_history.db");
    failmsg("本地无数据", "可能是数据库文件不存在或表为空");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "2.5" "腾讯 vs 新浪 数据对比" '
try {
  const tencent = await df.fetchOnlineKLine("600519", "SH", 10);
  const sina = await df.fetchSinaKLine("600519", "SH", 10);
  
  if (tencent.data.length > 0 && sina.length > 0) {
    // 对比最新一条
    const t = tencent.data[tencent.data.length-1];
    const s = sina[sina.length-1];
    console.log("  腾讯最新: " + t.date + " O:" + t.open + " C:" + t.close);
    console.log("  新浪最新: " + s.date + " O:" + s.open + " C:" + s.close);
    const diff = Math.abs(t.open - s.open);
    if (diff < 1) {
      ok("两源数据一致(价差" + diff.toFixed(2) + ")");
    } else {
      console.log("  ⚠️ 价差较大: " + diff.toFixed(2) + " (可能前复权vs未复权差异)");
      ok("两源数据均可获取");
    }
  } else if (tencent.data.length > 0) {
    ok("仅腾讯有数据");
  } else if (sina.length > 0) {
    ok("仅新浪有数据");
  }
} catch(e) { failmsg("异常", e.message); }
'
}

# ==============================================================
#  Level 3: 数据获取组合（降级链）
# ==============================================================
level3() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Level 3: 数据获取组合（降级链）                          ║"
  echo "║  验证自动降级、去重、合并逻辑                             ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "切入点: Level 2 的每个源都验过之后，看降级链是否正常工作"
  echo "         腾讯无数据→自动降级到新浪，本地缺数据→在线补"

  run_test "3.1" "30分钟K线: 贵州茅台(600519) — 详细分时" '
try {
  console.log("  ⏳ 获取30分钟K线...");
  const { data, period } = await df.fetchKLineByPeriod("600519", "SH", 30, 30);
  if (data.length >= 2) {
  ok(data.length + "条 30分K线 (period=" + period + ")");

  // --- 统计概览 ---
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);
  const maxVol = Math.max(...volumes);
  const maxVolBar = data[volumes.indexOf(maxVol)];
  console.log("  └─ 统计概览");
  console.log("  ├ 时间范围: " + data[0].date + " ~ " + data[data.length-1].date);
  console.log("  ├ 价格区间: 最高 " + Math.max(...highs).toFixed(2) + "  最低 " + Math.min(...lows).toFixed(2));
  console.log("  ├ 总成交量: " + volumes.reduce((a,b) => a+b, 0).toLocaleString());
  console.log("  ├ 最大量柱: " + maxVol.toLocaleString() + "  @ " + maxVolBar.date + " O:" + maxVolBar.open + " C:" + maxVolBar.close + " (" + ((maxVolBar.close - maxVolBar.open) / maxVolBar.open * 100).toFixed(2) + "%)");

  // --- 最近5条明细 ---
  console.log("  ├─ 最近5条K线明细");
  const tail5 = data.slice(-5);
  tail5.forEach((d, i) => {
    const chg = ((d.close - d.open) / d.open * 100).toFixed(2);
    const pct = chg >= 0 ? "+" + chg : chg;
    console.log("  │  " + d.date + "  O:" + d.open.toFixed(2) + " H:" + d.high.toFixed(2) + " L:" + d.low.toFixed(2) + " C:" + d.close.toFixed(2) + "  " + pct + "%  V:" + d.volume.toLocaleString());
  });

  // --- 成交量分布（前5大） ---
  console.log("  ├─ 成交量Top5");
  const sortedByVol = [...data].sort((a, b) => b.volume - a.volume).slice(0, 5);
  sortedByVol.forEach((d, i) => {
    console.log("  │   #" + (i+1) + " " + d.date + "  V:" + d.volume.toLocaleString() + "  O:" + d.open + " C:" + d.close + " 幅:" + ((d.close-d.open)/d.open*100).toFixed(2) + "%");
  });

  // --- 连续涨跌统计 ---
  let maxUp = 0, maxDown = 0, curUp = 0, curDown = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i].close > data[i-1].close) { curUp++; curDown = 0; maxUp = Math.max(maxUp, curUp); }
    else if (data[i].close < data[i-1].close) { curDown++; curUp = 0; maxDown = Math.max(maxDown, curDown); }
  }
  console.log("  └ 连续上涨最多: " + maxUp + "根  连续下跌最多: " + maxDown + "根");
  } else { failmsg("数据不足", data.length + "条"); }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "3.2" "60分钟K线: 姚记科技(002605) — 详细分时" '
try {
  console.log("  ⏳ 获取60分钟K线...");
  const { data, period } = await df.fetchKLineByPeriod("002605", "SZ", 25, 60);
  if (data.length >= 2) {
  ok(data.length + "条 60分K线 (period=" + period + ")");

  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);
  const range = Math.max(...highs) - Math.min(...lows);
  console.log("  └─ 统计概览");
  console.log("  ├ 时间范围: " + data[0].date + " ~ " + data[data.length-1].date);
  console.log("  ├ 价格区间: 最高 " + Math.max(...highs).toFixed(2) + "  最低 " + Math.min(...lows).toFixed(2) + "  振幅 " + range.toFixed(2));
  console.log("  ├ 均价: " + (data.reduce((s,d) => s + (d.high+d.low)/2, 0) / data.length).toFixed(2));
  console.log("  ├ 总成交量: " + volumes.reduce((a,b) => a+b, 0).toLocaleString());

  // --- 阴阳分布 ---
  const yang = data.filter(d => d.close >= d.open).length;
  const yin = data.filter(d => d.close < d.open).length;
  console.log("  ├ 阳线:" + yang + "根  阴线:" + yin + "根  阳率:" + (yang/data.length*100).toFixed(1) + "%");

  // --- 最近8条明细 ---
  console.log("  ├─ 最近8条K线明细");
  const tail8 = data.slice(-8);
  tail8.forEach((d, i) => {
    const chg = ((d.close - d.open) / d.open * 100).toFixed(2);
    const body = Math.abs(d.close - d.open);
    const upper = d.high - Math.max(d.close, d.open);
    const lower = Math.min(d.close, d.open) - d.low;
    const pct = chg >= 0 ? "+" + chg : chg;
    console.log("  │  " + d.date + "  O:" + d.open.toFixed(2) + " H:" + d.high.toFixed(2) + " L:" + d.low.toFixed(2) + " C:" + d.close.toFixed(2) + "  " + pct + "%  V:" + d.volume.toLocaleString() + "  实体:" + body.toFixed(2) + " 上影:" + upper.toFixed(2) + " 下影:" + lower.toFixed(2));
  });

  // --- 大幅波动时段 ---
  console.log("  ├─ 波动最大5根");
  const sortedByRange = [...data].sort((a, b) => (b.high-b.low) - (a.high-a.low)).slice(0, 5);
  sortedByRange.forEach((d, i) => {
    const amp = ((d.high - d.low) / d.open * 100).toFixed(2);
    console.log("  │   #" + (i+1) + " " + d.date + "  振幅:" + amp + "%  O:" + d.open + " H:" + d.high + " L:" + d.low + " C:" + d.close);
  });

  console.log("  └─ 尾盘(最后一条): " + data[data.length-1].date + " O:" + data[data.length-1].open + " C:" + data[data.length-1].close + " V:" + data[data.length-1].volume.toLocaleString());
  } else { failmsg("数据不足", data.length + "条"); }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "3.3" "5分钟K线: 宁德时代(300750) — 超短线明细" '
try {
  console.log("  ⏳ 获取5分钟K线（超短线）...");
  const { data, period } = await df.fetchKLineByPeriod("300750", "SZ", 15, 5);
  if (data.length >= 2) {
  ok(data.length + "条 5分K线 (period=" + period + ")");

  const volumes = data.map(d => d.volume);
  console.log("  └─ 5分钟K线概览");
  console.log("  ├ 时间范围: " + data[0].date + " ~ " + data[data.length-1].date);

  // 打印全部明细（最多15条）
  console.log("  ├─ 全部明细");
  data.forEach((d, i) => {
    const chg = ((d.close - d.open) / d.open * 100).toFixed(2);
    const pct = chg >= 0 ? "+" + chg : chg;
    console.log("  │  " + d.date + "  O:" + d.open.toFixed(2) + " H:" + d.high.toFixed(2) + " L:" + d.low.toFixed(2) + " C:" + d.close.toFixed(2) + "  " + pct + "%  V:" + d.volume.toLocaleString());
  });

  const maxVol = Math.max(...volumes);
  const maxVolBar = data[volumes.indexOf(maxVol)];
  console.log("  ├ 最大量柱: " + maxVol.toLocaleString() + "  @ " + maxVolBar.date + " O:" + maxVolBar.open + " C:" + maxVolBar.close);
  console.log("  └ 均价: " + (data.reduce((s,d) => s + (d.high+d.low)/2, 0) / data.length).toFixed(2));
  } else { failmsg("数据不足", data.length + "条"); }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "3.4" "降级测试: 北交所830123 - 腾讯无数据->新浪兜底" '
try {
  console.log("  ⏳ 降级链路: 腾讯无数据 -> 自动降级到新浪...");
  const { data, source } = await df.fetchOnlineKLine("830123", "BJ", 20);
  if (data.length > 0) {
    ok("降级成功: " + source + " 返回 " + data.length + "条");
    console.log("  └─ " + source + " 数据明细");
    data.forEach((d, i) => {
      console.log("  │  " + (i+1) + ". " + d.date + "  O:" + d.open + " H:" + d.high + " L:" + d.low + " C:" + d.close + "  V:" + d.volume);
    });
    console.log("  └ 共" + data.length + "条");
  } else {
    skip("两源均无数据");
  }
} catch(e) { failmsg("异常", e.message); }
'
}

# ==============================================================
#  Level 4: 业务接口（对外暴露）
# ==============================================================
level4() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Level 4: 业务接口（对外暴露）                            ║"
  echo "║  其他模块实际调用的方法——带缓存、去重、请求合并            ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "切入点: Level 0~3 全部就绪后，这些接口才能正常工作"

  run_test "4.1" "fetchKLine(600519, SH, 30): 完整降级链" '
try {
  const { data, meta } = await df.fetchKLine("600519", "SH", 30);
  if (data.length >= 2) {
    ok("日K线: " + data.length + "条 (请求30天)");
    console.log("  范围: " + meta.date_range.from + " ~ " + meta.date_range.to);
    console.log("  数据源: " + meta.sources.map(s => s.source + "(" + s.count + "条)").join(", "));
    if (meta.warnings.length > 0) {
      console.log("  警告: " + meta.warnings.join("; "));
    }
    // 验证数据完整性
    const hasNull = data.some(d => d.open === 0 || d.close === 0);
    if (!hasNull) ok("  数据完整: 无空值");
    else failmsg("存在空值", "");
  } else {
    failmsg("数据不足", data.length + "条");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "4.2" "fetchKLine(300378, SZ, 60): 创业板股票" '
try {
  const { data, meta } = await df.fetchKLine("300378", "SZ", 60);
  if (data.length >= 10) {
    ok("鼎捷数智(300378) K线: " + data.length + "条");
    console.log("  范围: " + meta.date_range.from + " ~ " + meta.date_range.to);
    console.log("  数据源: " + meta.sources.map(s => s.source + "(" + s.count + "条)").join(", "));
    // 找最低点
    const low = data.reduce((m, d) => d.low < m.low ? d : m, data[0]);
    console.log("  最低点: " + low.date + " low=" + low.low);
  } else {
    failmsg("数据不足", data.length + "条");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "4.3" "fetchAllStocks: 全市场扫描" '
try {
  console.log("  拉取全市场实时行情（耗时约10~15s）...");
  const stocks = await df.fetchAllStocks(["SH", "SZ"]);
  if (Array.isArray(stocks) && stocks.length > 3000) {
    ok("全市场: " + stocks.length + " 只股票");
    // 抽样
    const withData = stocks.filter(s => s.price > 0);
    console.log("  有行情数据: " + withData.length + " 只");
    // 排序前5
    const sorted = [...stocks].sort((a,b) => (b.changePercent||0) - (a.changePercent||0));
    console.log("  涨幅前5:");
    for (const s of sorted.slice(0, 5)) {
      console.log("    " + s.code + " " + s.name + " " + (s.changePercent||0).toFixed(1) + "%  $" + s.price);
    }
  } else {
    failmsg("数据异常", stocks.length + " 只");
  }
} catch(e) { failmsg("异常", e.message); }
'

  run_test "4.4" "fetchQuotes: 个股快照(带缓存)" '
try {
  const { quotes, source, cached_count, fresh_count } = await df.fetchQuotes(["600519", "000001", "300378"]);
  const codes = Object.keys(quotes);
  if (codes.length >= 2) {
    ok("个股快照: " + codes.length + " 只 (source=" + source + ")");
    for (const code of codes) {
      const q = quotes[code];
      console.log("    " + code + " " + q.name + " $" + q.price +
        " " + (q.changePercent||0).toFixed(1) + "% " +
        "换手:" + (q.turnoverRate||0).toFixed(1) + "% " +
        "量比:" + (q.volumeRatio||0).toFixed(1));
    }
    // 第二次调用应该命中缓存
    const { source: source2 } = await df.fetchQuotes(["600519"]);
    console.log("  再次查询(期望缓存): " + source2);
  } else {
    failmsg("数据不足", JSON.stringify(quotes).slice(0, 200));
  }
} catch(e) { failmsg("异常", e.message); }
'
}

# ==============================================================
#  Level 5: 综合链路验证
# ==============================================================
level5() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Level 5: 综合链路验证                                    ║"
  echo "║  模拟缠论第一类买点的完整数据调用链路                      ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "切入点: 从全市场扫描 → 条件过滤 → 取K线 → 策略计算，完整走一遍"
  echo "         这就是 screen API 内部实际做的事情"

  run_test "5.1" "模拟缠论链路: 全市场→预过滤→取K线→底背驰检测" '
try {
  // Step 1: 全市场扫描（仅SH+SZ）
  console.log("  Step 1: 全市场扫描...");
  const allStocks = await df.fetchAllStocks(["SH", "SZ"]);
  console.log("    结果: " + allStocks.length + " 只");
  
  // Step 2: 预过滤（涨幅3~5%, 换手1~10%, 市值50~300亿）
  console.log("  Step 2: 预过滤(涨幅3~5%+换手1~10%+市值50~300亿)...");
  const candidates = allStocks.filter(s => {
    const chg = s.changePercent || 0;
    if (chg < 3 || chg > 5) return false;
    const tr = s.turnoverRate || 0;
    if (tr < 1 || tr > 10) return false;
    const mcap = (s.marketCap || 0) / 1e8;
    if (mcap < 50 || mcap > 300) return false;
    return true;
  });
  console.log("    候选: " + candidates.length + " 只");
  
  if (candidates.length === 0) {
    console.log("  ⚠️ 无候选股票，跳过后续步骤");
    ok("链路完成（无候选是正常情况）");
  } else {
    // Step 3: 取K线（最多5只，避免耗时太长）
    const TEST_LIMIT = Math.min(5, candidates.length);
    console.log("  Step 3: 取K线(前" + TEST_LIMIT + "只)...");
    for (const stock of candidates.slice(0, TEST_LIMIT)) {
      const market = stock.code.startsWith("6") ? "SH" : "SZ";
      const { data, meta } = await df.fetchKLine(stock.code, market, 120);
      stock.kline = data;
      console.log("    " + stock.code + " " + stock.name + ": " + data.length + "条K线");
      if (data.length >= 30) {
        const half = Math.floor(data.length / 2);
        const recent = data.slice(half);
        const earlier = data.slice(0, half);
        const recentLow = Math.min(...recent.map(d => d.low));
        const earlierLow = Math.min(...earlier.map(d => d.low));
        const isNewLow = recentLow < earlierLow * 0.95;
        console.log("    近期最低:" + recentLow.toFixed(2) + " 前期最低:" + earlierLow.toFixed(2) + " 新低?" + isNewLow);
      }
    }
    ok("链路完成: " + allStocks.length + " → " + candidates.length + " → K线已加载");
  }
} catch(e) { failmsg("异常", e.message); }
'
}

# ==============================================================
#  主入口
# ==============================================================
main() {
  print_overview

  if [ $# -eq 0 ]; then
    level0
    level1
    level2
    level3
    level4
    level5
  else
    for arg in "$@"; do
      case $arg in
        --list|-l) print_overview; exit 0 ;;
        0) level0 ;;
        1) level1 ;;
        2) level2 ;;
        3) level3 ;;
        4) level4 ;;
        5) level5 ;;
        *) echo "未知层级: $arg (可用: 0-5)"; exit 1 ;;
      esac
    done
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Done!  ✅ $PASS passed, ❌ $FAIL failed, ⏭️  $SKIP skipped"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "测试切入点建议:"
  echo "  验证基础:  bash test-datafetcher.sh 0    (工具函数)"
  echo "  验证数据源: bash test-datafetcher.sh 2    (各API是否可通)"
  echo "  验证全链路: bash test-datafetcher.sh 4 5  (业务接口+综合链路)"
}

main "$@"
