#!/usr/bin/env python3
"""
Analysis Data Bridge — 整合脚本
==============================
整合 daisy-financial-research 的数据层（AKShare 基本面）+
stock-analysis-team 的价格/技术分析，输出统一的 JSON 供分析使用。

数据链路：
  1. 价格+技术数据 → market_data_fetcher_cn.py（腾讯行情+新浪K线+ta 指标）
  2. 基本面数据     → AKShare stock_financial_abstract（财务摘要）
                      + AKShare stock_financial_analysis_indicator（财务指标）
                      + AKShare stock_individual_basic_info_xq（公司信息）
  3. 统一输出       → 合并 JSON

用法：
  python scripts/analysis_data_bridge.py --symbol 600519.SH --market cn [--output report.json]
"""

import argparse
import json
import subprocess
import sys
import os
from datetime import datetime, timedelta

# 清除代理环境变量，防止东方财富/雪球等 API 被代理拦截
# 如需代理，在调用时手动 export HTTP_PROXY=...
for _proxy_var in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']:
    os.environ.pop(_proxy_var, None)

import akshare as ak
import pandas as pd
import numpy as np

# ──────────────────────────────────────────
# 路径工具
# ──────────────────────────────────────────
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.join(SKILL_DIR, 'scripts')


def _run_fetcher(symbol: str, market: str) -> dict:
    """调用 market_data_fetcher_cn.py 获取价格+技术数据"""
    fetcher = os.path.join(SCRIPTS_DIR, 'market_data_fetcher_cn.py')
    try:
        result = subprocess.run(
            [sys.executable, fetcher, '--symbol', symbol, '--market', market],
            capture_output=True, text=True, timeout=60, cwd=SKILL_DIR,
        )
        if result.returncode != 0:
            err = result.stderr.strip() or f'exit code {result.returncode}'
            return {'error': f'数据获取脚本失败: {err}'}
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        return {'error': f'解析数据失败: {e}'}
    except subprocess.TimeoutExpired:
        return {'error': '数据获取脚本超时'}
    except Exception as e:
        return {'error': f'调用数据获取脚本异常: {e}'}


# ──────────────────────────────────────────
# AKShare 基本面工具
# ──────────────────────────────────────────

def _ts_code(symbol: str) -> str:
    """提取纯数字代码，如 600519.SH → 600519"""
    return symbol.replace('.SH', '').replace('.SZ', '').replace('.BJ', '').strip()


def fetch_financial_abstract(symbol: str) -> dict:
    """获取财务摘要（利润表、资产负债表、现金流等）
    返回最近4个季度的关键指标。
    """
    code = _ts_code(symbol)
    try:
        df = ak.stock_financial_abstract(symbol=code)
        if df.empty:
            return {}
    except Exception as e:
        return {'_error': f'stock_financial_abstract: {e}'}

    # 提取最近4个季度的列
    date_cols = [c for c in df.columns if c not in ['选项', '指标'] and len(str(c)) == 8]
    date_cols = sorted(date_cols, reverse=True)[:4]
    if not date_cols:
        return {}

    # 构建键值映射
    result = {'latest_quarters': date_cols}
    # 找到常用指标和利润表部分
    for _, row in df.iterrows():
        category = str(row.get('选项', ''))
        indicator = str(row.get('指标', ''))
        if not indicator:
            continue
        # 只提取关键指标
        values = {}
        for col in date_cols:
            v = row.get(col)
            if pd.notna(v):
                values[col] = round(float(v), 2) if isinstance(v, (int, float)) else str(v)
        if values:
            result[indicator] = values

    return result


def fetch_financial_indicators(symbol: str) -> dict:
    """获取财务指标（ROE, ROA, 毛利率, 净利率等）
    使用 AKShare stock_financial_analysis_indicator，返回最近2期数据。
    """
    code = _ts_code(symbol)
    try:
        df = ak.stock_financial_analysis_indicator(symbol=code, start_year='2023')
        if df.empty:
            return {}
    except Exception as e:
        return {'_error': f'stock_financial_analysis_indicator: {e}'}

    # 日期列是第一列，其余是指标数据
    date_col = '日期'
    indicator_cols = [c for c in df.columns if c != date_col]

    # 找最近2个报告期
    if df.empty:
        return {}

    # 取最近2行（最新的报告期）
    latest_rows = df.head(2)

    result = {}
    for col in indicator_cols:
        values = {}
        for _, row in latest_rows.iterrows():
            period = str(row[date_col])[:7]  # '2024-03-31' → '2024-03'
            v = row[col]
            if pd.notna(v):
                values[period] = round(float(v), 4) if isinstance(v, (int, float)) else str(v)
        if values:
            result[col] = values

    return result


def fetch_industry_info(symbol: str) -> dict:
    """获取行业分类和公司基本信息（多源降级，BS4解析新浪行业页）"""
    code = _ts_code(symbol)
    info = {}
    _proxies = {'http': '', 'https': ''}
    _headers = {'User-Agent': 'Mozilla/5.0'}

    # 源1：雪球（需要登录，部分环境可能可用）
    try:
        df = ak.stock_individual_basic_info_xq(symbol=code)
        if not df.empty:
            for _, row in df.iterrows():
                item = str(row.get('item', ''))
                value = row.get('value', '')
                if item and pd.notna(value):
                    info[item] = str(value)
            if info:
                return info
    except Exception:
        pass

    # 源2：新浪行业分类页（BeautifulSoup解析，稳定可靠）
    try:
        from bs4 import BeautifulSoup as _BS
        import requests as _req

        url = f'http://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpOtherInfo/stockid/{code}/menu_num/2.phtml'
        r = _req.get(url, timeout=10, proxies=_proxies, headers=_headers)
        r.encoding = 'gb2312'
        soup = _BS(r.text, 'html.parser')

        for table in soup.find_all('table'):
            header = table.find('td', string=lambda s: s and '所属行业板块' in str(s))
            if header:
                rows = table.find_all('tr')
                for row in rows:
                    tds = row.find_all('td')
                    if len(tds) == 2:
                        name = tds[0].get_text(strip=True)
                        if name and name not in ('所属行业板块', '点击查看', '备注：此为申万行业分类',
                                                 '同行业个股', '', '概念板块', '同概念个股'):
                            info['所属行业板块'] = name
                            break
                break

        # 再拿概念板块
        for table in soup.find_all('table'):
            header = table.find('td', string=lambda s: s and '所属概念板块' in str(s))
            if header:
                concepts = []
                rows = table.find_all('tr')
                for row in rows:
                    tds = row.find_all('td')
                    if len(tds) == 2:
                        name = tds[0].get_text(strip=True)
                        if name and name not in ('所属概念板块', '概念板块', '同概念个股', '点击查看', ''):
                            concepts.append(name)
                if concepts:
                    info['所属概念板块'] = '、'.join(concepts[:10])
                    if len(concepts) > 10:
                        info['所属概念板块'] += f'等{len(concepts)}个'
                break
    except Exception:
        pass

    # 源3：公司基本概况
    try:
        import requests as _req
        import re as _re
        url = f'http://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpInfo/stockid/{code}.phtml'
        r = _req.get(url, timeout=10, proxies=_proxies, headers=_headers)
        r.encoding = 'gb2312'
        html = r.text
        for key, pat in [
            ('公司名称', r'公司名称[：:]\s*([^<]+)'),
            ('上市市场', r'上市市场[：:]\s*([^<]+)'),
            ('上市日期', r'上市日期[：:]\s*([^<]+)'),
            ('注册资本', r'注册资本[：:]\s*([^<]+)'),
        ]:
            m = _re.search(pat, html)
            if m:
                info[key] = m.group(1).strip()
    except Exception:
        pass

    # 源4：名称兜底
    if not info:
        try:
            df = ak.stock_info_a_code_name()
            row = df[df['code'] == code]
            if not row.empty:
                info['公司名称'] = row.iloc[0]['name']
        except Exception:
            pass

    return info


# ──────────────────────────────────────────
# 实时估值（PE/PB 腾讯已有，但这里作为补充）
# ──────────────────────────────────────────
def fetch_realtime_valuation(symbol: str) -> dict:
    """从腾讯行情获取实时 PE/PB（已由 fetcher 完成，此处备用）"""
    # 已在 market_data_fetcher_cn.py 中获取，此处不再重复
    return {}


# ──────────────────────────────────────────
# 主入口
# ──────────────────────────────────────────

def build_analysis_data(symbol: str, market: str = 'cn') -> dict:
    """整合所有数据层，返回统一 JSON"""

    # 1. 价格+技术数据
    price_data = _run_fetcher(symbol, market)
    if 'error' in price_data and 'error' not in price_data.get('data', {}):
        # 某些错误直接返回
        pass

    # 2. 基本面数据（仅 A 股）
    fundamentals = {}
    if market == 'cn' or any(sfx in symbol for sfx in ['SH', 'SZ', 'BJ']):
        fundamentals['financial_abstract'] = fetch_financial_abstract(symbol)
        fundamentals['financial_indicators'] = fetch_financial_indicators(symbol)
        try:
            fundamentals['industry_info'] = fetch_industry_info(symbol)
        except Exception:
            fundamentals['industry_info'] = {}

    # 3. 合并输出
    output = {
        'meta': {
            'symbol': symbol,
            'market': market,
            'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'data_sources': [
                'market_data_fetcher_cn.py (Tencent+Sina price + ta technicals)',
                'AKShare stock_financial_abstract',
                'AKShare stock_financial_analysis_indicator',
                'AKShare stock_individual_basic_info_xq',
            ],
        },
        'price_technical': price_data,
        'fundamentals': fundamentals,
    }

    # 如果价格数据有 error，标记
    if 'error' in price_data:
        output['status'] = 'partial'
        output['error'] = price_data['error']
    else:
        output['status'] = 'ok'

    return output


def main():
    parser = argparse.ArgumentParser(
        description='A股分析数据桥接 — 整合价格/技术/基本面数据',
    )
    parser.add_argument('--symbol', required=True, help='股票代码 (如 600519.SH)')
    parser.add_argument('--market', default='cn', choices=['cn', 'us'], help='市场')
    parser.add_argument('--output', '-o', help='输出 JSON 文件路径 (可选，默认 stdout)')
    args = parser.parse_args()

    data = build_analysis_data(args.symbol, args.market)

    json_str = json.dumps(data, indent=2, ensure_ascii=False, default=str)

    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)) or '.', exist_ok=True)
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(json_str)
        print(f'✅ 数据已保存到 {args.output}')
    else:
        print(json_str)


if __name__ == '__main__':
    main()
