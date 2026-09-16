import { describe, it, expect } from "vitest";
import { AerodromeAdapter } from "../../../src/services/indexer/protocols/aerodromeAdapter.js";
import type { TrackedPool } from "../../../src/services/indexer/types.js";

/**
 * Slipstream ingestion decoding.
 *
 * The riskiest unproven link in the tokenized-stock work was whether the EVM
 * indexer could read Aerodrome's concentrated-liquidity pools at all: it treats
 * them as Uniswap V3, and if the event shapes differ, ingestion silently reads
 * zero swaps (blank volume/liquidity, no error). The Swap fixture below is a
 * real log pulled from the deep NVDAc/USDC pool on Base (ts=10, the newest
 * factory), not a hand-written one.
 */

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NVDAc = "0xb20000000000000000000078ee7ce2fe4908108c";

const pool: TrackedPool = {
  id: 1,
  chainId: "base:mainnet",
  poolAddress: "0x853f5f1b92b16714fe6cda67caad0856b83c7ab9",
  dexId: "aerodrome-slipstream",
  token0: USDC,
  token1: NVDAc,
  decimals0: 6,
  decimals1: 8,
  feeTier: null,
};

describe("Aerodrome Slipstream decoding", () => {
  it("decodes a real Slipstream Swap log (7-field Uniswap-V3 layout)", () => {
    const log = {
      args: {
        sender: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
        recipient: "0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98",
        amount0: 14112551n,
        amount1: -6613624n,
        sqrtPriceX96: 54250682215128794160032327636n,
        liquidity: 215838421114382n,
        tick: -7575,
      },
      transactionHash: "0xd4382cda31f6ae8a34ecb8eb104bb3b8ccf84c8157ce5ee1aeb5ba85860527da",
      blockNumber: 51382423n,
      logIndex: 39,
    };

    const decoded = new AerodromeAdapter("aerodrome-slipstream").decodeSwap(pool, log);

    expect(decoded).not.toBeNull();
    // The trader paid USDC (token0 up in the pool) and received NVDAc.
    expect(decoded!.tokenIn).toBe(USDC);
    expect(decoded!.tokenOut).toBe(NVDAc);
    expect(decoded!.amountIn).toBe(14112551n);
    expect(decoded!.amountOut).toBe(6613624n);
    expect(decoded!.traderAddress).toBe("0x4ee35c658b8032a7577096b60bd51ae9909e4f98");
    expect(decoded!.txKey).toBe(
      "0xd4382cda31f6ae8a34ecb8eb104bb3b8ccf84c8157ce5ee1aeb5ba85860527da:39"
    );
    // ~0.00469 NVDAc per USDC, i.e. ~$213 per NVDAc — matches the Chainlink feed.
    expect(decoded!.price0In1).toBeCloseTo(0.004688686984655967, 12);
  });

  it("decodes a Slipstream PoolCreated into a trackable pool", () => {
    // Shape from ICLPoolEvents.PoolCreated — tickSpacing in place of a fee tier.
    const log = {
      args: {
        token0: USDC,
        token1: NVDAc,
        tickSpacing: 10n,
        pool: pool.poolAddress,
      },
      blockNumber: 50_000_000n,
    };

    const decoded = new AerodromeAdapter("aerodrome-slipstream").decodePoolCreated(log, "base:mainnet");

    expect(decoded).not.toBeNull();
    expect(decoded!.dexId).toBe("aerodrome-slipstream");
    expect(decoded!.poolAddress).toBe(pool.poolAddress);
    expect(decoded!.token0).toBe(USDC);
    expect(decoded!.token1).toBe(NVDAc);
    // Slipstream has no fee tier; the tick spacing is not a fee.
    expect(decoded!.feeTier).toBeNull();
  });
});
