/**
 * 缠论引擎核心算法
 * 分型 → 笔 → 线段 → 中枢 → 趋势 → 背驰 → 买卖点
 * 参照缠中说禅理论 + 现有 chan-buy-points 插件实现
 */
import {
  KLine, MergedK, Fractal, Bi, Segment, ZhongShu,
  TradePoint, Divergence, MacdPoint, ChanAnalysis,
} from './types';

// ==================== MACD ====================

export function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    if (i === 0) result.push(values[i]);
    else result.push((values[i] - result[i - 1]) * k + result[i - 1]);
  }
  return result;
}

export function computeMACD(closes: number[], fast = 12, slow = 26, signal = 9): { dif: number[]; dea: number[]; macd: number[] } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = emaFast.map((v, i) => v - emaSlow[i]);
  const dea = ema(dif, signal);
  const macd = dif.map((v, i) => 2 * (v - dea[i]));
  return { dif, dea, macd };
}

// ==================== 包含关系处理 ====================

/**
 * K线包含关系合并
 * 缠论第65课：相邻K线有包含关系时（一根的高低点完全在另一根范围内），
 * 按方向合并。向上时取高高（max high, max low），向下时取低低（min high, min low）。
 */
export function mergeKlines(klines: KLine[]): MergedK[] {
  if (klines.length === 0) return [];
  const merged: MergedK[] = [];
  // 第一根，方向待定
  let cur: MergedK = {
    idx: 0, high: klines[0].high, low: klines[0].low,
    startIdx: 0, endIdx: 0, dir: 1,
  };
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    const hasContain = (k.high <= cur.high && k.low >= cur.low) || (k.high >= cur.high && k.low <= cur.low);
    if (hasContain) {
      // 方向未知时，根据与上一根合并K线比较确定
      if (merged.length > 0) {
        const prev = merged[merged.length - 1];
        cur.dir = cur.high >= prev.high ? 1 : -1;
      } else if (i >= 2) {
        cur.dir = klines[i - 1].high >= klines[i - 2].high ? 1 : -1;
      }
      if (cur.dir === 1) {
        cur.high = Math.max(cur.high, k.high);
        cur.low = Math.max(cur.low, k.low);
      } else {
        cur.high = Math.min(cur.high, k.high);
        cur.low = Math.min(cur.low, k.low);
      }
      cur.idx = i;
      cur.endIdx = i;
    } else {
      // 无包含，提交当前合并K线，开始新的
      merged.push(cur);
      cur = {
        idx: i, high: k.high, low: k.low, startIdx: i, endIdx: i, dir: 1,
      };
    }
  }
  merged.push(cur);
  return merged;
}

// ==================== 分型 ====================

/** 顶分型：中间K线高点最高 */
export function isTopFractal(prev: MergedK, cur: MergedK, next: MergedK): boolean {
  return cur.high > prev.high && cur.high > next.high;
}

/** 底分型：中间K线低点最低 */
export function isBottomFractal(prev: MergedK, cur: MergedK, next: MergedK): boolean {
  return cur.low < prev.low && cur.low < next.low;
}

/** 在合并K线上识别分型 */
export function findFractals(merged: MergedK[], klines: KLine[]): Fractal[] {
  const fractals: Fractal[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    const next = merged[i + 1];
    if (isTopFractal(prev, cur, next)) {
      fractals.push({
        type: 'top', idx: cur.idx, high: cur.high, low: cur.low, mergedIdx: i,
        strength: cur.high - Math.max(prev.high, next.high),
      });
    } else if (isBottomFractal(prev, cur, next)) {
      fractals.push({
        type: 'bottom', idx: cur.idx, high: cur.high, low: cur.low, mergedIdx: i,
        strength: Math.min(prev.low, next.low) - cur.low,
      });
    }
  }
  return fractals;
}

// ==================== 笔 ====================

/**
 * 由分型构建笔
 * 规则：顶底交替，且顶底分型之间至少间隔 1 根合并K线（即至少 3 根合并K线 → 至少 5 根原始K线）
 */
export function buildBis(fractals: Fractal[], klines: KLine[]): Bi[] {
  const bis: Bi[] = [];
  if (fractals.length < 2) return bis;
  let prev = fractals[0];
  for (let i = 1; i < fractals.length; i++) {
    const cur = fractals[i];
    // 必须交替
    if (cur.type === prev.type) {
      // 同类型分型，保留更极端者
      if (cur.type === 'top' && cur.high > prev.high) prev = cur;
      else if (cur.type === 'bottom' && cur.low < prev.low) prev = cur;
      continue;
    }
    // 至少间隔 3 根合并K线（保证笔的成立）
    const mergedGap = cur.mergedIdx - prev.mergedIdx;
    if (mergedGap < 3) {
      continue;
    }
    const direction: 'up' | 'down' = cur.type === 'top' ? 'up' : 'down';
    const startPrice = direction === 'up' ? prev.low : prev.high;
    const endPrice = direction === 'up' ? cur.high : cur.low;
    // 验证：笔内K线数（原始K线至少5根）
    const klineCount = cur.idx - prev.idx + 1;
    bis.push({
      direction,
      start: fractals.indexOf(prev),
      end: i,
      startIdx: prev.idx,
      endIdx: cur.idx,
      startPrice,
      endPrice,
      high: Math.max(prev.high, cur.high),
      low: Math.min(prev.low, cur.low),
      klineCount,
    });
    prev = cur;
  }
  return bis;
}

// ==================== 线段 ====================

/** 由笔构建线段：连续三笔有重叠构成一段 */
export function buildSegments(bis: Bi[]): Segment[] {
  const segments: Segment[] = [];
  if (bis.length < 3) return segments;
  for (let i = 0; i <= bis.length - 3; i++) {
    const b1 = bis[i];
    const b2 = bis[i + 1];
    const b3 = bis[i + 2];
    // 方向必须交替：上-下-上 或 下-上-下
    if (b1.direction === b2.direction || b2.direction === b3.direction) continue;
    // 三笔价格区间重叠
    const overlapHigh = Math.min(b1.high, b2.high, b3.high);
    const overlapLow = Math.max(b1.low, b2.low, b3.low);
    if (overlapHigh > overlapLow) {
      const direction = b1.direction;
      segments.push({
        direction,
        biStart: i,
        biEnd: i + 2,
        startIdx: b1.startIdx,
        endIdx: b3.endIdx,
        startPrice: b1.startPrice,
        endPrice: b3.endPrice,
        high: Math.max(b1.high, b2.high, b3.high),
        low: Math.min(b1.low, b2.low, b3.low),
      });
      // 跳过已用笔，避免重复
      i += 2;
    }
  }
  return segments;
}

// ==================== 中枢 ====================

/**
 * 中枢：连续三个次级别走势类型的重叠区间
 * 用笔近似：连续三笔（上-下-上 或 下-上-下）的重叠区间
 * ZG = 三笔高点最小值（中枢上沿）
 * ZD = 三笔低点最大值（中枢下沿）
 */
export function findZhongShus(bis: Bi[], level: string): ZhongShu[] {
  const zhongshus: ZhongShu[] = [];
  if (bis.length < 3) return zhongshus;
  // 笔端点显著离开中枢区间的判定（离开幅度 > 50% 箱宽 → 中枢被破坏）
  // 避免"擦边"笔（端点略出区间）误杀中枢，只有明显突破/跌破才结束中枢
  const escapeThresh = 0.5;
  const isEscape = (b: Bi, zd: number, zg: number): boolean => {
    const w = zg - zd;
    if (w <= 0) return false;
    if (b.endPrice < zd && zd - b.endPrice > w * escapeThresh) return true;
    if (b.endPrice > zg && b.endPrice - zg > w * escapeThresh) return true;
    return false;
  };
  const MIN_1BI_LEN = 10; // 1 笔中枢需足够长（K线数）才有意义，否则是单边行情的噪音
  for (let i = 0; i <= bis.length - 3; i++) {
    const b1 = bis[i];
    const b2 = bis[i + 1];
    const b3 = bis[i + 2];
    if (b1.direction === b2.direction || b2.direction === b3.direction) continue;
    // 中枢区间 = 三段重叠
    const zg = Math.min(b1.high, b2.high, b3.high); // 上沿
    const zd = Math.max(b1.low, b2.low, b3.low);    // 下沿
    if (zg > zd) {
      let endIdx = i + 2;
      let endKIdx = b3.endIdx;
      // 形成阶段：b3 端点显著离开（突破上沿/跌破下沿）→ 中枢在离开处结束
      if (isEscape(b3, zd, zg)) {
        if (isEscape(b2, zd, zg)) {
          // b2、b3 都显著离开 → 仅 b1 一段：长度足够才保留为 1 笔中枢
          const len = b1.endIdx - b1.startIdx + 1;
          if (len >= MIN_1BI_LEN) {
            zhongshus.push({
              zg, zd,
              gg: b1.high, dd: b1.low,
              startIdx: b1.startIdx, endIdx: b1.endIdx,
              startPrice: b1.startPrice, endPrice: b1.endPrice,
              segmentStart: i, segmentEnd: i, level, direction: 'side',
            });
          }
          continue; // b1 已处理，从 b2 继续（for 循环 i++）
        } else {
          endIdx = i + 1; endKIdx = b2.endIdx; // b1,b2 两笔形成有效中枢
        }
      }
      // 中枢延伸：笔与区间重叠 且 端点未显著离开 → 延伸（最多 6 段，防止框过长）
      for (let j = endIdx + 1; j < bis.length; j++) {
        if (endIdx - i + 1 >= 6) break; // 3 段形成 + 3 段延伸（缠论标准最多 9 段，视觉上 6 段更紧凑）
        const b = bis[j];
        if (b.high >= zd && b.low <= zg && !isEscape(b, zd, zg)) {
          endIdx = j;
          endKIdx = b.endIdx;
        } else {
          break;
        }
      }
      const segBis = bis.slice(i, endIdx + 1);
      const gg = Math.max(...segBis.map(b => b.high));
      const dd = Math.min(...segBis.map(b => b.low));
      zhongshus.push({
        zg, zd, gg, dd,
        startIdx: b1.startIdx,
        endIdx: endKIdx,
        startPrice: b1.startPrice,
        endPrice: bis[endIdx].endPrice,
        segmentStart: i,
        segmentEnd: endIdx,
        level,
        direction: 'side',
      });
      i = endIdx; // 不共享笔：for 循环 i++ 后从 endIdx+1 继续
    }
  }
  return zhongshus;
}

// ==================== 背驰 ====================

/**
 * 背驰判断：比较两个同向段的 MACD 面积
 * 底背驰：价格新低，但 MACD 面积（或 DIF）不新低
 * 顶背驰：价格新高，但 MACD 面积（或 DIF）不新高
 */
export function findDivergences(
  klines: KLine[], fractals: Fractal[], macd: MacdPoint[],
): Divergence[] {
  const divergences: Divergence[] = [];
  if (fractals.length < 3) return divergences;
  // 对比相邻同向分型（底-底、顶-顶）的力度
  let prevBottom: Fractal | null = null;
  let prevTop: Fractal | null = null;
  for (let i = 0; i < fractals.length; i++) {
    const f = fractals[i];
    if (f.type === 'bottom') {
      if (prevBottom && f.idx > prevBottom.idx && f.low < prevBottom.low) {
        // 价格新低，比较 MACD 面积
        const prevArea = macdArea(macd, prevBottom.idx, f.idx, 'neg');
        const curArea = macdArea(macd, prevBottom.idx, f.idx, 'neg');
        const prevDif = macd[Math.min(prevBottom.idx, macd.length - 1)].dif;
        const curDif = macd[Math.min(f.idx, macd.length - 1)].dif;
        if (curArea > prevArea && curArea < 0 || curDif > prevDif) {
          divergences.push({
            type: 'bottom', idx: f.idx, price: f.low, date: klines[f.idx]?.date || '',
            strength: Math.min(100, Math.round((1 - Math.abs(curDif - prevDif) / (Math.abs(prevDif) + 1e-9)) * 50 + 50)),
            note: '底背驰：价格新低，MACD/DIF不新低',
          });
        }
      }
      prevBottom = f;
    } else if (f.type === 'top') {
      if (prevTop && f.idx > prevTop.idx && f.high > prevTop.high) {
        const prevArea = macdArea(macd, prevTop.idx, f.idx, 'pos');
        const curArea = macdArea(macd, prevTop.idx, f.idx, 'pos');
        const prevDif = macd[Math.min(prevTop.idx, macd.length - 1)].dif;
        const curDif = macd[Math.min(f.idx, macd.length - 1)].dif;
        if (curArea < prevArea && curArea > 0 || curDif < prevDif) {
          divergences.push({
            type: 'top', idx: f.idx, price: f.high, date: klines[f.idx]?.date || '',
            strength: Math.min(100, Math.round((1 - Math.abs(curDif - prevDif) / (Math.abs(prevDif) + 1e-9)) * 50 + 50)),
            note: '顶背驰：价格新高，MACD/DIF不新高',
          });
        }
      }
      prevTop = f;
    }
  }
  return divergences;
}

/** 计算 MACD 面积（区间内柱值之和） */
function macdArea(macd: MacdPoint[], fromIdx: number, toIdx: number, sign: 'pos' | 'neg'): number {
  let area = 0;
  for (let i = fromIdx; i <= toIdx && i < macd.length; i++) {
    const v = macd[i].macd;
    if (sign === 'pos' && v > 0) area += v;
    else if (sign === 'neg' && v < 0) area += v;
  }
  return area;
}

// ==================== 买卖点 ====================

/**
 * 三类买卖点识别
 * B1/S1: 趋势背驰点（一买/一卖）
 * B2/S2: 二买/二卖（一买后回调不破前低 / 一卖后反弹不破前高）
 * B3/S3: 三买/三卖（突破中枢后回踩不进中枢 / 跌破中枢后反弹不进中枢）
 */

export function findTradePoints(
  klines: KLine[], fractals: Fractal[], bis: Bi[], zhongshus: ZhongShu[],
  divergences: Divergence[],
): TradePoint[] {
  const points: TradePoint[] = [];

  // ---- 一买/一卖：底背驰/顶背驰位置 ----
  for (const d of divergences) {
    if (d.type === 'bottom') {
      points.push({
        type: 'B1', idx: d.idx, price: d.price, date: d.date,
        strength: d.strength, note: d.note,
      });
    } else {
      points.push({
        type: 'S1', idx: d.idx, price: d.price, date: d.date,
        strength: d.strength, note: d.note,
      });
    }
  }

  // ---- 二买/二卖：一买/一卖之后的反抽确认 ----
  for (let i = 1; i < bis.length; i++) {
    const b = bis[i];
    const prev = bis[i - 1];
    if (prev.direction === 'down' && b.direction === 'up') {
      // 下跌笔后上涨笔：二买 = 上涨笔回调后不破下跌笔低点
      // 简化：找上涨笔之后的第一根下跌笔，其低点 > 前下跌笔低点
      if (i + 1 < bis.length && bis[i + 1].direction === 'down') {
        const pullback = bis[i + 1];
        if (pullback.low > prev.low) {
          points.push({
            type: 'B2', idx: pullback.endIdx, price: pullback.low, date: klines[pullback.endIdx]?.date || '',
            strength: 70, note: '二买：回调不破前低',
          });
        }
      }
    }
    if (prev.direction === 'up' && b.direction === 'down') {
      if (i + 1 < bis.length && bis[i + 1].direction === 'up') {
        const rebound = bis[i + 1];
        if (rebound.high < prev.high) {
          points.push({
            type: 'S2', idx: rebound.endIdx, price: rebound.high, date: klines[rebound.endIdx]?.date || '',
            strength: 70, note: '二卖：反弹不破前高',
          });
        }
      }
    }
  }

  // ---- 三买/三卖：突破中枢后回踩不进中枢 ----
  for (let zi = 0; zi < zhongshus.length; zi++) {
    const zs = zhongshus[zi];
    // 中枢之后找笔
    for (const b of bis) {
      if (b.startIdx <= zs.endIdx) continue;
      // 三买：中枢后有上涨笔突破 ZG，之后回调笔低点 > ZG
      if (b.direction === 'up' && b.high > zs.zg) {
        // 找后续下跌笔
        const bIdx = bis.indexOf(b);
        if (bIdx + 1 < bis.length && bis[bIdx + 1].direction === 'down') {
          const pullback = bis[bIdx + 1];
          if (pullback.low > zs.zg) {
            points.push({
              type: 'B3', idx: pullback.endIdx, price: pullback.low, date: klines[pullback.endIdx]?.date || '',
              strength: 85, zhongshuIndex: zi, note: `三买：突破中枢${zs.zg.toFixed(2)}后回踩确认`,
            });
          }
        }
      }
      // 三卖：中枢后有下跌笔跌破 ZD，之后反弹笔高点 < ZD
      if (b.direction === 'down' && b.low < zs.zd) {
        const bIdx = bis.indexOf(b);
        if (bIdx + 1 < bis.length && bis[bIdx + 1].direction === 'up') {
          const rebound = bis[bIdx + 1];
          if (rebound.high < zs.zd) {
            points.push({
              type: 'S3', idx: rebound.endIdx, price: rebound.high, date: klines[rebound.endIdx]?.date || '',
              strength: 85, zhongshuIndex: zi, note: `三卖：跌破中枢${zs.zd.toFixed(2)}后反弹确认`,
            });
          }
        }
      }
    }
  }

  return points;
}

// ==================== 趋势判断 ====================

/** 根据最后的中枢和笔判断当前趋势 */
export function judgeTrend(bis: Bi[], zhongshus: ZhongShu[]): 'up' | 'down' | 'side' {
  if (bis.length === 0) return 'side';
  const lastBi = bis[bis.length - 1];
  // 找最后一个中枢
  const lastZs = zhongshus.length > 0 ? zhongshus[zhongshus.length - 1] : null;
  if (lastZs) {
    // 中枢之后的笔方向
    if (lastBi.startIdx > lastZs.endIdx) {
      return lastBi.direction === 'up' ? 'up' : 'down';
    }
  }
  // 无中枢：看最近几笔
  const recent = bis.slice(-3);
  const ups = recent.filter(b => b.direction === 'up').length;
  const downs = recent.filter(b => b.direction === 'down').length;
  if (ups > downs) return 'up';
  if (downs > ups) return 'down';
  return 'side';
}

// ==================== 主入口 ====================

export function analyzeChan(klines: KLine[], code: string, level: 'daily' | 'm30' | 'm60'): ChanAnalysis {
  if (klines.length < 10) {
    throw new Error(`K线数据不足: ${klines.length}`);
  }
  const closes = klines.map(k => k.close);
  const macdArr = computeMACD(closes);
  const macd: MacdPoint[] = macdArr.dif.map((dif, i) => ({
    dif, dea: macdArr.dea[i], macd: macdArr.macd[i],
  }));

  const merged = mergeKlines(klines);
  const fractals = findFractals(merged, klines);
  const bis = buildBis(fractals, klines);
  const segments = buildSegments(bis);
  const zhongshus = findZhongShus(bis, level);
  const divergences = findDivergences(klines, fractals, macd);
  const tradePoints = findTradePoints(klines, fractals, bis, zhongshus, divergences);
  const trend = judgeTrend(bis, zhongshus);

  const buyPoints = tradePoints.filter(p => p.type.startsWith('B')).length;
  const sellPoints = tradePoints.filter(p => p.type.startsWith('S')).length;
  const signals: string[] = [];
  if (buyPoints > 0) signals.push(`发现${buyPoints}个买点`);
  if (sellPoints > 0) signals.push(`发现${sellPoints}个卖点`);
  if (divergences.filter(d => d.type === 'bottom').length > 0) signals.push('存在底背驰');
  if (divergences.filter(d => d.type === 'top').length > 0) signals.push('存在顶背驰');
  const lastZs = zhongshus[zhongshus.length - 1];
  if (lastZs) signals.push(`最后中枢: ${lastZs.zd.toFixed(2)}-${lastZs.zg.toFixed(2)}`);
  if (trend === 'up') signals.push('当前上升趋势');
  else if (trend === 'down') signals.push('当前下降趋势');
  else signals.push('当前盘整');

  const last = klines[klines.length - 1];
  return {
    code,
    level,
    klines,
    merged,
    fractals,
    bis,
    segments,
    zhongshus,
    tradePoints,
    divergences,
    macd,
    trend,
    lastPrice: last.close,
    lastDate: last.date,
    summary: {
      biCount: bis.length,
      segmentCount: segments.length,
      zhongshuCount: zhongshus.length,
      buyPoints,
      sellPoints,
      currentTrend: trend === 'up' ? '上升' : trend === 'down' ? '下降' : '盘整',
      signals,
    },
  };
}
