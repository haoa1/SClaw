/**
 * 缠论引擎核心类型定义
 * 支持 daily / 30m / 60m 三级别
 */

export interface KLine {
  date: string;      // 日线 "2026-08-14" | 分钟 "2026-08-14 15:00"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number;
}

/** 合并K线（处理包含关系后） */
export interface MergedK {
  idx: number;        // 原始K线索引（取合并组最后一根）
  high: number;
  low: number;
  startIdx: number;   // 合并组第一根
  endIdx: number;     // 合并组最后一根
  dir: 1 | -1;        // 合并方向 1=向上处理 -1=向下处理
}

/** 分型 */
export interface Fractal {
  type: 'top' | 'bottom';
  idx: number;        // 原始K线索引（分型中间K线）
  high: number;       // 顶分型高点
  low: number;        // 底分型低点
  mergedIdx: number;  // 合并K线索引
  strength?: number;  // 分型强度
}

/** 笔 */
export interface Bi {
  direction: 'up' | 'down';
  start: number;      // 分型索引（Fractal[] 内）
  end: number;
  startIdx: number;   // 原始K线索引
  endIdx: number;
  startPrice: number;
  endPrice: number;
  high: number;
  low: number;
  klineCount: number; // 含K线数
}

/** 线段（由笔构成） */
export interface Segment {
  direction: 'up' | 'down';
  biStart: number;    // Bi[] 内
  biEnd: number;
  startIdx: number;
  endIdx: number;
  startPrice: number;
  endPrice: number;
  high: number;
  low: number;
}

/** 中枢 */
export interface ZhongShu {
  zg: number;         // 中枢上沿（三段重叠区间最小值高点）
  zd: number;         // 中枢下沿（三段重叠区间最大值低点）
  gg: number;         // 中枢波动高点
  dd: number;         // 中枢波动低点
  startIdx: number;   // 原始K线索引
  endIdx: number;
  startPrice: number;
  endPrice: number;
  segmentStart: number;
  segmentEnd: number;
  level: string;      // 级别
  direction: 'up' | 'down' | 'side';
}

/** 买卖点 */
export interface TradePoint {
  type: 'B1' | 'B2' | 'B3' | 'S1' | 'S2' | 'S3';
  idx: number;        // 原始K线索引
  price: number;
  date: string;
  strength: number;   // 0-100
  zhongshuIndex?: number;
  note: string;
}

/** 背驰 */
export interface Divergence {
  type: 'top' | 'bottom';
  idx: number;
  price: number;
  date: string;
  strength: number;
  note: string;
}

/** MACD 数据 */
export interface MacdPoint {
  dif: number;
  dea: number;
  macd: number;
}

/** 完整标注结果 */
export interface ChanAnalysis {
  code: string;
  level: 'daily' | 'm30' | 'm60';
  klines: KLine[];
  merged: MergedK[];
  fractals: Fractal[];
  bis: Bi[];
  segments: Segment[];
  zhongshus: ZhongShu[];
  tradePoints: TradePoint[];
  divergences: Divergence[];
  macd: MacdPoint[];
  trend: 'up' | 'down' | 'side';
  lastPrice: number;
  lastDate: string;
  summary: {
    biCount: number;
    segmentCount: number;
    zhongshuCount: number;
    buyPoints: number;
    sellPoints: number;
    currentTrend: string;
    signals: string[];
  };
}
