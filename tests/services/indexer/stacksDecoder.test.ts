import { describe, it, expect } from "vitest";
import {
  decodeStacksSwapPrint,
  canDecodeStacksDex,
} from "../../../src/services/indexer/stacks/printDecoder.js";

/**
 * Reading Stacks swap prints.
 *
 * The payloads below are verbatim from mainnet — the first swap each contract
 * emitted when this was written. Synthesising them would have missed the thing
 * that actually shaped this decoder: the two protocols share no field names at
 * all, and Velar's amounts are relative to the *swap* while ALEX's are relative
 * to the *pair*.
 */

const ALEX_SWAP =
  '(tuple (action "swap-y-for-x") (data (tuple (balance-x u58006646946934) (balance-y u4084800145077387) ' +
  "(end-block u340282366920938463463374607431768211455) (fee-rate-x u500000) (fee-rate-y u500000) " +
  "(pool-id u13) (total-supply u2675498107711358))) (dx u3423523318) (dy u242280000000) (fee u1211400000) " +
  '(object "pool") (sender \'SPZ05RYAJZZ6Y99AA3B86HKXGNAJE851R3HZRHN3) ' +
  "(token-x 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2) " +
  "(token-y 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex))";

const VELAR_SWAP =
  "(tuple (a u42846587231) (amt-fee-lps u76719) (amt-in u34096900) (amt-out u4625828) " +
  '(b0 u42846663950) (b1 u5825738441) (id u6) (op "swap") ' +
  "(pool (tuple (reserve0 u42812592622) (reserve1 u5830364269) " +
  '(symbol "wSTX-aeUSDC") ' +
  "(token0 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx) " +
  "(token1 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc))) " +
  "(token-in 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx) " +
  "(token-out 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc) " +
  "(user 'SP2H674PRTZV6YW56K0FMR7GDGZE4ZC5HMYZ3CDEV.swag))";

describe("Stacks swap print decoding", () => {
  it("knows which protocols it can read", () => {
    // A contract with no dialect would be polled every tick and yield nothing,
    // which reads as "this DEX has no volume" rather than as a gap.
    expect(canDecodeStacksDex("alex")).toBe(true);
    expect(canDecodeStacksDex("velar")).toBe(true);
    expect(canDecodeStacksDex("some-new-amm")).toBe(false);
  });

  describe("ALEX", () => {
    it("reads the pair, amounts and reserves", () => {
      const swap = decodeStacksSwapPrint(ALEX_SWAP, "alex")!;

      expect(swap.poolKey).toBe("13");
      expect(swap.token0).toBe("SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2");
      expect(swap.token1).toBe("SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex");
      expect(swap.amount0).toBe(3_423_523_318n);
      expect(swap.amount1).toBe(242_280_000_000n);
      expect(swap.reserve0).toBe(58_006_646_946_934n);
      expect(swap.reserve1).toBe(4_084_800_145_077_387n);
    });

    it("takes direction from the action, not from field order", () => {
      // dx/dy are always x-then-y whichever way the trade went, so the action
      // name is the only thing that says which side was sold.
      expect(decodeStacksSwapPrint(ALEX_SWAP, "alex")!.zeroForOne).toBe(false);

      const reversed = ALEX_SWAP.replace("swap-y-for-x", "swap-x-for-y");
      expect(decodeStacksSwapPrint(reversed, "alex")!.zeroForOne).toBe(true);
    });

    it("ignores prints that aren't swaps", () => {
      // These contracts also print for liquidity, governance and fees. Every
      // tick sees far more of those than swaps.
      const addLiquidity = ALEX_SWAP.replace("swap-y-for-x", "add-to-position");
      expect(decodeStacksSwapPrint(addLiquidity, "alex")).toBeNull();
    });
  });

  describe("Velar", () => {
    it("assigns in/out amounts to the pair by comparing token-in", () => {
      // amt-in/amt-out are relative to the swap, not the pair. Reading them
      // positionally would invert every sell — and produce a price that looks
      // plausible, which is the worst kind of wrong.
      const swap = decodeStacksSwapPrint(VELAR_SWAP, "velar")!;

      expect(swap.token0).toBe("SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx");
      expect(swap.zeroForOne).toBe(true);
      expect(swap.amount0).toBe(34_096_900n); // amt-in, because token-in is token0
      expect(swap.amount1).toBe(4_625_828n); // amt-out
    });

    it("swaps the assignment when the trade goes the other way", () => {
      const sell = VELAR_SWAP.replace(
        "(token-in 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx)",
        "(token-in 'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc)"
      );

      const swap = decodeStacksSwapPrint(sell, "velar")!;
      expect(swap.zeroForOne).toBe(false);
      expect(swap.amount0).toBe(4_625_828n); // now the out amount
      expect(swap.amount1).toBe(34_096_900n); // now the in amount
    });

    it("takes reserves from b0/b1, which are post-swap", () => {
      // The nested reserve0/reserve1 are the *pre*-swap values; a pool's
      // recorded liquidity should include the trade that just happened.
      const swap = decodeStacksSwapPrint(VELAR_SWAP, "velar")!;
      expect(swap.reserve0).toBe(42_846_663_950n);
      expect(swap.reserve1).toBe(5_825_738_441n);
    });
  });

  it("refuses a print missing an amount rather than inferring one", () => {
    // Half a swap cannot become a candle, and reconstructing the missing side
    // from reserves would invent a trade that didn't happen.
    const truncated = ALEX_SWAP.replace("(dy u242280000000) ", "");
    expect(decodeStacksSwapPrint(truncated, "alex")).toBeNull();
  });

  it("drops zero-amount swaps", () => {
    // A no-op the contract still announces. Recorded, it adds a transaction to
    // the count and a price of zero to the candle.
    const zero = ALEX_SWAP.replace("(dx u3423523318)", "(dx u0)");
    expect(decodeStacksSwapPrint(zero, "alex")).toBeNull();
  });

  it("reads a principal containing dots and hyphens whole", () => {
    // The regression a lazy match would cause: `SP….token-wstx-v2` truncated
    // at the first hyphen is a different token, and it would silently create a
    // second pool for the same pair.
    const swap = decodeStacksSwapPrint(ALEX_SWAP, "alex")!;
    expect(swap.token0.endsWith("token-wstx-v2")).toBe(true);
  });

  it("returns null for a dialect it doesn't have", () => {
    expect(decodeStacksSwapPrint(ALEX_SWAP, "unknown-dex")).toBeNull();
  });
});
