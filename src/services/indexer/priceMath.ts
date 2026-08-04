/**
 * Fixed-point conversions for Uniswap V3 pool state.
 *
 * These are the one place in the indexer where precision actually matters. A
 * pool's price arrives as a Q64.96 square root, and the naive
 * `Number(sqrtPriceX96) ** 2` overflows to Infinity for any high-priced pair
 * while looking fine for the low-priced ones you'd test with.
 */

const Q96 = 2n ** 96n;

/**
 * Price of token0 denominated in token1, adjusted for both tokens' decimals.
 *
 * Derivation: sqrtPriceX96 = sqrt(price) * 2^96 where price is token1/token0
 * in raw units. So price = (sqrtPriceX96 / 2^96)^2, then scaled by
 * 10^(decimals0 - decimals1) to move from raw units to human units.
 *
 * The division is done in BigInt with a scaling factor before converting to
 * Number, so neither the square nor the decimal adjustment can overflow.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): number {
  if (sqrtPriceX96 <= 0n) return 0;

  // Scale up before squaring so integer division keeps ~18 significant digits.
  const SCALE = 10n ** 18n;
  const ratio = (sqrtPriceX96 * SCALE) / Q96; // sqrt(price) * 1e18
  const squared = (ratio * ratio) / SCALE; // price * 1e18, raw units

  const decimalAdjust = decimals0 - decimals1;
  let numerator = squared;
  let denominator = SCALE;

  if (decimalAdjust > 0) {
    numerator *= 10n ** BigInt(decimalAdjust);
  } else if (decimalAdjust < 0) {
    denominator *= 10n ** BigInt(-decimalAdjust);
  }

  // Only now is the magnitude guaranteed to fit a double.
  return Number(numerator) / Number(denominator);
}

/** Raw token amount to a human-scale float. */
export function toHuman(amount: bigint, decimals: number): number {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);

  const whole = abs / divisor;
  const fraction = abs % divisor;

  const value = Number(whole) + Number(fraction) / Number(divisor);
  return negative ? -value : value;
}
