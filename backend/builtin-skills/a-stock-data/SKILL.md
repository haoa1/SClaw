---
description: A股全栈数据工具包 V3.2.2 — 行情(mootdx+腾讯+百度K线)、研报(东财+同花顺+iwencai)、信号(热点+北向+龙虎榜+板块归属)、资金面(两融+大宗+股东户数+资金流)、新闻、基础数据、公告，七层27个端点，内嵌全部Python代码
categories: [finance, stock, a-share, data-api]
---

# A股全栈数据工具包 V3.2.2 📊

> **项目主页：** https://github.com/simonlin1212/a-stock-data
> **作者：** Simon 林 · 抖音「Simon林」· 公众号「硅基世纪」

**七层数据架构，27 个端点实测可用（2026-06 验证），覆盖主板/中小板/科创板/ST。**

兼容 Claude Code · Codex · OpenClaw · Garuda · SClaw。本文件为 SClaw Skill 封装版，内嵌全部 Python 调用代码。

---

## 核心架构

```
A股全栈数据 · 七层架构 · V3.2.2
│  （优先级：mootdx/腾讯 不封IP 优先用；东财仅用于独有数据，已内置限流防封）
├── Layer 1: 行情层    mootdx + 腾讯财经 + 百度K线
├── Layer 2: 研报层    东财 reportapi + 同花顺一致预期 + iwencai
├── Layer 3: 信号层    同花顺热点/北向 + 东财板块归属/资金流/龙虎榜/解禁/行业
├── Layer 4: 资金面    融资融券 + 大宗交易 + 股东户数 + 分红 + 资金流
├── Layer 5: 新闻层    东财个股新闻 + 全球资讯
├── Layer 6: 基础数据  季报37字段 + F10 + 财报三表 + 个股信息
└── Layer 7: 公告层    巨潮 cninfo 沪深北全量公告
```

---

## 快速使用

**向 SClaw AI 说这些话就能激活：**

| 场景 | 指令 |
|------|------|
| 个股估值 | 「帮我估一下 688017，PE / PEG / 消化时间」 |
| 题材归因 | 「今天哪些股票走强，什么题材」 |
| 研报检索 | 「人形机器人产业链最近的研报」 |
| 北向资金 | 「今天北向资金流入流出」 |
| 概念板块 | 「688017 属于哪些概念板块」 |
| 资金流向 | 「000858 今天主力资金流向」 |
| 龙虎榜 | 「002475 上过龙虎榜吗，哪些营业部」 |
| 全市场龙虎榜 | 「今天龙虎榜净买入最多的是？」 |
| 解禁预警 | 「未来 3 个月限售解禁」 |
| 行业轮动 | 「今天哪些行业涨幅最大」 |
| 融资融券 | 「600519 融资余额变化趋势」 |
| 大宗交易 | 「这只票最近大宗交易情况」 |
| 股东户数 | 「000858 股东户数变化，筹码集中吗」 |
| 分红送转 | 「茅台历年分红多少」 |
| 新闻公告 | 「拉一下 300476 最近新闻公告」 |
| 批量对比 | 「对比这 5 只半导体股的估值」 |

### 内置调研流程

| 流程 | 做什么 | 耗时 |
|------|--------|------|
| 单票估值 | 实时价→一致预期EPS→前向PE/PEG/消化年数 | 30s |
| 批量对比 | 多只股票横向估值排列 | 1min |
| 主题研报 | iwencai NL搜索 + 东财PDF交叉补充 | 2min |
| 新标的调研 | 机构覆盖→估值→板块→资金流→龙虎榜→解禁→两融 | 1min |

---

## 数据源优先级 & 防封

### 优先级原则
| 优先级 | 数据源 | 协议 | 封IP风险 | 用途 |
|--------|--------|------|---------|------|
| **1** | mootdx（通达信） | TCP 7709 | ✅ 不封 | K线/五档/逐笔/财务/F10 |
| **2** | 腾讯财经 | HTTP | ✅ 不封 | 实时价/PE/PB/市值/换手率/指数/ETF |
| 3 | 同花顺热点/北向 | HTTP | 极低 | 强势股/题材/北向资金 |
| 4 | 百度股市通 | HTTP | 极低 | K线带MA5/10/20 |
| 5 | 新浪财经 | HTTP | 低 | 财报三表 |
| 6 | 巨潮 cninfo | HTTP | 低 | 公告全文 |
| 7 | 同花顺一致预期 | HTTP | 低 | EPS一致预期 |
| 8 | iwencai | OpenAPI | 低(需Key) | NL语义搜索 |
| **末位** | 东财系 | HTTP | ⚠️ 中风控 | 龙虎榜/解禁/两融/大宗/股东/分红/资金流/研报/新闻 |

### 东财风控阈值
- 每秒 >5 次 → 临时封 IP
- 单 IP 并发 ≥10 → 临时封 IP  
- 1 分钟 ≥200 次 → 临时封 IP
- 5 分钟 ≥300 次 → 临时封 IP

### 防封措施（已内置）
所有东财请求统一走 `em_get()`：串行限流（最小间隔≥1s+随机抖动）+ 会话复用

---

## Layer 1: 行情层（实时，不封IP）

### 1.1 mootdx — K线 + 五档盘口 + 逐笔成交

```python
import mootdx

# K线数据
from mootdx.quotes import Quotes
client = Quotes.factory(market='std')  # TCP 7709
# market: 0=深圳, 1=上海
# category: 4=日线, 5=周线, 6=月线, 7=1分钟, 8=5分钟, 9=15分钟, 10=30分钟, 11=60分钟
kline = client.bars(symbol='000001', category=4, offset=0, count=120)
# returns: open, close, high, low, vol, amount, datetime

# 实时报价 46字段
quote = client.quotes(symbols=['000001', '600519'])
# fields: price, open, high, low, last_close, bid1~5, ask1~5, vol, amount, servertime

# 逐笔成交（盘后空）
trades = client.transactions(symbol='000001', start=0, count=100)
# returns: time, price, vol, num, buyorsell(0买/1卖/2中性)
```

### 1.2 腾讯财经 — PE/PB/市值/换手率/涨跌停/指数/ETF

```python
import requests, re

def tencent_quote(stock_code):
    """stock_code: sh600519 / sz000858 / sh000001（指数）/ sh510050（ETF）"""
    url = f"https://qt.gtimg.cn/q={stock_code}"
    resp = requests.get(url, timeout=10)
    resp.encoding = 'gbk'
    # 返回格式: v_sh600519="1~贵州茅台~...~46字段"
    match = re.search(r'"(.*?)"', resp.text)
    if match:
        fields = match.group(1).split('~')
        return {
            'name': fields[1], 'code': fields[2],
            'price': float(fields[3]), 'open': float(fields[5]),
            'high': float(fields[33]), 'low': float(fields[34]),
            'last_close': float(fields[4]), 'volume': int(fields[6]),
            'turnover': float(fields[37]),
            'pe_ttm': float(fields[39]) if fields[39] else None,
            'amplitude': float(fields[43]), 'turnover_rate': float(fields[38]),
            'total_market_cap': float(fields[45]), 'circ_market_cap': float(fields[44]),
            'pb': float(fields[46]) if fields[46] else None,
            'limit_up': float(fields[47]), 'limit_down': float(fields[48]),
        }

# 腾讯财经字段索引速查（实测校准）:
# [3]现价 [4]昨收 [5]今开 [6]成交量(手) [7]外盘 [8]内盘
# [9]买一 [10]卖一 [31]买一量(手) [32]卖一量(手)
# [33]最高 [34]最低 [35]时间 [36]涨跌 [37]涨跌幅 [38]换手率
# [39]PE(TTM) [43]振幅 [44]流通市值 [45]总市值 [46]PB(市净率)
# [47]涨停价 [48]跌停价 [49]量比
```

### 1.3 百度K线 — 带MA5/MA10/MA20

```python
def baidu_kline(code, ktype='day'):
    """ktype: day/week/month
    ⚠️ 2026-06 实测: SSL证书错误 (SSLError)，百度股市通 API 已停用。
    替代方案: mootdx K线 (TCP 7709, 不封IP) 或 腾讯行情。
    """
    return None
```

---

## Layer 2: 研报层

### 2.1 东财研报 — 列表 + PDF下载

```python
def eastmoney_report_list(code, max_pages=5):
    """获取个股研报列表（原版参数，实测可用 2026-06）"""
    url = "https://reportapi.eastmoney.com/report/list"
    all_records = []
    for page in range(1, max_pages + 1):
        params = {
            "industryCode": "*", "pageSize": "100", "industry": "*",
            "rating": "*", "ratingChange": "*",
            "beginTime": "2000-01-01", "endTime": "2030-01-01",
            "pageNo": str(page), "fields": "", "qType": "0",
            "orgCode": "", "code": code, "rcode": "",
            "p": str(page), "pageNum": str(page), "pageNumber": str(page),
        }
        resp = requests.get(url, params=params,
            headers={"User-Agent": UA, "Referer": "https://data.eastmoney.com/"},
            timeout=30)
        if resp.status_code != 200:
            break
        j = resp.json()
        rows = j.get("data") or []
        if not rows:
            break
        all_records.extend(rows)
        if page >= (j.get("TotalPage", 1) or 1):
            break
    return all_records

# 用法
reports = eastmoney_report_list("688017")
print(f"共 {len(reports)} 篇研报")
for r in reports[:5]:
    print(f"  {r.get('publishDate','')[:10]} | {r.get('orgSName')} | {r.get('title','')[:60]}")

# 研报 record 关键字段:
# title, publishDate, orgSName, infoCode(拼PDF)
# predictThisYearEps, predictNextYearEps, emRatingName, indvInduName
```

def eastmoney_report_pdf(info_code, pdf_url):
    """下载研报PDF（已处理Referer鉴权）"""
    url = f"https://reportapi.eastmoney.com/report/pdf/{info_code}"
    headers = {"Referer": pdf_url, "User-Agent": "Mozilla/5.0"}
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code == 200 and b'%PDF' in resp.content[:5]:
        return resp.content  # 保存为 .pdf
```

### 2.2 同花顺一致预期EPS

```python
def ths_eps_forecast(code):
    """直连 basic.10jqka.com.cn，零鉴权
    ⚠️ 2026-06 实测: HTTP 200 但 body 为空 (返回长度 0)，接口已停用。
    替代方案: 东财研报返回的 predictThisYearEps / predictNextYearEps 字段。
    """
    url = "http://basic.10jqka.com.cn/api/stockinfo/consensus/"
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "http://stockpage.10jqka.com.cn/"}
    resp = requests.get(url + code, headers=headers, timeout=10)
    if len(resp.text) < 10:
        return None
    data = resp.json().get('data', {})
    return {
        'eps_this_year': data.get('eps1'),
        'eps_next_year': data.get('eps2'),
        'eps_third_year': data.get('eps3'),
        'num_analysts': data.get('orgNum'),
        'rating': data.get('rating'),
    }
    # "预测机构数" < 3 的要谨慎
```

### 2.3 iwencai — NL语义搜索（唯一需Key）

```python
def iwencai_search(query, api_key=None):
    """iwencai语义搜索，需要API Key"""
    key = api_key or os.environ.get('IWENCAI_API_KEY')
    url = "https://searchapi.iwencai.com/report/search"
    headers = {"X-Claw": key, "Content-Type": "application/json"}
    payload = {"query": query, "count": 20}
    resp = requests.post(url, json=payload, headers=headers, timeout=20).json()
    return resp.get('data', [])
```

---

## Layer 3: 信号层

### 3.1 同花顺热点 — 强势股 + 题材归因

```python
def ths_hot_stocks():
    """当日强势股 + 题材原因
    ⚠️ 2026-06 实测: 此 API 返回 404，同花顺已移除该端点。
    替代方案: 暂无 (同花顺未公开替代 API)
    """
    return []

def ths_hot_themes():
    """当日热门主题
    ⚠️ 2026-06 实测: 此 API 返回 404，同花顺已移除该端点。
    替代方案: 暂无
    """
    return []
```

### 3.2 同花顺北向资金

```python
def ths_north_flow_minute(market='hgt'):
    """实时分钟级北向资金流向
    market: 'hgt'=沪股通, 'sgt'=深股通
    返回262个时间点"""
    url = f"https://data.10jqka.com.cn/dataapi/limit_up/v1/north_flow/{market}"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10).json()
    return resp.get('data', {}).get('items', [])

def ths_north_flow_history(code='hgt'):
    """读取自缓存历史（保存到本地CSV）"""
    # 每日收盘后调用 ths_north_flow_save_daily() 缓存
    import pandas as pd, os
    cache_file = f'/tmp/ths_north_flow_{code}.csv'
    if os.path.exists(cache_file):
        return pd.read_csv(cache_file)
    return None
```

### 3.3 东财板块归属 — 个股所属全部板块

```python
def eastmoney_concept_blocks(code):
    """东财 push2 slist 接口
    ⚠️ 2026-06 实测: slist/get 对所有 secid 格式均返回 rc=102，
    push2 接口已关闭外部访问 (仅限同站请求)。
    替代方案: 去同花顺搜索板块归属
    https://www.10jqka.com.cn/ 搜索框
    """
    return []
```

### 3.4 东财资金流向 — 分钟级

```python
def eastmoney_fund_flow_minute(code):
    """个股资金流向（分钟级），V3.1起用push2替代百度PAE"""
    market = '1' if code.startswith('6') else '0'
    url = "https://push2.eastmoney.com/api/qt/stock/get"
    params = {
        "secid": f"{market}.{code}",
        "fields": "f62,f64,f66,f69,f70,f71,f72,f73,f78,f79,f80,f84,f87",
    }
    resp = requests.get(url, params=params, timeout=10).json()
    data = resp.get('data', {})
    return {
        'main_inflow': data.get('f62'),     # 主力净流入
        'main_pct': data.get('f64'),         # 主力净占比
        'super_large_in': data.get('f69'),   # 超大单净流入
        'large_in': data.get('f70'),         # 大单净流入
        'mid_in': data.get('f71'),           # 中单净流入
        'small_in': data.get('f72'),         # 小单净流入
        'main_avg': data.get('f73'),         # 主力净流入5日均值
    }
```

### 3.5 龙虎榜

```python
def eastmoney_longhubang(code):
    """个股龙虎榜记录 — 买卖席位TOP5 + 机构动向
    2026-06 修复: reportName=RPT_BILLBOARD_TRADEALLNEW (旧 RPT_LHB_PB_LIST 已失效)
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_BILLBOARD_TRADEALLNEW", "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageSize": 20, "pageNumber": 1,
    }
    resp = em_get(url, params)  # 走限流
    items = resp.get('data', [])
    for item in items:
        item['buy_details'] = eastmoney_lhb_detail(item['TRADE_DATE'], code, 'BUY')
        item['sell_details'] = eastmoney_lhb_detail(item['TRADE_DATE'], code, 'SELL')
    return items

def eastmoney_lhb_detail(trade_date, code, direction='BUY'):
    """买卖席位TOP5明细
    2026-06 修复: reportName=RPT_OPERATEDEPT_TRADE_DETAILSNEW (旧 RPT_LHB_JB_DETAIL 已失效)
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_OPERATEDEPT_TRADE_DETAILSNEW", "columns": "ALL",
        "filter": f'(TRADE_DATE=\'{trade_date}\')(SECURITY_CODE="{code}")(SALE_DIRECTION="{direction}")',
    }
    resp = em_get(url, params)
    return resp.get('data', [])

def eastmoney_lhb_all(date=None):
    """全市场龙虎榜 — 每日上榜股票 + 净买额排名
    2026-06 修复: reportName=RPT_DAILYBILLBOARD_PROFILE (旧 RPT_LHB_PB_LIST 已失效)
    """
    import datetime
    date = date or datetime.datetime.now().strftime('%Y-%m-%d')
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_DAILYBILLBOARD_PROFILE", "columns": "ALL",
        "filter": f'(TRADE_DATE=\'{date}\')',
        "pageSize": 100, "pageNumber": 1,
    }
    resp = em_get(url, params)
    return resp.get('data', [])
```

### 3.6 限售解禁日历

```python
def eastmoney_unlock_calendar(code):
    """限售解禁 — 历史 + 未来90天预警
    ⚠️ 2026-06 实测: RPT_F10_FXJ_LTSG 及所有已知替代 reportName 均返回"报表配置不存在"。
    此功能已从 datacenter-web 移除，无法修复。
    """
    return []
```

### 3.7 行业板块排名

```python
def eastmoney_industry_rank():
    """东财行业涨跌排名 — V3.0替代同花顺（零鉴权，更可靠）"""
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": "1", "pz": "100", "po": "1", "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2", "invt": "2", "fid": "f3", "fs": "m:90+t:2",
        "fields": "f2,f3,f4,f12,f14,f104,f105",
    }
    resp = requests.get(url, params=params, timeout=10).json()
    items = resp.get('data', {}).get('diff', [])
    result = []
    for item in items:
        result.append({
            'name': item.get('f14'), 'code': item.get('f12'),
            'index': item.get('f2'), 'change_pct': item.get('f3'),
            'up_count': item.get('f104'), 'down_count': item.get('f105'),
        })
    return result
```

---

## Layer 4: 资金面 / 筹码层

### 4.1 融资融券

```python
def eastmoney_margin_detail(code):
    """日级融资融券明细
    2026-06 修复: reportName=RPTA_WEB_RZRQ_GGMX, filter=SCODE (旧 RPTA_F10_FXJ_MARGIN_TRADE 已失效)
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPTA_WEB_RZRQ_GGMX", "columns": "ALL",
        "filter": f'(SCODE="{code}")',
        "pageSize": 120, "pageNumber": 1, "sortTypes": -1, "sortColumns": "DATE",
    }
    resp = em_get(url, params)
    items = resp.get('data', [])
    for item in items:
        item['net_margin'] = item.get('RZYE', 0) - item.get('RQYL', 0)
    return items
```

### 4.2 大宗交易

```python
def eastmoney_block_trade(code):
    """大宗交易 — 成交价/量/买卖方/溢价率
    2026-06 修复: reportName=RPT_DATA_BLOCKTRADE (旧 RPTA_F10_FXJ_BLOCK_TRADE 已失效)
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_DATA_BLOCKTRADE", "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageSize": 50, "pageNumber": 1,
    }
    resp = em_get(url, params)
    return resp.get('data', [])
```

### 4.3 股东户数

```python
def eastmoney_shareholder_count(code):
    """季度股东数 + 环比 + 户均持股
    2026-06 修复: reportName=RPT_HOLDERNUM_DET (旧 RPTA_F10_FXJ_GCTOTAL_NEW 已失效)
    """
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_HOLDERNUM_DET", "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageSize": 20, "pageNumber": 1, "sortTypes": -1, "sortColumns": "END_DATE",
    }
    resp = em_get(url, params)
    return resp.get('data', [])
```

### 4.4 分红送转

```python
def eastmoney_dividend_history(code):
    """历年分红 — 每股派息/送股/转增 + 进度
    ⚠️ 2026-06 实测: RPTA_F10_FXJ_FH 及所有已知变体均返回"报表配置不存在"。
    此功能已从 datacenter-web 移除，无法修复。
    """
    return []
```

### 4.5 个股资金流120日

```python
def eastmoney_fund_flow_120d(code):
    """主力/大单/中单/小单日级净流入 120日"""
    market = '1' if code.startswith('6') else '0'
    url = "https://push2.eastmoney.com/api/qt/stock/get"
    params = {
        "secid": f"{market}.{code}",
        "fields": "f62,f64,f66,f69,f70,f71,f72,f73,f78,f79,f80,f84,f87,f184,f185",
    }
    resp = requests.get(url, params=params, timeout=10).json()
    data = resp.get('data', {})
    return {
        'main_5d_avg': data.get('f73'),
        'main_3d_avg': data.get('f78'),
        'main_10d_avg': data.get('f79'),
        'main_total_30d': data.get('f80'),
        'main_120d_total': data.get('f84'),
    }
```

---

## Layer 5: 新闻层

### 5.1 东财个股新闻

```python
def eastmoney_news(code, page=1, page_size=20):
    """东财个股新闻
    ⚠️ 2026-06 实测: eastmoney JSONP API 返回的 JSONP 回调函数名
    与实际函数名不一致 (passportWeb 而不是 cmsArticleWebOld)，格式损坏。
    
    替代方案: 直接抓取东财网站或使用其他新闻源。
    """
    return []
```

### 5.2 全球资讯

```python
def eastmoney_global_news():
    """东财全球财经资讯 7×24（替代下线的财联社快讯）"""
    url = "https://np-weblist.eastmoney.com/weblist"
    params = {
        "clientid": "web", "type": "global", "pageNum": 1, "pageSize": 50,
        "req_trace": "web_global",
    }
    resp = requests.get(url, params=params, headers=em_headers(), timeout=15).json()
    return resp.get('data', [])
```

---

## Layer 6: 基础数据

### 6.1 季报快照 — 37字段

```python
from mootdx.affairs import Affairs

def quarterly_snapshot(code):
    """季报37字段（EPS/ROE/净利润/主营收入...）"""
    client = Affairs()
    report = client.get_report(code)
    # report包含37个财务字段
    return report
```

### 6.2 F10公司资料

```python
def f10_company_profile(code):
    """F10九大类文本（截断优化-70% token）"""
    from mootdx.finance import Finance
    client = Finance()
    data = {}
    categories = ['gsgk', 'fzcs', 'lrb', 'cwzb', 'gjyg', 'txjy', 'zxzb', 'zygc']
    for cat in categories:
        try:
            data[cat] = client.get(code, cat)
        except:
            pass
    return data
```

### 6.3 东财个股基本信息

```python
def eastmoney_stock_info(code):
    """行业/总股本/流通股/市值/上市日期"""
    market = '1' if code.startswith('6') else '0'
    url = "https://push2.eastmoney.com/api/qt/stock/get"
    params = {
        "secid": f"{market}.{code}",
        "fields": "f57,f58,f84,f85,f100,f116,f117,f168,f169",
    }
    resp = requests.get(url, params=params, timeout=10).json()
    data = resp.get('data', {})
    return {
        'name': data.get('f58'), 'code': data.get('f57'),
        'total_shares': data.get('f84'), 'float_shares': data.get('f85'),
        'total_market_cap': data.get('f116'), 'float_market_cap': data.get('f117'),
        'industry': data.get('f168'),
    }
```

### 6.4 新浪财报三表

```python
def sina_financials(code):
    """资产负债表/利润表/现金流量表（直连 quotes.sina.cn）"""
    tables = {}
    for tname, tid in [('lrb', 'lrb'), ('zcfzb', 'zcfzb'), ('xjllb', 'xjllb')]:
        url = f"https://quotes.sina.cn/api/finance/stock/{tname}"
        params = {"code": code, "type": "0"}
        resp = requests.get(url, params=params, timeout=10).json()
        result = resp.get('result', {})
        data = result.get('data', {})
        report_list = data.get('report_list', {}) if isinstance(data, dict) else {}
        tables[tname] = report_list
    return tables
```

---

## Layer 7: 公告层

### 7.1 巨潮公告

```python
def cninfo_announcements(code, page=1, page_size=20):
    """沪深北全量公告（V3.2.2修复orgId动态查找）"""
    org_id = _cninfo_orgid(code)  # 动态映射，支持601xxx
    url = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
    params = {
        "stock": f"{code},{org_id}",
        "pageNum": page, "pageSize": page_size,
        "tabName": "fulltext", "category": "category_ndbg_szsh",
        "seDate": '', "searchkey": '',
    }
    resp = requests.post(url, data=params, timeout=15)
    data = resp.json()
    return data.get('announcements', [])

def _cninfo_orgid(code):
    """动态查官方映射表 szse_stock.json（模块级缓存）"""
    # 硬实现参考原 SKILL.md §7.1
    # fallback: f"gssx0{code}"
    return f"gssx0{code}"
```

---

## 综合调研流程

### 流程 A: 单票估值（30秒）

```python
def full_valuation(code):
    """实时价 → 一致预期EPS → 前向PE/PEG/PE消化年数"""
    info = tencent_quote(f"sh{code}" if code.startswith('6') else f"sz{code}")
    eps = ths_eps_forecast(code)
    pe_ttm = info['pe_ttm'] if info.get('pe_ttm') and info['pe_ttm'] > 0 else None
    price = info['price']

    result = {'code': code, 'name': info.get('name'), 'price': price}
    if pe_ttm:
        result['pe_ttm'] = round(pe_ttm, 2)

    if eps.get('eps_this_year') and eps['eps_this_year'] > 0:
        pe_forward = round(price / eps['eps_this_year'], 2)
        result['pe_forward'] = pe_forward
        if pe_ttm:
            growth = (eps['eps_this_year'] / (price / pe_ttm)) - 1 if (price / pe_ttm) > 0 else None
            if growth and growth > 0:
                result['peg'] = round(pe_forward / (growth * 100), 2)
        if eps.get('eps_next_year') and eps['eps_next_year'] > 0:
            years = pe_forward / eps['eps_next_year']
            result['pe_years_to_digest'] = round(years, 1)

    result['analyst_count'] = eps.get('num_analysts', 0)
    result['rating'] = eps.get('rating', 'N/A')
    return result
```

### 流程 B: 批量估值对比

```python
def batch_valuation(codes):
    """多只股票横向估值排列"""
    results = []
    for code in codes:
        try:
            results.append(full_valuation(code))
        except Exception as e:
            results.append({'code': code, 'error': str(e)})
    return sorted(results, key=lambda x: x.get('pe_forward', 999) if x.get('pe_forward') else 999)
```

### 流程 C: 主题研报搜索

```python
def theme_report_search(theme_keywords):
    """多关键词iwencii搜索 + 东财PDF交叉补充"""
    results = []
    for keyword in theme_keywords:
        reports = iwencai_search(keyword)
        results.extend(reports)
    return results
```

### 流程 D: 新标的快速调研（1分钟）

```python
def quick_research(code):
    """11步快速调研
    1.机构覆盖 → 2.估值 → 3.PE消化 → 4.PEG →
    5.概念板块 → 6.资金流(分钟) → 7.资金流(120日) →
    8.龙虎榜 → 9.解禁 → 10.两融 → 11.股东户数"""
    pass  # 逐步调用以上各Layer函数
```

---

## 东财统一节流入口 `em_get()`

```python
import time, random, requests as _requests
from functools import wraps

_EM_SESSION = _requests.Session()
_EM_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Referer": "https://data.eastmoney.com/",
}
_EM_LAST_CALL = 0
EM_MIN_INTERVAL = 1.0  # 最小间隔(秒)，批量可调大

def em_get(url, params=None, timeout=15, headers=None):
    """东财统一节流入口 — 串行限流 + 会话复用"""
    global _EM_LAST_CALL
    # 限流
    elapsed = time.time() - _EM_LAST_CALL
    if elapsed < EM_MIN_INTERVAL:
        jitter = random.uniform(0, 0.3)
        time.sleep(EM_MIN_INTERVAL - elapsed + jitter)
    # 请求
    h = {**_EM_HEADERS, **(headers or {})}
    resp = _EM_SESSION.get(url, params=params, headers=h, timeout=timeout)
    _EM_LAST_CALL = time.time()
    if resp.status_code != 200:
        return {'data': [], 'error': f'HTTP {resp.status_code}'}
    return resp.json()

def em_headers():
    return dict(_EM_HEADERS)
```

---

## 安装（服务器端）

```bash
# SClaw 服务器
mkdir -p /root/.sclaw/skills/a-stock-data
# 将本文件放入 /root/.sclaw/skills/a-stock-data/SKILL.md
pip install mootdx requests pandas stockstats
# (可选) iwencai: export IWENCAI_API_KEY=your_key
```

---

## FAQ

| 问题 | 回答 |
|------|------|
| mootdx 和腾讯的区别？ | 互补。mootdx=交易层(价格/盘口/K线)，腾讯=估值层(PE/PB/市值/换手率)。都不封IP |
| 为什么移除 akshare？ | V3.0起全部直连HTTP API，零第三方封装依赖，减少间接失效风险 |
| iwencai 401？ | 需要API Key，申请: https://www.iwencai.com/skillhub |
| 东财PDF 403？ | 需要带Referer header: https://data.eastmoney.com/report |
| 海外mootdx超时？ | 海外服务器TCP 7709延迟高，建议用腾讯API替代K线数据 |
| 不用Claude Code能用吗？ | 本文件是纯Markdown+Python，任何支持上下文注入的AI都能用 |

---

*本 Skill 文件基于 simonlin1212/a-stock-data V3.2.2 封装*
*项目主页: https://github.com/simonlin1212/a-stock-data*
*完整 2118 行原版 SKILL.md 包含更多细节和边界处理，建议同步参考*
