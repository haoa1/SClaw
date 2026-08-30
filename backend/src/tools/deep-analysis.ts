/**
 * Deep Analysis Tool — run_deep_analysis(strategy_id, limit?)
 *
 * One-shot tool that:
 * 1. Runs screening via POST /api/screen
 * 2. Fetches K-line data via GET /api/stock/:code/kline
 * 3. Returns structured JSON with pre-computed technical metrics
 *
 * The agent analyzes the returned data for 缠论/筹码 signals.
 */

import { Tool, ToolParamDef, ToolRegistry } from "./registry";

async function httpPost(path: string, body: object): Promise<any> {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port: 3001, path, method: "POST",
        headers: { "Content-Type": "application/json" } },
      (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function httpGet(path: string): Promise<any> {
  const http = require("http");
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3001${path}`, (res: any) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on("error", reject);
  });
}

export interface KLinePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  changePct?: number;
  turnoverRate?: number;
}

// ===== EMA (Exponential Moving Average) =====
function ema(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  let emaValue = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(emaValue);
  for (let i = period; i < data.length; i++) {
    emaValue = (data[i] - emaValue) * multiplier + emaValue;
    result.push(emaValue);
  }
  return result;
}

// ===== Chan Theory Pivot Detection =====
function findPivots(closes: number[], left: number, right: number): { high: number[]; low: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = left; i < closes.length - right; i++) {
    // Pivot high: center is higher than both left and right neighbors
    let isHigh = true;
    for (let j = 1; j <= left; j++) { if (closes[i] <= closes[i - j]) { isHigh = false; break; } }
    if (isHigh) for (let j = 1; j <= right; j++) { if (closes[i] <= closes[i + j]) { isHigh = false; break; } }
    if (isHigh) highs.push(i);
    // Pivot low: center is lower than both left and right neighbors
    let isLow = true;
    for (let j = 1; j <= left; j++) { if (closes[i] >= closes[i - j]) { isLow = false; break; } }
    if (isLow) for (let j = 1; j <= right; j++) { if (closes[i] >= closes[i + j]) { isLow = false; break; } }
    if (isLow) lows.push(i);
  }
  return { high: highs, low: lows };
}

export function computeMetrics(klineData: KLinePoint[]): Record<string, unknown> {
  const closes = klineData.map(d => d.close).filter(c => c > 0);
  const volumes = klineData.map(d => d.volume).filter(v => v > 0);
  const highs = klineData.map(d => d.high).filter(h => h > 0);
  const lows = klineData.map(d => d.low).filter(l => l > 0);
  const opens = klineData.map(d => d.open).filter(o => o > 0);

  if (closes.length === 0) return {};

  const latestClose = closes[closes.length - 1];
  const avgVolume = volumes.length > 0
    ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const latestVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;

  const ma = (n: number) =>
    closes.length >= n
      ? closes.slice(-n).reduce((a, b) => a + b, 0) / n
      : latestClose;

  const ma5 = ma(5);
  const ma20 = ma(20);
  const ma60 = ma(60);

  // Price range
  const maxClose = Math.max(...closes);
  const minClose = Math.min(...closes);
  const priceRange = maxClose - minClose;

  // Position within range (0 = at bottom, 1 = at top)
  const rangePosition = priceRange > 0 ? (latestClose - minClose) / priceRange : 0.5;

  // Volatility (standard deviation of returns)
  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance);

  // Volume trend: compare recent 5-day avg volume to 20-day avg
  const vol5 = volumes.length >= 5
    ? volumes.slice(-5).reduce((a, b) => a + b, 0) / 5 : avgVolume;
  const vol20 = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : avgVolume;
  const volumeTrend = vol20 > 0 ? vol5 / vol20 : 1;

  // Count up/down days
  const upDays = closes.slice(1).filter((c, i) => c > closes[i]).length;
  const downDays = closes.slice(1).filter((c, i) => c < closes[i]).length;

  // ===== MACD =====
  let macd: { dif: number; dea: number; histogram: number } | null = null;
  if (closes.length >= 26) {
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const minLen = Math.min(ema12.length, ema26.length);
    if (minLen >= 1) {
      const difs: number[] = [];
      for (let i = 0; i < minLen; i++) {
        difs.push(ema12[ema12.length - minLen + i] - ema26[ema26.length - minLen + i]);
      }
      const deaValues = ema(difs, 9);
      const dif = difs[difs.length - 1];
      const dea = deaValues.length > 0 ? deaValues[deaValues.length - 1] : dif;
      macd = {
        dif: Math.round(dif * 100) / 100,
        dea: Math.round(dea * 100) / 100,
        histogram: Math.round(2 * (dif - dea) * 100) / 100,
      };
    }
  }

  // ===== Chan Theory: Pivot + Divergence + Zhongshu =====
  let chanDivergence: { topDivergence: number; bottomDivergence: number; lastPivotType: string; zhongshuCount: number } | null = null;
  if (closes.length >= 30 && macd) {
    const pivots = findPivots(closes, 2, 2);
    const { high: pivotHighs, low: pivotLows } = pivots;

    // Merge pivots in chronological order as alternating high/low sequence
    // Chan theory: sequence of pivots should alternate (high → low → high → low)
    type PivotPoint = { index: number; price: number; type: 'high' | 'low' };
    const merged: PivotPoint[] = [];
    let hi = 0, li = 0;
    // Find first pivot — whichever comes first
    let nextIdx = -1;
    if (pivotHighs.length > 0 && pivotLows.length > 0) {
      nextIdx = pivotHighs[0] < pivotLows[0] ? pivotHighs[hi++] : pivotLows[li++];
      merged.push({ index: nextIdx, price: closes[nextIdx], type: pivotHighs[0] < pivotLows[0] ? 'high' : 'low' });
    } else if (pivotHighs.length > 0) {
      nextIdx = pivotHighs[hi++];
      merged.push({ index: nextIdx, price: closes[nextIdx], type: 'high' });
    } else if (pivotLows.length > 0) {
      nextIdx = pivotLows[li++];
      merged.push({ index: nextIdx, price: closes[nextIdx], type: 'low' });
    }
    // Alternate: if last was high, next must be low, etc.
    while (hi < pivotHighs.length || li < pivotLows.length) {
      const lastType = merged.length > 0 ? merged[merged.length - 1].type : 'low';
      if (lastType === 'high') {
        // Need a low next
        while (li < pivotLows.length && pivotLows[li] <= merged[merged.length - 1].index) li++;
        if (li < pivotLows.length) {
          // Check for better low (lower price) before taking the next available
          let bestLi = li;
          for (let j = li + 1; j < pivotLows.length; j++) {
            if (closes[pivotLows[j]] < closes[pivotLows[bestLi]]) bestLi = j;
          }
          merged.push({ index: pivotLows[bestLi], price: closes[pivotLows[bestLi]], type: 'low' });
          li = bestLi + 1;
        } else break;
      } else {
        // Need a high next
        while (hi < pivotHighs.length && pivotHighs[hi] <= merged[merged.length - 1].index) hi++;
        if (hi < pivotHighs.length) {
          let bestHi = hi;
          for (let j = hi + 1; j < pivotHighs.length; j++) {
            if (closes[pivotHighs[j]] > closes[pivotHighs[bestHi]]) bestHi = j;
          }
          merged.push({ index: pivotHighs[bestHi], price: closes[pivotHighs[bestHi]], type: 'high' });
          hi = bestHi + 1;
        } else break;
      }
    }

    // Compute MACD histogram area for each segment between pivots
    // Need full histogram array for area calculation
    // Recompute DIFs and DEA aligned to closes
    const ema12All = ema(closes, 12);
    const ema26All = ema(closes, 26);
    const len = Math.min(ema12All.length, ema26All.length);
    const allDifs: number[] = [];
    for (let i = 0; i < len; i++) {
      allDifs.push(ema12All[ema12All.length - len + i] - ema26All[ema26All.length - len + i]);
    }
    const deaAll = ema(allDifs, 9);
    const histAll: number[] = allDifs.map((d, i) => 2 * (d - (deaAll[i] ?? d)));
    // Align histAll to closes: histAll starts at index (closes.length - len) in closes space
    const histOffset = closes.length - len;

    // Function to get MACD柱 area (sum of absolute histogram values) between two close indices
    const histArea = (startIdx: number, endIdx: number): number => {
      let area = 0;
      for (let i = startIdx; i < endIdx && i < closes.length; i++) {
        const hi = i - histOffset;
        if (hi >= 0 && hi < histAll.length) area += Math.abs(histAll[hi]);
      }
      return area;
    };

    // Count zhongshu (中枢): overlapping zones between consecutive up-down segments
    // A 中枢 is formed when 3 consecutive segments overlap
    let zhongshuCount = 0;
    if (merged.length >= 4) {
      for (let i = 0; i <= merged.length - 4; i += 2) {
        const seg1High = Math.max(merged[i].price, merged[i + 1].price);
        const seg1Low = Math.min(merged[i].price, merged[i + 1].price);
        const seg2High = Math.max(merged[i + 2].price, merged[i + 3].price);
        const seg2Low = Math.min(merged[i + 2].price, merged[i + 3].price);
        // Check overlap
        const overlapHigh = Math.min(seg1High, seg2High);
        const overlapLow = Math.max(seg1Low, seg2Low);
        if (overlapHigh > overlapLow) zhongshuCount++;
      }
    }

    // Divergence detection: compare last 2 same-direction segments
    let topDivergence = 0;
    let bottomDivergence = 0;
    let lastPivotType = merged.length > 0 ? merged[merged.length - 1].type : 'none';

    if (merged.length >= 4) {
      // Top divergence: compare last 2 up moves (high[i-2]→high[i] vs high[i]→high[i+2])
      const lastUpSegEnd = merged[merged.length - 1].type === 'high' ? merged.length - 1 : merged.length - 2;
      if (lastUpSegEnd >= 3) {
        const upSeg1Start = merged[lastUpSegEnd - 3];
        const upSeg1End = merged[lastUpSegEnd - 1];
        const upSeg2Start = merged[lastUpSegEnd - 1];
        const upSeg2End = merged[lastUpSegEnd];
        const price1 = upSeg1End.price - upSeg1Start.price;
        const price2 = upSeg2End.price - upSeg2Start.price;
        const area1 = histArea(upSeg1Start.index, upSeg1End.index);
        const area2 = histArea(upSeg2Start.index, upSeg2End.index);
        // Top divergence: price2 > price1 but area2 < area1 * 0.8
        if (price2 > price1 * 0.9 && area2 < area1 * 0.8 && area1 > 0) topDivergence = 1;
      }

      // Bottom divergence: compare last 2 down moves
      const lastDownSegEnd = merged[merged.length - 1].type === 'low' ? merged.length - 1 : merged.length - 2;
      if (lastDownSegEnd >= 3) {
        const downSeg1Start = merged[lastDownSegEnd - 3];
        const downSeg1End = merged[lastDownSegEnd - 1];
        const downSeg2Start = merged[lastDownSegEnd - 1];
        const downSeg2End = merged[lastDownSegEnd];
        const price1 = downSeg1Start.price - downSeg1End.price;
        const price2 = downSeg2Start.price - downSeg2End.price;
        const area1 = histArea(downSeg1Start.index, downSeg1End.index);
        const area2 = histArea(downSeg2Start.index, downSeg2End.index);
        // Bottom divergence: price2 > price1 but area2 < area1 * 0.8
        if (price2 > price1 * 0.9 && area2 < area1 * 0.8 && area1 > 0) bottomDivergence = 1;
      }
    }

    chanDivergence = {
      topDivergence,
      bottomDivergence,
      lastPivotType,
      zhongshuCount,
    };
  }

  // Highest high and lowest low in recent 20 days
  const recent20 = klineData.slice(-20);
  const recentHigh = Math.max(...recent20.map(d => d.high).filter(h => h > 0), latestClose);
  const recentLow = Math.min(...recent20.map(d => d.low).filter(l => l > 0), latestClose);

  // ===== 筹码分析指标 =====

  // 1. VWAP (成交量加权均价) — 市场平均成本
  let totalVolPrice = 0, totalVol = 0;
  for (const d of klineData) {
    if (d.close > 0 && d.volume > 0 && d.high > 0 && d.low > 0) {
      const typicalPrice = (d.high + d.low + d.close) / 3;
      totalVolPrice += typicalPrice * d.volume;
      totalVol += d.volume;
    }
  }
  const vwap = totalVol > 0 ? totalVolPrice / totalVol : latestClose;
  const priceToVwap = totalVol > 0 ? (latestClose / vwap - 1) * 100 : 0;

  // 2. 近10日VWAP (短期成本)
  const recentKline = klineData.slice(-10);
  let recentVolPrice = 0, recentVol = 0;
  for (const d of recentKline) {
    if (d.close > 0 && d.volume > 0) {
      recentVolPrice += ((d.high + d.low + d.close) / 3) * d.volume;
      recentVol += d.volume;
    }
  }
  const recentVwap = recentVol > 0 ? recentVolPrice / recentVol : latestClose;

  // 3. 主动买盘/卖盘比 (涨量 vs 跌量)
  let upVolume = 0, downVolume = 0, flatVolume = 0;
  for (const d of klineData) {
    if (d.close > 0 && d.open > 0 && d.volume > 0) {
      if (d.close > d.open) upVolume += d.volume;
      else if (d.close < d.open) downVolume += d.volume;
      else flatVolume += d.volume;
    }
  }
  const buySellRatio = downVolume > 0 ? upVolume / downVolume : 2;
  // 净买入占比 (0~1): >0.5 =买方主导
  const netBuyRatio = totalVol > 0 ? (upVolume - downVolume) / (upVolume + downVolume) : 0;

  // 4. 近期买盘占比 (近10日)
  let recentUpVol = 0, recentDownVol = 0;
  for (const d of recentKline) {
    if (d.close > 0 && d.open > 0 && d.volume > 0) {
      if (d.close > d.open) recentUpVol += d.volume;
      else if (d.close < d.open) recentDownVol += d.volume;
    }
  }
  const recentBuyPressure = (recentUpVol + recentDownVol) > 0
    ? recentUpVol / (recentUpVol + recentDownVol) : 0.5;

  // 5. 筹码集中度估计 (将价格区间分为10档, 看成交量分布)
  const allHighs = [...highs, latestClose];
  const allLows = [...lows, latestClose];
  const overallHigh = Math.max(...allHighs);
  const overallLow = Math.min(...allLows);
  const priceStep = overallHigh > overallLow ? (overallHigh - overallLow) / 10 : 1;

  if (priceStep > 0) {
    const zoneVolumes = new Array(10).fill(0);
    for (const d of klineData) {
      if (d.high > 0 && d.low > 0 && d.close > 0 && d.volume > 0) {
        const midPrice = d.close;
        const zoneIdx = Math.min(9, Math.floor((midPrice - overallLow) / priceStep));
        zoneVolumes[zoneIdx] += d.volume;
      }
    }
    // 赫芬达尔指数 (HHI) 衡量集中度: 0~1, 越大越集中
    const totalZoneVol = zoneVolumes.reduce((a, b) => a + b, 0);
    const concentrationHHI = totalZoneVol > 0
      ? zoneVolumes.reduce((a, b) => a + (b / totalZoneVol) ** 2, 0)
      : 0;

    // 顶部/底部成交量占比
    const top3Vol = zoneVolumes.slice(-3).reduce((a, b) => a + b, 0);
    const bot3Vol = zoneVolumes.slice(0, 3).reduce((a, b) => a + b, 0);
    const topBottomRatio = bot3Vol > 0 ? top3Vol / bot3Vol : 1;

    // 当前价格所在区间的成交量占比 (看该价位是否有密集成交)
    const currentZone = Math.min(9, Math.floor((latestClose - overallLow) / priceStep));
    const currentZoneVolRatio = totalZoneVol > 0 ? zoneVolumes[currentZone] / totalZoneVol : 0;

    // 6. 获利盘比例估计 (近20日成本 vs 当前价)
    const costBasis = recentVwap; // 短期成本
    const profitRatio = (latestClose - costBasis) / costBasis;

    // 7. 量价背离检测
    // 价创新高但量萎缩 -> 背离
    const recentVolMax = Math.max(...volumes.slice(-10));
    const priceAtRecentVolMax = closes[volumes.indexOf(recentVolMax)] || latestClose;
    const priceNewHigh = latestClose >= Math.max(...closes.slice(-10));
    const volumeShrinking = latestVolume < avgVolume * 0.7;
    const divergenceSignal = priceNewHigh && volumeShrinking ? 1 : 0;

    // 8. 底部放量 (近期最大量出现在价格低位)
    const recentVolumes = volumes.slice(-20);
    const maxVolIdx = recentVolumes.indexOf(Math.max(...recentVolumes));
    const priceAtMaxVol = closes.slice(-20)[maxVolIdx] || latestClose;
    const bottomVolumeSignal = priceAtMaxVol < ma20 ? 1 : 0;

    return {
      latestClose: Math.round(latestClose * 100) / 100,
      ma5: Math.round(ma5 * 100) / 100,
      ma20: Math.round(ma20 * 100) / 100,
      ma60: Math.round(ma60 * 100) / 100,
      aboveMa5: latestClose > ma5,
      aboveMa20: latestClose > ma20,
      aboveMa60: latestClose > ma60,
      distanceToMa5: Math.round((latestClose / ma5 - 1) * 10000) / 100,
      distanceToMa20: Math.round((latestClose / ma20 - 1) * 10000) / 100,
      avgVolume: Math.round(avgVolume),
      latestVolume: Math.round(latestVolume),
      volumeRatio: avgVolume > 0 ? Math.round((latestVolume / avgVolume) * 100) / 100 : 1,
      volumeTrend: Math.round(volumeTrend * 100) / 100,
      maxClose: Math.round(maxClose * 100) / 100,
      minClose: Math.round(minClose * 100) / 100,
      rangePosition: Math.round(rangePosition * 100) / 100,
      volatility: Math.round(volatility * 10000) / 100,
      upDays, downDays,
      recentHigh: Math.round(recentHigh * 100) / 100,
      recentLow: Math.round(recentLow * 100) / 100,
      totalDays: closes.length,

      // ===== 筹码指标 =====
      vwap: Math.round(vwap * 100) / 100,
      priceToVwap: Math.round(priceToVwap * 100) / 100,  // % 偏离
      recentVwap: Math.round(recentVwap * 100) / 100,     // 近10日成本
      profitRatio: Math.round(profitRatio * 10000) / 100, // 获利比例%
      buySellRatio: Math.round(buySellRatio * 100) / 100, // 买/卖量比
      netBuyRatio: Math.round(netBuyRatio * 10000) / 100, // 净买入% (-100~+100)
      recentBuyPressure: Math.round(recentBuyPressure * 10000) / 100, // 近10日买入占比%
      concentrationHHI: Math.round(concentrationHHI * 10000) / 100,   // 筹码集中度 0~100
      currentZoneVolRatio: Math.round(currentZoneVolRatio * 10000) / 100, // 当前价区成交量占比%
      topBottomRatio: Math.round(topBottomRatio * 100) / 100,  // 顶底成交量比
      divergenceSignal,    // 量价背离信号 0/1
      bottomVolumeSignal,  // 底部放量信号 0/1

      // ===== MACD =====
      macdDif: macd?.dif ?? null,
      macdDea: macd?.dea ?? null,
      macdHistogram: macd?.histogram ?? null,

      // ===== 缠论 =====
      chanTopDivergence: chanDivergence?.topDivergence ?? null,    // 顶背驰 0/1
      chanBottomDivergence: chanDivergence?.bottomDivergence ?? null, // 底背驰 0/1
      chanLastPivotType: chanDivergence?.lastPivotType ?? null,   // 最后拐点方向 high/low/none
      chanZhongshuCount: chanDivergence?.zhongshuCount ?? null,    // 中枢数量
    };
  }

  // Fallback if priceStep is 0
  return {
    latestClose: Math.round(latestClose * 100) / 100,
    ma5: Math.round(ma5 * 100) / 100,
    ma20: Math.round(ma20 * 100) / 100,
    ma60: Math.round(ma60 * 100) / 100,
    aboveMa5: latestClose > ma5,
    aboveMa20: latestClose > ma20,
    aboveMa60: latestClose > ma60,
    distanceToMa5: Math.round((latestClose / ma5 - 1) * 10000) / 100,
    distanceToMa20: Math.round((latestClose / ma20 - 1) * 10000) / 100,
    avgVolume: Math.round(avgVolume),
    latestVolume: Math.round(latestVolume),
    volumeRatio: avgVolume > 0 ? Math.round((latestVolume / avgVolume) * 100) / 100 : 1,
    volumeTrend: Math.round(volumeTrend * 100) / 100,
    maxClose: Math.round(maxClose * 100) / 100,
    minClose: Math.round(minClose * 100) / 100,
    rangePosition: Math.round(rangePosition * 100) / 100,
    volatility: Math.round(volatility * 10000) / 100,
    upDays, downDays,
    recentHigh: Math.round(recentHigh * 100) / 100,
    recentLow: Math.round(recentLow * 100) / 100,
    totalDays: closes.length,

    // ===== MACD =====
    macdDif: macd?.dif ?? null,
    macdDea: macd?.dea ?? null,
    macdHistogram: macd?.histogram ?? null,

    // ===== 缠论 =====
    chanTopDivergence: chanDivergence?.topDivergence ?? null,
    chanBottomDivergence: chanDivergence?.bottomDivergence ?? null,
    chanLastPivotType: chanDivergence?.lastPivotType ?? null,
    chanZhongshuCount: chanDivergence?.zhongshuCount ?? null,
  };
}

// ===== Handler =====

const handler = async (args: Record<string, unknown>): Promise<string> => {
  const t0 = Date.now();
  const strategyId = (args.strategy_id as string || "chan-5filters-main").trim();
  const limit = Math.min(Math.max(1, (args.limit as number) || 10), 20);
  // Allow custom params; default to relaxed settings to get enough candidates
  const userParams = (args.params as Record<string, unknown>) || {};
  const defaultParams: Record<string, unknown> = {
    minChange: 2, maxChange: 10, minVolumeRatio: 0.8,
    minTurnover: 3, maxTurnover: 15, minMcap: 30, maxMcap: 500,
  };
  const screenParams = { ...defaultParams, ...userParams };

  const timing: Record<string, number> = {};

  try {
    // Step 1: Discover pluginId
    const t1 = Date.now();
    let pluginId = "chan-5filters-screener";
    try {
      const strategiesResp = await httpGet("/api/strategies");
      const stratList = strategiesResp?.strategies || strategiesResp || [];
      if (Array.isArray(stratList)) {
        const found = stratList.find((s: any) => s.strategyId === strategyId || s.id === strategyId);
        if (found) pluginId = found.pluginId || found.plugin_id || pluginId;
      }
    } catch {
      // fallback to default
    }
    timing.discoverPlugin = Date.now() - t1;

    // Step 2: Execute screen
    const t2 = Date.now();
    const screenResult = await httpPost("/api/screen", {
      strategies: [{ pluginId, strategyId, params: screenParams }],
    });
    timing.screen = Date.now() - t2;

    const stats = screenResult.stats || {};
    const results: any[] = screenResult.results || [];
    const topResults = results.slice(0, limit);

    // 推送结果到前端 AI 选股面板（与 run_screen 一致，WebUI 中间/AI选股列表直接显示）
    try {
      const { getCurrentUserId } = require("../request-context");
      const { pushUserAction } = require("./frontend-actions");
      const userId = getCurrentUserId();
      if (userId && topResults.length > 0) {
        pushUserAction(userId, "run_screen", {
          strategies: [{ pluginId, strategyId, params: screenParams }],
          results: topResults,
          stats,
        });
        console.log(`[DeepAnalysis] pushed run_screen action to user ${userId}: ${topResults.length} stocks`);
      }
    } catch (e: unknown) {
      console.log(`[DeepAnalysis] pushUserAction failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (topResults.length === 0) {
      timing.total = Date.now() - t0;
      return JSON.stringify({
        strategyId, totalStocks: stats.totalStocks || 0,
        matchedStocks: stats.matchedStocks || 0, stocks: [],
        timing,
        message: "No stocks matched screening criteria.",
      });
    }

    // Step 3: Fetch K-line for each top stock (sequential)
    const t3 = Date.now();
    const stocks: any[] = [];
    const klineTiming: Record<string, number> = {};
    for (const r of topResults) {
      const code = r.code || "";
      const market = code.startsWith("6") || code.startsWith("9") ? "SH"
        : code.startsWith("8") ? "BJ" : "SZ";

      const tk = Date.now();
      try {
        const klineResp = await httpGet(`/api/stock/${code}/kline?market=${market}&days=60`);
        const klineData: KLinePoint[] = klineResp?.data || [];
        const metrics = computeMetrics(klineData);
        klineTiming[code] = Date.now() - tk;

        stocks.push({
          code, name: r.name || code, market,
          screenScore: r.score || 0,
          signals: r.signals || [],
          price: r.price || 0,
          changePercent: r.changePercent || 0,
          volumeRatio: r.volumeRatio || 0,
          turnoverRate: r.turnoverRate || 0,
          ...metrics,
        });
      } catch (err: unknown) {
        klineTiming[code] = Date.now() - tk;
        stocks.push({
          code, name: r.name || code,
          screenScore: r.score || 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    timing.klineFetch = Date.now() - t3;
    timing.total = Date.now() - t0;

    // Log timing summary
    const avgKline = timing.klineFetch / stocks.length;
    console.log(`[DeepAnalysis] ${strategyId} limit=${limit} stocks=${stocks.length} | ` +
      `discover=${timing.discoverPlugin}ms screen=${timing.screen}ms ` +
      `kline=${timing.klineFetch}ms(avg=${Math.round(avgKline)}ms) total=${timing.total}ms`);

    return JSON.stringify({
      strategyId,
      totalResults: stats.totalStocks || 0,
      matchedResults: stats.matchedStocks || 0,
      analyzedCount: stocks.length,
      timing,
      stocks,
      instruction: `Analyze each stock's data for:
1. 缠论买卖点 (Chan Theory buy/sell points) — look at recentHigh/recentLow for pivot points, volumeRatio for divergence, price position relative to MAs
2. 筹码分析 (Chip distribution) — vwap=cost basis, priceToVwap=deviation from avg cost, profitRatio=estimated profit%, buySellRatio/netBuyRatio=buying vs selling pressure, concentrationHHI=chip concentration, currentZoneVolRatio=volume density at current price, divergenceSignal=divergence alert, bottomVolumeSignal=bottom volume signal
3. Re-score each stock (0-100) based on your analysis
4. Rank and present results, use send_email to send report if user requests`,
    });
  } catch (err: unknown) {
    return JSON.stringify({
      error: `Deep analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};

// ===== Tool definition =====

const params: ToolParamDef[] = [
  {
    name: "strategy_id", type: "string",
    description: `Strategy ID. Default: "chan-5filters-main". Use screen(sub_cmd="list") to discover others.`,
    required: false,
  },
  {
    name: "limit", type: "number",
    description: "Max stocks to analyze (1-20, default: 10). Lower = faster.",
    required: false,
  },
  {
    name: "params", type: "object",
    description: `Custom screen params (e.g. {"minChange":2,"maxChange":10,"minVolumeRatio":0.8}). Defaults are relaxed to get enough candidates.`,
    required: false,
  },
];

export const deepAnalysisTool = new Tool(
  "run_deep_analysis",
  `One-shot deep stock analysis. Runs screening, fetches K-line for top stocks, returns structured data with pre-computed technical metrics (MAs, volume trends, volatility).

Use when user asks for: 深度分析, 缠论分析, 筹码分析, 5条件做T, or any comprehensive stock analysis.

After calling, analyze each stock and present: 1) 缠论买卖点 signals 2) 筹码分析 3) Re-ranked scores 4) Email with send_email if requested.

Example: run_deep_analysis(strategy_id="chan-5filters-main", limit=10)`,
  params, handler,
);

export function registerDeepAnalysisTool(registry: ToolRegistry): void {
  registry.register(deepAnalysisTool);
}
