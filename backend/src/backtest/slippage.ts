/**
 * Slippage Models — realistic trade execution costs for backtesting.
 *
 * Features:
 *   - Fixed slippage (e.g., 0.1% per trade)
 *   - Volume-proportional slippage (larger orders get worse fills)
 *   - Combined: base slippage + volume premium
 */

// ===== Slippage Configuration =====

export interface SlippageConfig {
  /** Base slippage ratio (e.g., 0.001 for 0.1%) */
  baseRatio: number;
  /** Volume impact: additional slippage per % of daily volume traded */
  volumeImpactRatio: number;
  /** Maximum order size as fraction of daily volume (default 20%) */
  maxOrderVolumeRatio: number;
}

export const DEFAULT_SLIPPAGE: SlippageConfig = {
  baseRatio: 0.001,        // 0.1% base slippage
  volumeImpactRatio: 0.005, // 0.5% additional per 10% of daily volume
  maxOrderVolumeRatio: 0.2, // max 20% of daily volume
};

// ===== Slippage Calculation =====

/**
 * Calculate effective buy price after slippage.
 * Buy price = price * (1 + slippageRatio)
 */
export function buyPrice(price: number, slippageRatio: number): number {
  return price * (1 + slippageRatio);
}

/**
 * Calculate effective sell price after slippage.
 * Sell price = price * (1 - slippageRatio)
 */
export function sellPrice(price: number, slippageRatio: number): number {
  return price * (1 - slippageRatio);
}

/**
 * Compute the total slippage ratio for an order.
 *
 * @param orderValue - The total value of the order in yuan
 * @param dailyVolume - The stock's total daily trading volume in yuan
 * @param config - Slippage configuration (optional, defaults used)
 * @returns The slippage ratio (e.g., 0.001 for 0.1%)
 */
export function computeSlippage(
  orderValue: number,
  dailyVolume: number,
  config: SlippageConfig = DEFAULT_SLIPPAGE,
): number {
  // Base slippage
  let slippage = config.baseRatio;

  // Volume-proportional premium
  if (dailyVolume > 0) {
    const volumeRatio = Math.min(orderValue / dailyVolume, config.maxOrderVolumeRatio);
    slippage += (volumeRatio / 0.10) * config.volumeImpactRatio; // normalized to 10% volume
  }

  return slippage;
}

/**
 * Check if an order exceeds the maximum allowed volume.
 * If it does, only a portion of the order can be filled.
 *
 * @returns The fillable fraction (0.0 to 1.0)
 */
export function getFillFraction(
  orderValue: number,
  dailyVolume: number,
  config: SlippageConfig = DEFAULT_SLIPPAGE,
): number {
  if (dailyVolume <= 0) return 0; // No liquidity
  if (orderValue <= 0) return 1;

  const ratio = orderValue / dailyVolume;
  if (ratio <= config.maxOrderVolumeRatio) return 1; // Fully fillable

  // Partial fill: only maxOrderVolumeRatio fraction can be filled
  return config.maxOrderVolumeRatio / ratio;
}

/**
 * Calculate effective buy price including slippage, with fill constraints.
 *
 * @returns { price: number; fillFraction: number; slippagePaid: number }
 */
export function calculateBuyExecution(
  price: number,
  orderValue: number,
  dailyVolume: number,
  config: SlippageConfig = DEFAULT_SLIPPAGE,
): { price: number; fillFraction: number; slippagePaid: number } {
  const slippageRatio = computeSlippage(orderValue, dailyVolume, config);
  const fillFraction = getFillFraction(orderValue, dailyVolume, config);
  const effectivePrice = buyPrice(price, slippageRatio);
  const slippagePaid = effectivePrice - price; // per share slippage

  return { price: effectivePrice, fillFraction, slippagePaid };
}

/**
 * Calculate effective sell price including slippage, with fill constraints.
 *
 * @returns { price: number; fillFraction: number; slippagePaid: number }
 */
export function calculateSellExecution(
  price: number,
  orderValue: number,
  dailyVolume: number,
  config: SlippageConfig = DEFAULT_SLIPPAGE,
): { price: number; fillFraction: number; slippagePaid: number } {
  const slippageRatio = computeSlippage(orderValue, dailyVolume, config);
  const fillFraction = getFillFraction(orderValue, dailyVolume, config);
  const effectivePrice = sellPrice(price, slippageRatio);
  const slippagePaid = price - effectivePrice; // per share slippage cost

  return { price: effectivePrice, fillFraction, slippagePaid };
}
