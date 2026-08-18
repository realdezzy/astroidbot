import { describe, expect, it } from "vitest";
import { UniswapV3Adapter } from "../../src/services/indexer/protocols/uniswapV3Adapter.js";
import { PoolStateEngine } from "../../src/services/indexer/state/poolStateEngine.js";
import { EventBus } from "../../src/services/indexer/bus/eventBus.js";
import type { TrackedPool } from "../../src/services/indexer/types.js";
import type { SwapEvent } from "../../src/services/indexer/events/canonical.js";

describe("Market Data Pipeline Integration", () => {
  it("processes synthetic EVM log through UniswapV3Adapter, PoolStateEngine, and EventBus", async () => {
    const adapter = new UniswapV3Adapter();
    const stateEngine = PoolStateEngine.getInstance();
    const eventBus = EventBus.getInstance();
    stateEngine.clear();
    eventBus.clear();

    const pool: TrackedPool = {
      id: 99,
      chainId: "base:mainnet",
      dexId: "uniswap-v3",
      poolAddress: "0xpool99",
      token0: "0xweth",
      token1: "0xusdc",
      decimals0: 18,
      decimals1: 6,
      feeTier: 500,
    };

    const rawLog = {
      args: {
        amount0: -2000000000000000000n, // 2 ETH bought
        amount1: 6000000000n, // $6,000 USDC paid
        sqrtPriceX96: 433410000000000000000000000000n,
        recipient: "0xtrader99",
        sender: "0xrouter",
      },
      transactionHash: "0xtx99",
      blockNumber: 500000n,
      logIndex: 0,
    };

    const canonicalSwap = adapter.decodeSwap(pool, rawLog);
    expect(canonicalSwap).not.toBeNull();

    let publishedEvent: SwapEvent | null = null;
    eventBus.subscribeSwaps(async (evt) => {
      publishedEvent = evt;
    });

    if (canonicalSwap) {
      await eventBus.publishSwap(canonicalSwap);
      const updatedState = stateEngine.processSwap(canonicalSwap, pool);

      expect(updatedState.poolAddress).toBe("0xpool99");
      expect(updatedState.txns24h).toBe(1);
      expect(publishedEvent).not.toBeNull();
      expect((publishedEvent as unknown as SwapEvent).txHash).toBe("0xtx99");
    }
  });
});
