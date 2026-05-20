/**
 * Trading Rules — realistic market constraints for backtesting.
 *
 * Features:
 *   - Limit up/down check per exchange
 *   - Suspension detection (no trade on suspended days)
 *   - Rebalance filtering: can't buy limit-up stocks, can't sell limit-down stocks
 */

// ===== Limit Up/Down =====

/** Get the price limit ratio for a given market */
export function getPriceLimitRatio(market: 'SH' | 'SZ' | 'BJ'): number {
  switch (market) {
    case 'SH':
      return 0.10; // 主板 ±10%
    case 'SZ':
      return 0.10; // 主板 ±10% (创业板/科创板 handled separately if we know listing board)
    case 'BJ':
      return 0.30; // 北交所 ±30%
    default:
      return 0.10;
  }
}

/**
 * Check if a stock is limit-up (涨停)
 * A stock is considered limit-up if its change percent >= (limitRatio - 0.001 tolerance)
 */
export function isLimitUp(changePercent: number, market: 'SH' | 'SZ' | 'BJ'): boolean {
  const limit = getPriceLimitRatio(market);
  return changePercent >= (limit - 0.01) * 100; // tolerance for rounding
}

/**
 * Check if a stock is limit-down (跌停)
 */
export function isLimitDown(changePercent: number, market: 'SH' | 'SZ' | 'BJ'): boolean {
  const limit = getPriceLimitRatio(market);
  return changePercent <= -(limit - 0.01) * 100;
}

// ===== Suspension Detection =====

/**
 * Detect if a stock is likely suspended on a given day.
 * Suspension heuristic: if open == 0 and close == 0 and volume == 0, it's suspended.
 * Also if price hasn't changed for multiple consecutive days (possible).
 */
export function isSuspended(kline: { open: number; high: number; low: number; close: number; volume: number }): boolean {
  // Primary heuristic: zero volume and zero price movement
  if (kline.volume === 0) return true;

  // Secondary: all prices are 0 (data missing)
  if (kline.open === 0 && kline.high === 0 && kline.low === 0 && kline.close === 0) return true;

  return false;
}

// ===== Filter Functions =====

export interface RebalanceFilter {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  price: number;
  changePercent: number;
  /** Whether this stock is blocked from buying (limit-up) */
  buyBlocked: boolean;
  /** Whether this stock is blocked from selling (limit-down or suspended) */
  sellBlocked: boolean;
  /** Reason for blocking */
  blockReason?: string;
}

/**
 * Apply trading rules to filter stocks for rebalancing.
 * Returns filtered candidates with block status.
 */
export function applyTradingRules(
  snapshot: Array<{
    code: string;
    name: string;
    market: 'SH' | 'SZ' | 'BJ';
    price: number;
    changePercent: number;
    volume: number;
    open: number;
    high: number;
    low: number;
  }>,
): RebalanceFilter[] {
  return snapshot.map(s => {
    const suspended = isSuspended({ open: s.open, high: s.high, low: s.low, close: s.price, volume: s.volume });
    const limitUp = !suspended && isLimitUp(s.changePercent, s.market);
    const limitDown = !suspended && isLimitDown(s.changePercent, s.market);

    const buyBlocked = suspended || limitUp;
    const sellBlocked = suspended || limitDown;

    let blockReason: string | undefined;
    if (suspended) blockReason = '停牌';
    else if (limitUp) blockReason = '涨停';
    else if (limitDown) blockReason = '跌停';

    return {
      code: s.code,
      name: s.name,
      market: s.market,
      price: s.price,
      changePercent: s.changePercent,
      buyBlocked,
      sellBlocked,
      blockReason: blockReason || undefined,
    };
  });
}

/**
 * Check if a stock is blocked from buying on a given day.
 * Used during rebalancing to avoid buying limit-up/suspended stocks.
 */
export function canBuy(filter: RebalanceFilter): boolean {
  return !filter.buyBlocked;
}

/**
 * Check if a stock is blocked from selling on a given day.
 * Used during rebalancing to avoid selling limit-down/suspended stocks.
 */
export function canSell(filter: RebalanceFilter): boolean {
  return !filter.sellBlocked;
}
