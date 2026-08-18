import { describe, expect, it } from "vitest";
import { PoolStateEngine } from "../../../src/services/indexer/state/poolStateEngine.js";
import type { TrackedPool } from "../../../src/services/indexer/types.js";
import type { SwapEvent } from "../../../src/services/indexer/events/canonical.js";

describe("PoolStateEngine", () => {
  const engine = PoolStateEngine.getInstance();
  const pool: TrackedPool = {
    id: 10,
    chainId: "base:mainnet",
    dexId: "uniswap-v3",
    poolAddress: "0xpool10",
    token0: "0xtokenA",
    token1: "0xtokenB",
    decimals0: 18,
    decimals1: 6,
    feeTier: 3000,
  };

  it("updates pool state correctly upon processing a SwapEvent", () => {
    engine.clear();
    const swap: SwapEvent = {
      chainId: "base:mainnet",
      dexId: "uniswap-v3",
      poolId: 10,
      poolAddress: "0xpool10",
      txKey: "0xtx:1",
      txHash: "0xtx",
      blockNumber: 100n,
      logIndex: 1,
      timestamp: 1600000000000,
      tokenIn: "0xtokenA",
      tokenOut: "0xtokenB",
      amountIn: 1000000000000000000n,
      amountOut: 3000000000n,
      price0In1: 3000,
      priceUsd: 3000,
    };

    const state = engine.processSwap(swap, pool);
    expect(state.price0In1).toBe(3000);
    expect(state.txns24h).toBe(1);
    expect(state.volume24hUsd).toBe(3000);
    expect(state.poolAddress).toBe("0xpool10");
  });
});
