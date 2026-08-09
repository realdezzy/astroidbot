import { describe, it, expect } from "vitest";
import { priceFromSqrtX96, toHuman } from "../../../src/services/indexer/priceMath.js";

const Q96 = 2n ** 96n;

/** sqrtPriceX96 for a given raw-unit price, i.e. the inverse of the decode. */
function sqrtX96For(price: number): bigint {
  return BigInt(Math.floor(Math.sqrt(price) * Number(Q96)));
}

describe("priceFromSqrtX96", () => {
  it("decodes a 1:1 pool with matching decimals", () => {
    expect(priceFromSqrtX96(Q96, 18, 18)).toBeCloseTo(1, 9);
  });

  it("adjusts for differing decimals", () => {
    // A WETH(18)/USDC(6) pool at raw ratio 1 is really 1e-12 in human terms.
    expect(priceFromSqrtX96(Q96, 18, 6)).toBeCloseTo(1e12, 0);
    expect(priceFromSqrtX96(Q96, 6, 18)).toBeCloseTo(1e-12, 24);
  });

  it("does not overflow on a high-priced pair", () => {
    // The reason this module exists: Number(sqrtPriceX96)**2 is ~1e57 here and
    // silently becomes Infinity, which then poisons every downstream price.
    const sqrt = sqrtX96For(1e12);
    const price = priceFromSqrtX96(sqrt, 18, 18);

    expect(Number.isFinite(price)).toBe(true);
    expect(price).toBeGreaterThan(0);
    expect(price / 1e12).toBeCloseTo(1, 3);
  });

  it("stays precise on a dust-priced pair", () => {
    const sqrt = sqrtX96For(1e-9);
    const price = priceFromSqrtX96(sqrt, 18, 18);

    expect(price).toBeGreaterThan(0);
    expect(price / 1e-9).toBeCloseTo(1, 3);
  });

  it("treats a zero or negative sqrt price as unpriceable rather than NaN", () => {
    expect(priceFromSqrtX96(0n, 18, 18)).toBe(0);
    expect(priceFromSqrtX96(-1n, 18, 18)).toBe(0);
  });

  it("round-trips a realistic ETH/USDC pool price", () => {
    // ~$3,000 per ETH, expressed as token1(USDC,6) per token0(WETH,18).
    const humanPrice = 3000;
    const rawPrice = humanPrice * 10 ** (6 - 18);
    const decoded = priceFromSqrtX96(sqrtX96For(rawPrice), 18, 6);

    expect(decoded / humanPrice).toBeCloseTo(1, 3);
  });
});

describe("toHuman", () => {
  it("scales by decimals", () => {
    expect(toHuman(1_000_000n, 6)).toBe(1);
    expect(toHuman(10n ** 18n, 18)).toBe(1);
  });

  it("keeps the sign, which is what distinguishes a buy from a sell", () => {
    expect(toHuman(-2_500_000n, 6)).toBeCloseTo(-2.5, 9);
  });

  it("keeps sub-unit precision", () => {
    expect(toHuman(1_500_000n, 6)).toBeCloseTo(1.5, 9);
    expect(toHuman(1n, 18)).toBeCloseTo(1e-18, 24);
  });

  it("handles amounts far beyond Number.MAX_SAFE_INTEGER", () => {
    // 1e12 tokens at 18 decimals is ~1e30 raw — well past a double's integer
    // range, so the whole/fraction split is doing real work here.
    const raw = 10n ** 30n;
    expect(toHuman(raw, 18) / 1e12).toBeCloseTo(1, 6);
  });
});
