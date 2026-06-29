// stock-info.ts - 从腾讯 API 获取股票数据（早期数据加载/插件用）

const iconv = require('iconv-lite');
const STOCK_LIST_FILE = require('path').resolve(__dirname, '../../data/stock_list.json');
const CACHE_TTL = 30000;
let cache: { data: any[]; time: number } | null = null;

const BATCH_SIZE = 500;

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

export async function getStocks(): Promise<any[]> {
  if (cache && Date.now() - cache.time < CACHE_TTL) return cache.data;

  const allCodes = loadStockList();
  if (!allCodes.length) {
    if (cache) return cache.data;
    return [];
  }

  try {
    const allData: any[] = [];

    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      const batch = allCodes.slice(i, i + BATCH_SIZE);
      if (i > 0) await new Promise(r => setTimeout(r, 200));

      const items = batch.map((s: StockListItem) => codeToTencentSymbol(s.code)).join(',');
      const res = await fetch(`http://qt.gtimg.cn/q=${items}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const rawBuf = await res.arrayBuffer();
      const text = iconv.decode(Buffer.from(rawBuf), 'gbk');
      const lines = text.split(';');

      for (const line of lines) {
        if (!line.includes('~')) continue;
        const stock = parseTencentData(line);
        if (stock) allData.push(stock);
      }
    }

    cache = { data: allData, time: Date.now() };
    return allData;
  } catch (err) {
    console.warn('[stock-info] Tencent fetch failed:', err);
    if (cache) return cache.data;
    return [];
  }
}
