/**
 * Backtest Engine — simulates strategy performance over historical periods.
 *
 * Flow:
 *   1. Generate rebalance dates from config
 *   2. For each rebalance date, fetch historical snapshot via DataProvider
 *   3. Run strategies to select stocks
 *   4. Rebalance portfolio (sell existing, buy selected)
 *   5. Track daily value between rebalance dates
 *   6. Calculate summary metrics (with benchmark comparison)
 */

import { StrategyEngine } from '../strategies/strategy-engine';
import { BacktestDataProvider, BacktestKLine } from './data-provider';
import {
  BacktestConfig, BacktestResult, BacktestPeriod,
  BacktestSummary, Holding, Trade, StockData, FilterResult,
  TimeframeAnalysis, TimeframePeriod,
  TechTreeAnalysis, RegimeHeatmap, RegimeCell, MonthlySeasonality,
} from '../types';
import { applyTradingRules, canBuy } from './trading-rules';
import { calculateBuyExecution, calculateSellExecution, DEFAULT_SLIPPAGE } from './slippage';

// ===== Helpers (pure functions) =====

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function generateRebalanceDates(config: BacktestConfig): string[] {
  const dates: string[] = [];
  let current = new Date(config.startDate);
  dates.push(formatDate(current));

  if (config.rebalanceFrequency === 'none') {
    return dates;
  }

  while (current < new Date(config.endDate)) {
    switch (config.rebalanceFrequency) {
      case 'weekly':
        current.setDate(current.getDate() + 7);
        break;
      case 'monthly':
        current.setMonth(current.getMonth() + 1);
        break;
      case 'quarterly':
        current.setMonth(current.getMonth() + 3);
        break;
      default: // daily
        current.setDate(current.getDate() + 1);
        break;
    }
    if (current < new Date(config.endDate)) {
      dates.push(formatDate(current));
    }
  }
  return dates;
}

function calcDailyReturn(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    returns.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  return returns;
}

function calcMaxDrawdown(values: number[]): number {
  let peak = values[0];
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

function calcSharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean * 252) / (std * Math.sqrt(252));
}

function calcWinRate(periodReturns: number[]): number {
  if (periodReturns.length === 0) return 0;
  return (periodReturns.filter(r => r > 0).length / periodReturns.length) * 100;
}

function calcProfitFactor(trades: Trade[]): number {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.type === 'sell') {
      const pnl = t.amount;
      if (pnl > 0) grossProfit += pnl;
      else grossLoss += Math.abs(pnl);
    }
  }
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
}

function calcAlphaBeta(
  strategyReturns: number[],
  benchmarkReturns: number[],
  riskFreeRate = 0.02,
): { alpha: number; beta: number } {
  if (strategyReturns.length < 2 || benchmarkReturns.length < 2) {
    return { alpha: 0, beta: 1 };
  }

  const len = Math.min(strategyReturns.length, benchmarkReturns.length);
  const sRet = strategyReturns.slice(0, len);
  const bRet = benchmarkReturns.slice(0, len);

  const sMean = sRet.reduce((a, b) => a + b, 0) / len;
  const bMean = bRet.reduce((a, b) => a + b, 0) / len;

  let cov = 0;
  let bVar = 0;
  for (let i = 0; i < len; i++) {
    cov += (sRet[i] - sMean) * (bRet[i] - bMean);
    bVar += (bRet[i] - bMean) ** 2;
  }
  cov /= len;
  bVar /= len;

  const beta = bVar > 0 ? cov / bVar : 1;
  const sAnnual = (1 + sMean) ** 252 - 1;
  const bAnnual = (1 + bMean) ** 252 - 1;
  const alpha = sAnnual - riskFreeRate - beta * (bAnnual - riskFreeRate);

  return {
    alpha: parseFloat((alpha * 100).toFixed(2)),
    beta: parseFloat(beta.toFixed(3)),
  };
}

function calcCalmarRatio(annualizedReturn: number, maxDrawdown: number): number {
  if (maxDrawdown <= 0) return 0;
  return parseFloat((annualizedReturn / maxDrawdown).toFixed(3));
}

function calcInformationRatio(strategyReturns: number[], benchmarkReturns: number[]): number {
  const len = Math.min(strategyReturns.length, benchmarkReturns.length);
  if (len < 2) return 0;

  const excessReturns: number[] = [];
  for (let i = 0; i < len; i++) {
    excessReturns.push(strategyReturns[i] - benchmarkReturns[i]);
  }

  const mean = excessReturns.reduce((a, b) => a + b, 0) / len;
  const variance = excessReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / len;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;

  return parseFloat(((mean * 252) / (std * Math.sqrt(252))).toFixed(3));
}

function calcMaxConsecutiveLosses(dailyReturns: number[]): number {
  let maxLoss = 0;
  let currentLoss = 0;
  for (const r of dailyReturns) {
    if (r < 0) {
      currentLoss++;
      if (currentLoss > maxLoss) maxLoss = currentLoss;
    } else {
      currentLoss = 0;
    }
  }
  return maxLoss;
}

function computeTimeframeAnalysis(
  equityCurve: Array<{ date: string; value: number; benchmark?: number }>,
  initialCapital: number,
): TimeframeAnalysis {
  if (equityCurve.length < 2) {
    return { yearly: [], quarterly: [], monthly: [] };
  }

  // Group equity curve points by time period
  function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }

  function calcPeriod(points: Array<{ date: string; value: number; benchmark?: number }>): TimeframePeriod {
    const values = points.map(p => p.value);
    const bmValues = points.filter(p => p.benchmark !== undefined).map(p => p.benchmark!);

    const firstVal = values[0];
    const lastVal = values[values.length - 1];
    const periodReturn = firstVal > 0 ? ((lastVal / firstVal) - 1) * 100 : 0;

    const bmReturn = bmValues.length >= 2
      ? ((bmValues[bmValues.length - 1] / bmValues[0]) - 1) * 100
      : null;

    const maxDd = calcMaxDrawdown(values);
    const dailyRet = calcDailyReturn(values);
    const vol = dailyRet.length > 0
      ? parseFloat((Math.sqrt(dailyRet.reduce((a, b) => a + b ** 2, 0) / dailyRet.length) * Math.sqrt(252) * 100).toFixed(2))
      : 0;

    return {
      label: '', // will be set by caller
      date: points[0].date,
      return: parseFloat(periodReturn.toFixed(2)),
      benchmarkReturn: bmReturn !== null ? parseFloat(bmReturn.toFixed(2)) : null,
      maxDrawdown: parseFloat(maxDd.toFixed(2)),
      volatility: vol,
    };
  }

  const yearly = groupBy(equityCurve, p => p.date.slice(0, 4));
  const quarterly = groupBy(equityCurve, p => {
    const m = parseInt(p.date.slice(5, 7));
    const q = Math.ceil(m / 3);
    return `${p.date.slice(0, 4)}-Q${q}`;
  });
  const monthly = groupBy(equityCurve, p => p.date.slice(0, 7));

  return {
    yearly: [...yearly.entries()].map(([label, pts]) => ({ ...calcPeriod(pts), label })).sort((a, b) => a.label.localeCompare(b.label)),
    quarterly: [...quarterly.entries()].map(([label, pts]) => ({ ...calcPeriod(pts), label })).sort((a, b) => a.label.localeCompare(b.label)),
    monthly: [...monthly.entries()].map(([label, pts]) => ({ ...calcPeriod(pts), label })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function computeTechTreeAnalysis(
  equityCurve: Array<{ date: string; value: number; benchmark?: number }>,
): TechTreeAnalysis {
  if (equityCurve.length < 5) {
    return {
      regimeHeatmap: { trendLabels: [], volLabels: [], cells: [] },
      monthlySeasonality: [],
    };
  }

  // 1. Compute daily returns for strategy
  const dailyReturns: Array<{ date: string; ret: number }> = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].value;
    const cur = equityCurve[i].value;
    dailyReturns.push({
      date: equityCurve[i].date,
      ret: prev > 0 ? ((cur / prev) - 1) * 100 : 0,
    });
  }

  // 2. Compute benchmark daily returns and rolling stats
  const bmValues = equityCurve.map(e => e.benchmark).filter((v): v is number => v !== undefined);
  const bmReturns: Array<{ date: string; ret: number }> = [];
  const bmPoints = equityCurve.filter(e => e.benchmark !== undefined);
  for (let i = 1; i < bmPoints.length; i++) {
    bmReturns.push({
      date: bmPoints[i].date,
      ret: bmPoints[i - 1].benchmark! > 0
        ? ((bmPoints[i].benchmark! / bmPoints[i - 1].benchmark!) - 1) * 100
        : 0,
    });
  }

  // 3. For each strategy day, determine market regime from benchmark
  const regimeAssignments: Array<{
    date: string;
    ret: number;
    trend: string;
    vol: string;
    month: number;
    year: number;
  }> = [];

  // Use a rolling window of 20 days for benchmark trend/vol
  const bmRetMap = new Map(bmReturns.map(r => [r.date, r.ret]));
  const bmDates = bmReturns.map(r => r.date);

  for (const dr of dailyReturns) {
    const idx = bmDates.indexOf(dr.date);
    if (idx < 20) continue; // need 20 benchmark days to classify

    // 20-day rolling return for trend
    const windowRet20 = bmReturns.slice(idx - 19, idx + 1);
    const cumRet = windowRet20.reduce((sum, r) => (1 + sum) * (1 + r.ret / 100) - 1, 0) * 100;

    // 20-day rolling volatility
    const meanRet = windowRet20.reduce((s, r) => s + r.ret, 0) / windowRet20.length;
    const variance = windowRet20.reduce((s, r) => s + (r.ret - meanRet) ** 2, 0) / windowRet20.length;
    const vol = Math.sqrt(variance) * 100;

    // Classify trend
    let trendLabel: string;
    if (cumRet > 5) trendLabel = '强牛';
    else if (cumRet > 1) trendLabel = '弱牛';
    else if (cumRet > -1) trendLabel = '震荡';
    else if (cumRet > -5) trendLabel = '弱熊';
    else trendLabel = '强熊';

    // Classify vol using percentile across all windows
    const volLabel = vol > 1.5 ? '高波' : vol > 0.8 ? '中波' : '低波';

    const dateObj = new Date(dr.date);
    regimeAssignments.push({
      date: dr.date,
      ret: dr.ret,
      trend: trendLabel,
      vol: volLabel,
      month: dateObj.getMonth() + 1,
      year: dateObj.getFullYear(),
    });
  }

  // 4. Build regime heatmap
  const trendOrder = ['强熊', '弱熊', '震荡', '弱牛', '强牛'];
  const volOrder = ['低波', '中波', '高波'];

  const cells: RegimeCell[][] = volOrder.map(volLabel =>
    trendOrder.map(trendLabel => {
      const days = regimeAssignments.filter(r => r.trend === trendLabel && r.vol === volLabel);
      if (days.length === 0) {
        return {
          regimeLabel: `${trendLabel}·${volLabel}`,
          trendLabel,
          volLabel,
          return: 0,
          volatility: 0,
          maxDrawdown: 0,
          dayCount: 0,
          winRate: 0,
        };
      }
      const avgRet = days.reduce((s, d) => s + d.ret, 0) / days.length;
      const varRet = days.reduce((s, d) => s + (d.ret - avgRet) ** 2, 0) / days.length;
      const vol = Math.sqrt(varRet) * 100;
      const winCount = days.filter(d => d.ret > 0).length;

      // Compute drawdown within this regime's equity subset
      // Use cumulative return for max drawdown estimate
      let cumVal = 100;
      let peak = 100;
      let maxDd = 0;
      for (const d of days) {
        cumVal *= (1 + d.ret / 100);
        if (cumVal > peak) peak = cumVal;
        const dd = (peak - cumVal) / peak;
        if (dd > maxDd) maxDd = dd;
      }

      return {
        regimeLabel: `${trendLabel}·${volLabel}`,
        trendLabel,
        volLabel,
        return: parseFloat(avgRet.toFixed(3)),
        volatility: parseFloat(vol.toFixed(2)),
        maxDrawdown: parseFloat((maxDd * 100).toFixed(2)),
        dayCount: days.length,
        winRate: days.length > 0 ? parseFloat(((winCount / days.length) * 100).toFixed(1)) : 0,
      };
    }),
  );

  // 5. Build monthly seasonality
  const monthGroups = new Map<number, Array<{ year: number; ret: number }>>();
  for (let m = 1; m <= 12; m++) monthGroups.set(m, []);

  for (const ra of regimeAssignments) {
    const arr = monthGroups.get(ra.month)!;
    arr.push({ year: ra.year, ret: ra.ret });
  }

  const monthlySeasonality: MonthlySeasonality[] = [];
  for (let m = 1; m <= 12; m++) {
    const days = monthGroups.get(m)!;
    if (days.length === 0) {
      monthlySeasonality.push({ month: m, years: [], avgReturn: 0, winRate: 0 });
      continue;
    }

    // Group by year
    const byYear = new Map<number, number[]>();
    for (const d of days) {
      if (!byYear.has(d.year)) byYear.set(d.year, []);
      byYear.get(d.year)!.push(d.ret);
    }

    const yearsArr: Array<{ year: number; return: number }> = [];
    for (const [year, rets] of byYear) {
      const yearAvg = rets.reduce((s, r) => s + r, 0) / rets.length;
      yearsArr.push({ year, return: parseFloat(yearAvg.toFixed(3)) });
    }

    const avgReturn = days.reduce((s, d) => s + d.ret, 0) / days.length;
    const winCount = days.filter(d => d.ret > 0).length;

    monthlySeasonality.push({
      month: m,
      years: yearsArr.sort((a, b) => a.year - b.year),
      avgReturn: parseFloat(avgReturn.toFixed(3)),
      winRate: parseFloat(((winCount / days.length) * 100).toFixed(1)),
    });
  }

  return {
    regimeHeatmap: {
      trendLabels: trendOrder,
      volLabels: volOrder,
      cells,
    },
    monthlySeasonality,
  };
}

// ===== Backtest Engine =====

export class BacktestEngine {
  private strategyEngine: StrategyEngine;
  private dataProvider: BacktestDataProvider;
  private stockInfo: Map<string, { name: string; market: 'SH' | 'SZ' | 'BJ' }> = new Map();

  constructor(
    strategyEngine: StrategyEngine,
    dataProvider: BacktestDataProvider,
  ) {
    this.strategyEngine = strategyEngine;
    this.dataProvider = dataProvider;
  }

  async run(config: BacktestConfig): Promise<BacktestResult> {
    console.log(`\n[Backtest] Starting: ${config.startDate} → ${config.endDate}`);
    console.log(`[Backtest] Strategies: ${config.strategies.map(s => `${s.pluginId}/${s.strategyId}`).join(', ')}`);
    console.log(`[Backtest] Rebalance: ${config.rebalanceFrequency}, Max positions: ${config.maxPositions}`);

    // 1. Load stock info map
    const stockInfos = this.dataProvider.getStockList();
    this.stockInfo.clear();
    for (const s of stockInfos) {
      this.stockInfo.set(s.code, { name: s.name, market: (s.market || 'SH') as 'SH' | 'SZ' | 'BJ' });
    }
    console.log(`[Backtest] Loaded ${this.stockInfo.size} stock infos`);

    // 2. Fetch benchmark data
    let benchmarkData: Array<{ date: string; close: number }> = [];
    if (config.benchmark) {
      benchmarkData = await this.dataProvider.getBenchmarkData(config.benchmark, config.startDate, config.endDate);
      console.log(`[Backtest] Benchmark ${config.benchmark}: ${benchmarkData.length} data points`);
    }

    // 3. Generate rebalance dates
    const rebalanceDates = generateRebalanceDates(config);
    console.log(`[Backtest] ${rebalanceDates.length} rebalance dates`);

    // 4. Run the simulation
    const periods: BacktestPeriod[] = [];
    const equityCurve: Array<{ date: string; value: number; benchmark?: number }> = [];
    const allTrades: Trade[] = [];

    let cash = config.initialCapital;
    let holdings: Holding[] = [];
    let benchmarkRefPrice: number | undefined;

    // Get all strategy stock codes to batch-fetch K-lines efficiently
    const allCandidateCodes = stockInfos.map(s => s.code);

    for (let i = 0; i < rebalanceDates.length; i++) {
      const rebalanceDate = rebalanceDates[i];
      const isLast = i === rebalanceDates.length - 1;
      const nextDate = config.endDate; // always use endDate as upper bound for K-line fetch

      console.log(`\n[Backtest] --- Rebalance: ${rebalanceDate} ---`);

      // 4a. Build snapshot at rebalance date
      const snapshotRows = await this.dataProvider.getMarketSnapshot(rebalanceDate);
      const snapshot = snapshotRows.map(r => ({
        code: r.code,
        name: this.stockInfo.get(r.code)?.name || r.code,
        market: (this.stockInfo.get(r.code)?.market || 'SH') as 'SH' | 'SZ' | 'BJ',
        price: r.close,
        changePercent: r.changePct,
        // Plugin strategies use both changePercent and changePct interchangeably
        changePct: r.changePct,
        close: r.close,
        volume: r.volume,
        turnover: r.amount,
        open: r.open,
        high: r.high,
        low: r.low,
        turnoverRate: r.turnoverRate,
      }));
      console.log(`[Backtest] Snapshot: ${snapshot.length} stocks`);

      // 4b. Build price map
      const snapshotPriceMap = new Map<string, number>();
      for (const s of snapshot) {
        snapshotPriceMap.set(s.code, s.price);
      }

      // 4c. Run strategies
      let selected: FilterResult[] = [];
      if (snapshot.length > 0) {
        const screenRequest = {
          strategies: config.strategies,
          market: ['SH', 'SZ'] as ('SH' | 'SZ' | 'BJ')[],
          combineMode: 'score' as const,
        };
        const result = await this.strategyEngine.execute(snapshot, screenRequest);
        selected = result.results
          .sort((a, b) => b.score - a.score)
          .slice(0, config.maxPositions);
      }
      console.log(`[Backtest] Selected ${selected.length}/${snapshot.length} stocks`);

      // 4d. Rebalance: sell old, buy new
      const periodTrades: Trade[] = [];

      // Apply trading rules to snapshot for buy/sell constraints
      const tradingFilters = applyTradingRules(
        snapshot.map(s => ({
          code: s.code,
          name: s.name,
          market: s.market,
          price: s.price,
          changePercent: s.changePercent,
          volume: s.volume,
          open: s.open,
          high: s.high,
          low: s.low,
        }))
      );
      const filterMap = new Map(tradingFilters.map(f => [f.code, f]));

      const useSlippage = config.slippageModel !== 'none';

      // Sell holdings not in selected list
      const selectedCodes = new Set(selected.map(s => s.code));
      const stuckHoldings: Holding[] = []; // holdings that couldn't be sold (limit-down/suspended)
      for (const h of holdings) {
        if (!selectedCodes.has(h.code)) {
          const filter = filterMap.get(h.code);
          const sellBlocked = filter?.sellBlocked ?? false;

          if (sellBlocked) {
            // Can't sell — keep holding, will retry next rebalance
            stuckHoldings.push(h);
            periodTrades.push({
              date: rebalanceDate,
              type: 'sell',
              code: h.code,
              name: h.name,
              price: h.currentPrice,
              shares: 0,
              amount: 0,
              reason: `${filter?.blockReason || '未知'}，无法卖出，保留到下期`,
            });
            continue;
          }

          // Apply slippage to sell
          let sellPrice = h.currentPrice;
          if (useSlippage && (h.shares * h.currentPrice) > 0 && filter) {
            const dailyVolume = snapshot.find(s => s.code === h.code)?.turnover || 0;
            const execution = calculateSellExecution(h.currentPrice, h.value, dailyVolume);
            sellPrice = execution.price;
          }

          const sellValue = h.shares * sellPrice;
          periodTrades.push({
            date: rebalanceDate,
            type: 'sell',
            code: h.code,
            name: h.name,
            price: sellPrice,
            shares: h.shares,
            amount: sellValue,
            reason: 'Not selected in rebalance',
          });
          cash += sellValue * (1 - (config.commission || 0));
        }
      }

      const keptHoldings = holdings.filter(h => selectedCodes.has(h.code));
      const keptCodes = new Set(keptHoldings.map(h => h.code));

      // Allocate cash (consider stuck holdings that still consume cash)
      const availableCash = cash;
      const buySlots = Math.max(1, selected.length - keptHoldings.length - stuckHoldings.length);
      const targetPerStock = availableCash / buySlots;

      const newHoldings: Holding[] = [...keptHoldings, ...stuckHoldings];
      for (const item of selected) {
        if (keptCodes.has(item.code)) {
          const existing = newHoldings.find(h => h.code === item.code);
          if (existing) {
            existing.currentPrice = item.metrics?.price || existing.currentPrice;
          }
          continue;
        }

        // Check if stock can be bought (not limit-up / suspended)
        const filter = filterMap.get(item.code);
        if (filter && !canBuy(filter)) {
          console.log(`[Backtest] Skipping ${item.code} (${item.name}): ${filter.blockReason || 'blocked'}`);
          periodTrades.push({
            date: rebalanceDate,
            type: 'buy',
            code: item.code,
            name: item.name || item.code,
            price: 0,
            shares: 0,
            amount: 0,
            reason: `${filter.blockReason || '无法买入'}，跳过`,
          });
          continue;
        }

        let price = snapshotPriceMap.get(item.code) || item.metrics?.price || 0;
        if (price <= 0) continue;

        // Apply slippage to buy
        if (useSlippage && filter) {
          const dailyVolume = snapshot.find(s => s.code === item.code)?.turnover || 0;
          const execution = calculateBuyExecution(price, targetPerStock, dailyVolume);
          price = execution.price;
        }

        const cost = targetPerStock * (1 - (config.commission || 0));
        const shares = Math.floor(cost / price / 100) * 100;
        if (shares < 100) continue;

        const amount = shares * price;
        if (amount > cash) continue;

        cash -= amount * (1 + (config.commission || 0));

        const info = this.stockInfo.get(item.code);
        const name = info?.name || item.name || item.code;
        newHoldings.push({
          code: item.code,
          name,
          market: info?.market || 'SH',
          shares,
          avgCost: price,
          currentPrice: price,
          value: amount,
          return: 0,
          weight: 0,
        });

        periodTrades.push({
          date: rebalanceDate,
          type: 'buy',
          code: item.code,
          name,
          price,
          shares,
          amount,
          reason: `Score: ${item.score.toFixed(1)}`,
        });
      }

      holdings = newHoldings;

      // Update weights
      const totalValue = cash + holdings.reduce((s, h) => s + h.value, 0);
      for (const h of holdings) {
        h.weight = totalValue > 0 ? (h.value / totalValue) * 100 : 0;
      }

      allTrades.push(...periodTrades);

      // 4e. Track daily value between rebalance dates
      const tradingDays = await this.dataProvider.getTradingCalendar(rebalanceDate, nextDate);
      const dailyValues: Array<{ date: string; value: number; benchmark?: number }> = [];

      if (holdings.length > 0) {
        // Batch-fetch K-lines for all holdings at once
        const holdingCodes = [...new Set(holdings.map(h => h.code))];
        const klineMap = await this.dataProvider.getKLineBatch(holdingCodes, rebalanceDate, nextDate);

        // Build lookup: code → map of date → BacktestKLine
        const klineByCodeAndDate = new Map<string, Map<string, BacktestKLine>>();
        for (const [code, klines] of klineMap.entries()) {
          const dateMap = new Map<string, BacktestKLine>();
          for (const k of klines) {
            dateMap.set(k.date, k);
          }
          klineByCodeAndDate.set(code, dateMap);
        }

        for (const day of tradingDays) {
          let dayValue = cash;

          // Track which holdings triggered stop-loss/take-profit this day
          const toSell: Holding[] = [];

          for (const h of holdings) {
            const dateMap = klineByCodeAndDate.get(h.code);
            const kline = dateMap?.get(day);
            const price = kline ? kline.close : h.currentPrice;

            h.currentPrice = price;
            h.value = h.shares * price;
            h.return = h.avgCost > 0 ? ((price / h.avgCost) - 1) * 100 : 0;

            // Check stop-loss / take-profit
            if (config.stopLoss !== undefined && h.return <= config.stopLoss) {
              toSell.push(h);
            } else if (config.takeProfit !== undefined && h.return >= config.takeProfit) {
              toSell.push(h);
            } else {
              dayValue += h.value;
            }
          }

          // Execute stop-loss/take-profit sells
          for (const h of toSell) {
            const sellValue = h.shares * h.currentPrice;
            cash += sellValue * (1 - (config.commission || 0));
            allTrades.push({
              date: day,
              type: 'sell',
              code: h.code,
              name: h.name,
              price: h.currentPrice,
              shares: h.shares,
              amount: sellValue,
              reason: h.return <= (config.stopLoss ?? -999)
                ? `止损 (${h.return.toFixed(1)}%)`
                : `止盈 (${h.return.toFixed(1)}%)`,
            });
          }

          // Remove sold holdings
          if (toSell.length > 0) {
            const soldCodes = new Set(toSell.map(h => h.code));
            holdings = holdings.filter(h => !soldCodes.has(h.code));

            // Recalculate dayValue after sells (cash may have changed)
            dayValue = cash;
            for (const h of holdings) {
              dayValue += h.value;
            }
          }

          // Look up benchmark value
          let benchmarkValue: number | undefined;
          const bm = benchmarkData.find(b => b.date === day);
          if (bm) {
            benchmarkValue = bm.close;
          }

          dailyValues.push({ date: day, value: dayValue, benchmark: benchmarkValue });
        }
      }

      equityCurve.push(...dailyValues);

      // 4f. Period return
      const prevValue = equityCurve.length > dailyValues.length
        ? equityCurve[equityCurve.length - dailyValues.length - 1]?.value || config.initialCapital
        : config.initialCapital;
      const curValue = dailyValues[dailyValues.length - 1]?.value || prevValue;
      const periodReturn = prevValue > 0 ? ((curValue / prevValue) - 1) * 100 : 0;

      periods.push({
        date: rebalanceDate,
        holdings: [...holdings],
        cash,
        totalValue: curValue,
        trades: periodTrades,
        dailyReturns: periodReturn,
      });
    }

    // 5. Calculate summary statistics
    const finalValue = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].value : config.initialCapital;
    const values = equityCurve.map(v => v.value);
    const dailyReturns = calcDailyReturn(values);
    const totalReturn = config.initialCapital > 0
      ? ((finalValue / config.initialCapital) - 1) * 100
      : 0;

    const startDate = new Date(config.startDate);
    const endDate = new Date(config.endDate);
    const years = (endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    const annualizedReturn = years > 0
      ? (Math.pow(finalValue / config.initialCapital, 1 / years) - 1) * 100
      : 0;

    // Benchmark return
    let benchmarkReturn: number | undefined;
    if (benchmarkData.length >= 2) {
      const first = benchmarkData[0].close;
      const last = benchmarkData[benchmarkData.length - 1].close;
      benchmarkReturn = first > 0 ? ((last / first) - 1) * 100 : 0;
    }

    // Benchmark daily returns for Alpha/Beta/IR
    let benchmarkDailyReturns: number[] = [];
    if (benchmarkData.length >= 2) {
      const bmValues = benchmarkData.map(b => b.close);
      benchmarkDailyReturns = calcDailyReturn(bmValues);
    }

    const { alpha, beta } = calcAlphaBeta(dailyReturns, benchmarkDailyReturns);
    const maxDd = calcMaxDrawdown(values);
    const calmarRatio = calcCalmarRatio(annualizedReturn, maxDd);
    const informationRatio = calcInformationRatio(dailyReturns, benchmarkDailyReturns);
    const maxConsecutiveLosses = calcMaxConsecutiveLosses(dailyReturns);

    const excessReturn = benchmarkReturn !== undefined
      ? parseFloat((totalReturn - benchmarkReturn).toFixed(2))
      : undefined;

    const summary: BacktestSummary = {
      totalReturn: parseFloat(totalReturn.toFixed(2)),
      annualizedReturn: parseFloat(annualizedReturn.toFixed(2)),
      maxDrawdown: parseFloat(maxDd.toFixed(2)),
      winRate: parseFloat(calcWinRate(periods.map(p => p.dailyReturns)).toFixed(1)),
      totalTrades: allTrades.length,
      sharpeRatio: parseFloat(calcSharpeRatio(dailyReturns).toFixed(3)),
      volatility: parseFloat((dailyReturns.length > 0
        ? Math.sqrt(dailyReturns.reduce((a, b) => a + b ** 2, 0) / dailyReturns.length) * Math.sqrt(252) * 100
        : 0
      ).toFixed(2)),
      profitFactor: parseFloat(calcProfitFactor(allTrades).toFixed(2)),
      finalCapital: parseFloat(finalValue.toFixed(2)),
      benchmarkReturn: benchmarkReturn !== undefined ? parseFloat(benchmarkReturn.toFixed(2)) : undefined,
      excessReturn,
      alpha,
      beta,
      calmarRatio,
      informationRatio,
      maxConsecutiveLosses,
    };

    console.log(`\n[Backtest] === Summary ===`);
    console.log(`  Total Return: ${summary.totalReturn}%`);
    console.log(`  Annualized: ${summary.annualizedReturn}%`);
    console.log(`  Max Drawdown: ${summary.maxDrawdown}%`);
    console.log(`  Sharpe: ${summary.sharpeRatio}`);
    console.log(`  Alpha: ${summary.alpha}%`);
    console.log(`  Beta: ${summary.beta}`);
    console.log(`  Benchmark: ${summary.benchmarkReturn ?? 'N/A'}%`);
    console.log(`  Trades: ${summary.totalTrades}`);
    console.log(`  Final: ¥${summary.finalCapital.toLocaleString()}`);

    // 6. Compute multi-timeframe analysis
    const timeframeAnalysis = computeTimeframeAnalysis(equityCurve, config.initialCapital);
    console.log(`[Backtest] Timeframe analysis: ${timeframeAnalysis.yearly.length}y / ${timeframeAnalysis.quarterly.length}q / ${timeframeAnalysis.monthly.length}m`);

    // 7. Compute tech tree / heatmap analysis
    const techTree = computeTechTreeAnalysis(equityCurve);
    console.log(`[Backtest] Tech tree: ${techTree.regimeHeatmap.cells.length}x${techTree.regimeHeatmap.trendLabels.length} heatmap, ${techTree.monthlySeasonality.length} months`);

    return {
      config,
      periods,
      summary,
      equityCurve,
      trades: allTrades,
      timeframeAnalysis,
      techTree,
    };
  }
}
