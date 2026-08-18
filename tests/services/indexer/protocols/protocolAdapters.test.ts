import { describe, expect, it } from "vitest";
import { UniswapV3Adapter } from "../../../../src/services/indexer/protocols/uniswapV3Adapter.js";
import { StacksAlexVelarAdapter } from "../../../../src/services/indexer/protocols/stacksAlexVelarAdapter.js";
import { SolanaJupiterAdapter } from "../../../../src/services/indexer/protocols/solanaJupiterAdapter.js";
import { BitflowAdapter } from "../../../../src/services/indexer/protocols/bitflowAdapter.js";
import { PumpFunAdapter } from "../../../../src/services/indexer/protocols/pumpFunAdapter.js";
import { RaydiumAdapter } from "../../../../src/services/indexer/protocols/raydiumAdapter.js";
import { DexAdapterRegistry } from "../../../../src/services/indexer/protocols/dexAdapterRegistry.js";
import type { TrackedPool } from "../../../../src/services/indexer/types.js";

describe("DexAdapterRegistry", () => {
  it("resolves adapters for EVM, Stacks, and Solana DEXes", () => {
    const registry = DexAdapterRegistry.getInstance();

    expect(registry.getAdapter("uniswap-v3", "base:mainnet")).toBeInstanceOf(UniswapV3Adapter);
    expect(registry.getAdapter("alex", "stacks:mainnet")).toBeInstanceOf(StacksAlexVelarAdapter);
    expect(registry.getAdapter("jupiter", "solana:mainnet")).toBeInstanceOf(SolanaJupiterAdapter);
    expect(registry.getAdapter("bitflow", "stacks:mainnet")).toBeInstanceOf(BitflowAdapter);
    expect(registry.getAdapter("pumpfun", "solana:mainnet")).toBeInstanceOf(PumpFunAdapter);
    expect(registry.getAdapter("raydium", "solana:mainnet")).toBeInstanceOf(RaydiumAdapter);
  });
});

describe("UniswapV3Adapter", () => {
  const adapter = new UniswapV3Adapter();
  const pool: TrackedPool = {
    id: 1,
    chainId: "base:mainnet",
    dexId: "uniswap-v3",
    poolAddress: "0xpool",
    token0: "0xeth",
    token1: "0xusdc",
    decimals0: 18,
    decimals1: 6,
    feeTier: 500,
  };

  it("decodes EVM V3 swap logs into canonical SwapEvents", () => {
    const rawLog = {
      args: {
        amount0: -1000000000000000000n, // Trader bought ETH (token0)
        amount1: 3000000000n, // Trader paid USDC (token1)
        sqrtPriceX96: 433410000000000000000000000000n,
        recipient: "0xtrader",
        sender: "0xrouter",
      },
      transactionHash: "0xtxhash",
      blockNumber: 123456n,
      logIndex: 2,
    };

    const event = adapter.decodeSwap(pool, rawLog);
    expect(event).not.toBeNull();
    expect(event?.chainId).toBe("base:mainnet");
    expect(event?.poolId).toBe(1);
    expect(event?.txKey).toBe("0xtxhash:2");
    expect(event?.tokenIn).toBe("0xusdc");
    expect(event?.tokenOut).toBe("0xeth");
    expect(event?.amountIn).toBe(3000000000n);
    expect(event?.amountOut).toBe(1000000000000000000n);
  });
});
