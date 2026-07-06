// ========== Plugin System Types ==========

export interface StrategyParam {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  default: any;
  options?: string[];
  min?: number;
  max?: number;
}

export type StrategyCategory = 'long-term' | 'mid-term' | 'short-term' | 'day-trade' | 'special' | 'sector' | 'macro' | 'quant' | 'momentum' | 'income' | 'reversal';

export interface Strategy {
  id: string;
  name: string;
  description: string;
  category: StrategyCategory;
  params: StrategyParam[];
  execute: (data: StockData[], params: Record<string, any>) => FilterResult[];
}

export interface StockScreenerPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  strategies: Strategy[];
}

// ========== Data Types ==========

export interface StockData {
  code: string;          // 股票代码，如 "600000"
  name: string;          // 股票名称，如 "浦发银行"
  market: 'SH' | 'SZ' | 'BJ';
  // 行情数据
  price: number;         // 当前价格
  changePercent: number; // 涨跌幅 %
  volume: number;        // 成交量
  turnover: number;      // 成交额
  open?: number;         // 今日开盘
  high?: number;         // 今日最高
  low?: number;          // 今日最低
  turnoverRate?: number; // 换手率 %
  // 基本面数据
  pe?: number;           // 市盈率
  pb?: number;           // 市净率
  marketCap?: number;    // 总市值
  circulatingMarketCap?: number; // 流通市值
  volumeRatio?: number;  // 量比
  limitUpIn20Days?: boolean; // 20日内是否有涨停
  priceAboveVwap?: boolean; // 分时是否在均价线上方
  // K线数据（用于技术指标计算）
  kline?: KLineData[];
}

export interface KLineData {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** KLine response metadata for tracking data source & rollback feedback */
export interface KLineMeta {
  /** Total number of data points returned */
  total: number;
  /** Number of days requested by caller */
  requested_days: number;
  /** Actual date range of returned data */
  date_range: {
    from: string;
    to: string;
  };
  /** Data source breakdown */
  sources: Array<{
    source: string;       // e.g. "sqlite_local", "tushare", "stock_cache"
    count: number;        // how many data points from this source
    range?: string;       // e.g. "2026-02-24 to 2026-04-30"
  }>;
  /** Warnings about data quality, gaps, or fallbacks */
  warnings: string[];
}

/** KLine API response with optional rollback feedback */
export interface KLineResponse {
  code: string;
  market: 'SH' | 'SZ';
  data: KLineData[];
  meta: KLineMeta;
}

export interface FilterResult {
  code: string;
  name: string;
  score: number;         // 策略评分 0-100
  signals: string[];     // 触发信号描述
  metrics: Record<string, number>;
}

// ========== API Types ==========

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  strategyCount: number;
  enabled: boolean;
  strategies: StrategyInfo[];
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  category: StrategyCategory;
  pluginId: string;
  params: StrategyParam[];
  enabled: boolean;
}

export interface ScreenRequest {
  strategies: Array<{
    pluginId: string;
    strategyId: string;
    params: Record<string, any>;
  }>;
  market?: ('SH' | 'SZ' | 'BJ')[];
  combineMode?: 'score' | 'union';
}

export interface ScreenResponse {
  results: FilterResult[];
  stats: {
    totalStocks: number;
    matchedStocks: number;
    executionTime: number;
  };
}

// ========== Backtest Types ==========

export interface BacktestConfig {
  startDate: string;              // '2024-01-01'
  endDate: string;                // '2025-12-31'
  strategies: Array<{
    pluginId: string;
    strategyId: string;
    params: Record<string, any>;
  }>;
  rebalanceFrequency: 'monthly' | 'weekly' | 'quarterly' | 'none';
  initialCapital: number;
  maxPositions: number;           // max stocks to hold simultaneously
  commission?: number;            // trading commission rate (e.g. 0.0003 for 0.03%)
  benchmark?: string;             // benchmark index code (optional)
  // Realistic trading features
  stopLoss?: number;              // stop-loss threshold % (e.g., -15 = sell if -15% from avg cost)
  takeProfit?: number;            // take-profit threshold % (e.g., 50 = sell if +50% from avg cost)
  slippageModel?: 'none' | 'fixed' | 'volume';  // slippage model (default: 'fixed')
}

export interface BacktestPeriod {
  date: string;
  holdings: Holding[];
  cash: number;
  totalValue: number;
  trades: Trade[];
  dailyReturns: number;           // period return %
}

export interface Holding {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  shares: number;
  avgCost: number;
  currentPrice: number;
  value: number;
  return: number;                 // unrealized return %
  weight: number;                 // portfolio weight %
}

export interface Trade {
  date: string;
  type: 'buy' | 'sell';
  code: string;
  name: string;
  price: number;
  shares: number;
  amount: number;
  reason?: string;                // why this trade
}

export interface BacktestSummary {
  totalReturn: number;            // total return %
  annualizedReturn: number;       // annualized return %
  maxDrawdown: number;            // maximum drawdown %
  winRate: number;                // percentage of positive periods
  totalTrades: number;
  sharpeRatio: number;            // risk-adjusted return
  volatility: number;             // daily return volatility
  profitFactor: number;           // gross profit / gross loss
  finalCapital: number;
  // Benchmark comparison
  benchmarkReturn?: number;       // benchmark return %
  excessReturn?: number;          // strategy - benchmark return %
  // Extended risk metrics
  alpha?: number;                 // Alpha (Jensen's) %
  beta?: number;                  // Beta vs benchmark
  calmarRatio?: number;           // annualized return / max drawdown
  informationRatio?: number;      // information ratio (annualized)
  maxConsecutiveLosses?: number;   // max consecutive losing days
}

export interface TimeframePeriod {
  label: string;         // e.g. "2024", "2024-Q1", "2024-01"
  date: string;          // Start date of period
  return: number;        // Period return %
  benchmarkReturn: number | null;
  maxDrawdown: number;   // Within-period max drawdown %
  volatility: number;    // Annualized volatility %
}

export interface TimeframeAnalysis {
  yearly: TimeframePeriod[];
  quarterly: TimeframePeriod[];
  monthly: TimeframePeriod[];
}

export interface BacktestResult {
  config: BacktestConfig;
  periods: BacktestPeriod[];
  summary: BacktestSummary;
  equityCurve: Array<{ date: string; value: number; benchmark?: number }>;
  trades?: Trade[];
  timeframeAnalysis?: TimeframeAnalysis;
  techTree?: TechTreeAnalysis;
}

// ========== Tech Tree / Heatmap Types ==========

export interface RegimeCell {
  regimeLabel: string;    // e.g. "强牛·低波"
  trendLabel: string;     // e.g. "强牛"
  volLabel: string;       // e.g. "低波"
  return: number;         // Avg daily return in this regime %
  volatility: number;     // Daily vol in this regime %
  maxDrawdown: number;    // Max drawdown within this regime %
  dayCount: number;       // Number of trading days
  winRate: number;        // % of positive days
}

export interface RegimeHeatmap {
  trendLabels: string[];
  volLabels: string[];
  cells: RegimeCell[][];  // [volIndex][trendIndex]
}

export interface MonthlySeasonality {
  month: number;          // 1-12
  years: Array<{ year: number; return: number }>;
  avgReturn: number;
  winRate: number;         // % of positive years for this month
}

export interface TechTreeAnalysis {
  regimeHeatmap: RegimeHeatmap;
  monthlySeasonality: MonthlySeasonality[];
}

// ========== Watch (盯盘) Types ==========

export type PriceChangeDirection = 'up' | 'down' | 'either';

export interface PriceChangeCondition {
  type: 'price_change';
  direction: PriceChangeDirection;
  thresholdPercent: number;  // e.g., 5 means >5% change
}

export interface VolumeSpikeCondition {
  type: 'volume_spike';
  ratio: number;            // e.g., 3 means volume > 3x average
  lookbackMinutes?: number;
}

export interface PriceLevelCrossCondition {
  type: 'price_cross';
  cross: 'above' | 'below';
  price: number;           // absolute price level
}

export interface NewHighLowCondition {
  type: 'new_high_low';
  period: '52week' | 'alltime';
  direction: 'high' | 'low';
}

export interface CombinedCondition {
  type: 'combined';
  operator: 'AND' | 'OR';
  conditions: WatchCondition[];
}

export type WatchCondition =
  | PriceChangeCondition
  | VolumeSpikeCondition
  | PriceLevelCrossCondition
  | NewHighLowCondition
  | CombinedCondition;

export interface WatchTask {
  id: string;
  userId: string;
  label?: string;
  enabled: boolean;
  interval: number;         // seconds between checks (>= 30)

  watchTargets: string[];   // stock codes, e.g., ['000001', '300750']
  conditions: WatchCondition[];

  alertChannels: {
    frontend: boolean;      // push to browser (default true)
    email: boolean;
    agent: boolean;         // send to AI agent notification queue
  };

  email?: string;            // comma-separated email recipients for email alerts

  cooldownSeconds: number;  // cooldown between alerts per stock (default 300)

  // Runtime state (persisted)
  _state: Record<string, {
    lastPrice: number;
    lastVolume: number;
    lastAlerted: number;    // timestamp of last alert
    prevClose?: number;     // previous day close (from API)
  }>;

  createdAt: number;
  lastRun?: number;
  lastAlert?: {
    timestamp: number;
    stock: string;
    conditionType: string;
    message: string;
  };
}

export interface WatchAlert {
  userId: string;
  taskId: string;
  taskLabel?: string;
  stock: string;
  stockName: string;
  conditionType: string;
  price: number;
  changePercent: number;
  volume: number;
  message: string;
  timestamp: number;
}
