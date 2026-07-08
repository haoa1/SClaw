// stock-info.ts - 从腾讯 API 获取股票数据（早期数据加载/插件用）

const iconv = require('iconv-lite');
const path = require('path');
const STOCK_LIST_FILE = path.resolve(__dirname, '../../data/stock_list.json');
const CACHE_TTL = 10000;  // 30s -> 10s
let cache: { data: any[]; time: number } | null = null;

const BATCH_SIZE = 500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface StockListItem {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
}

function loadStockList(): StockListItem[] {
  try {
    const fs = require('fs');
    if (fs.existsSync(STOCK_LIST_FILE)) {
      return JSON.parse(fs.readFileSync(STOCK_LIST_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function codeToTencentSymbol(code: string): string {
  if (code.startsWith('6') || code.startsWith('9')) return 'sh' + code;
  if (code.startsWith('8') || code.startsWith('4')) return 'bj' + code;
  return 'sz' + code;
}

function detectMarket(code: string): string {
  if (code.startsWith('6') || code.startsWith('9')) return 'SH';
  if (code.startsWith('0') || code.startsWith('3')) return 'SZ';
  if (code.startsWith('8') || code.startsWith('4')) return 'BJ';
  return 'SZ';
}

function safeParse(val: string | undefined): number | null {
  if (val === undefined || val === '' || val === '-') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function parseTencentData(line: string): any | null {
  const parts = line.split('~');
  if (parts.length < 50) return null;

  const code = parts[2]?.trim();
  const name = parts[1]?.trim();
  if (!code || !name) return null;

  const price = parseFloat(parts[3]);
  if (isNaN(price) || price <= 0) return null;

  const changePct = safeParse(parts[32]) ?? 0;
  const volume = safeParse(parts[6]) ?? 0;
  const amount = (safeParse(parts[37]) ?? 0) * 10000;
  const turnoverRate = safeParse(parts[38]) ?? 0;
  const high = safeParse(parts[33]) ?? 0;
  const low = safeParse(parts[34]) ?? 0;
  const openPrice = safeParse(parts[5]) ?? 0;
  const close = safeParse(parts[4]) ?? 0;
  const pe = safeParse(parts[39]) ?? 0;
  const pb = safeParse(parts[46]) ?? 0;
  const totalMcap = (safeParse(parts[45]) ?? 0) * 1e8;
  const circMcap = (safeParse(parts[44]) ?? 0) * 1e8;
  const volumeRatio = safeParse(parts[49]) ?? 0;

  // avgPrice from volume/amount
  const avgPrice = volume > 0 ? amount / volume : 0;

  const changePctVal = parseFloat(changePct.toFixed(2));
  const turnoverVal = parseFloat(turnoverRate.toFixed(2));

  return {
    code, name,
    market: detectMarket(code),
    price, open: openPrice, high, low, close,
    changePct: changePctVal,
    volume, amount,
    turnover: turnoverVal,
    pe: parseFloat(pe.toFixed(2)),
    changePercent: changePctVal,
    turnoverRate: turnoverVal,
    pb,
    marketCap: totalMcap,
    circulatingMarketCap: circMcap,
    volumeRatio,
    avgPrice,
    priceAboveVwap: price > avgPrice,
  };
}

/**
 * 重试包装器：异步函数失败时自动重试
 */
async function withRetry<T>(fn: () => Promise<T>, context: string, retries = MAX_RETRIES, delayMs = RETRY_DELAY_MS): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        console.warn(`[stock-info] ${context} 第${attempt}/${retries}次失败，${delayMs}ms后重试...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError!;
}

/** 获取一批腾讯行情，带重试 */
async function fetchTencentBatch(items: string): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(`http://qt.gtimg.cn/q=${items}`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const rawBuf = await res.arrayBuffer();
    return iconv.decode(Buffer.from(rawBuf), 'gbk');
  }, 'Tencent batch');
}

export class TencentAPIError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TencentAPIError';
  }
}

const STALE_THRESHOLD_MS = 15000; // 15s: too old

/**
 * 查单只股票实时行情（不走全量缓存，直查腾讯 API）
 * 避免 detail 等场景拉取 5165 只造成浪费
 */
export async function getStockByCode(code: string): Promise<any | null> {
  const symbol = codeToTencentSymbol(code);
  const text = await fetchTencentBatch(symbol);
  const line = text.split(';')[0];
  if (!line || !line.includes('~')) return null;
  return parseTencentData(line);
}

function stampCacheAge(data: any[], cacheTime: number): any[] {
  const ageMs = Date.now() - cacheTime;
  return data.map(stock => ({ ...stock, _cacheAge: Math.round(ageMs / 1000) }));
}

export async function getStocks(): Promise<any[]> {
  if (cache && Date.now() - cache.time < CACHE_TTL) {
    return stampCacheAge(cache.data, cache.time);
  }

  const allCodes = loadStockList();
  if (!allCodes.length) {
    if (cache) return cache.data;
    throw new TencentAPIError('股票列表文件为空或不存在，无法获取行情数据');
  }

  try {
    const allData: any[] = [];

    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      const batch = allCodes.slice(i, i + BATCH_SIZE);
      if (i > 0) await new Promise(r => setTimeout(r, 200));

      const items = batch.map((s: StockListItem) => codeToTencentSymbol(s.code)).join(',');
      const text = await fetchTencentBatch(items);
      const lines = text.split(';');

      for (const line of lines) {
        if (!line.includes('~')) continue;
        const stock = parseTencentData(line);
        if (stock) allData.push(stock);
      }
    }

    cache = { data: allData, time: Date.now() };
    return stampCacheAge(allData, Date.now());
  } catch (err) {
    console.warn('[stock-info] Tencent fetch failed:', err);
    if (cache) {
      const ageS = Math.round((Date.now() - cache.time) / 1000);
      console.warn('[stock-info] Returning stale cache (' + cache.data.length + ' stocks, age ' + ageS + 's)');
      return stampCacheAge(cache.data, cache.time);
    }
    throw new TencentAPIError(
      '腾讯行情API请求失败: ' + (err instanceof Error ? err.message : String(err))
    );
  }
}
