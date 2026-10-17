import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SwappableToken, TokenBalance } from "../../src/types.js";

/**
 * A balance with no price is not worth $1 a unit, and it is not dust.
 *
 * The EVM and Stacks token paths valued anything unpriceable at a flat $1 per
 * unit, which RiskManager then sized positions against as though it had been
 * observed: a million units of an unpriceable token read as a $1M holding.
 * Valuing it at 0 instead is only half the fix — at 0 the dust filter would
 * drop it, hiding a real holding of unknown value. So it is kept, at 0, and
 * flagged.
 */
describe("unpriced balances", { timeout: 30_000 }, () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const baseEnv = { ...process.env };

  const PRICES: Record<string, number | null> = { ETH: 3000, AERO: 1, MYST: null };
  const UNITS: Record<string, bigint> = {
    "0x00000000000000000000000000000000000000a1": 1_000_000n * 10n ** 18n, // MYST, unpriced
    "0x00000000000000000000000000000000000000a2": 10n ** 17n, // 0.1 AERO, priced dust
  };

  const tokens: SwappableToken[] = [
    { contractId: "0x00000000000000000000000000000000000000a1", symbol: "MYST", name: "MYST", decimals: 18, chainFamily: "evm", chainId: "base:mainnet" },
    { contractId: "0x00000000000000000000000000000000000000a2", symbol: "AERO", name: "AERO", decimals: 18, chainFamily: "evm", chainId: "base:mainnet" },
  ];

  async function balances(): Promise<TokenBalance[]> {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.ENABLED_CHAINS = "base:mainnet";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    const { ConfigManager } = await import("../../src/config.js");
    ConfigManager.reset();
    ConfigManager.load();

    const { ChainAdapterRegistry } = await import("../../src/services/chains/chainAdapterRegistry.js");
    ChainAdapterRegistry.getInstance().reset();
    const { registerEnabledChains } = await import("../../src/services/chains/registerChains.js");
    registerEnabledChains();

    const { PortfolioManager } = await import("../../src/services/portfolio.js");
    return PortfolioManager.getInstance().fetchBalances(ADDRESS, tokens, undefined, false, "base:mainnet");
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/services/chains/evm/evmClient.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      publicClientFor: () => ({
        getBalance: async () => 10n ** 18n, // 1 ETH
        readContract: async ({ address }: { address: string }) => UNITS[address.toLowerCase()] ?? 0n,
      }),
    }));
    vi.doMock("../../src/services/chains/evm/multicall.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      hasMulticall3: async () => false,
    }));
    vi.doMock("../../src/services/dex/dexRegistry.js", () => ({
      DEXRegistry: {
        getInstance: () => ({
          registerProvider: () => undefined,
          getTokenPrice: async (symbol: string) => PRICES[symbol] ?? null,
        }),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../src/services/chains/evm/evmClient.js");
    vi.doUnmock("../../src/services/chains/evm/multicall.js");
    vi.doUnmock("../../src/services/dex/dexRegistry.js");
    process.env = { ...baseEnv };
  });

  it("values an unpriced token at 0, flagged, rather than $1 a unit", async () => {
    const myst = (await balances()).find((b) => b.symbol === "MYST");
    expect(myst).toEqual({
      token: "0x00000000000000000000000000000000000000a1",
      symbol: "MYST",
      balance: 1_000_000,
      usdValue: 0,
      unpriced: true,
    });
  });

  it("keeps the unpriced holding visible while still filtering priced dust", async () => {
    const symbols = (await balances()).map((b) => b.symbol).sort();
    // ETH is $3000 and kept; AERO is a priced $0.10, below the $0.50 default.
    expect(symbols).toEqual(["ETH", "MYST"]);
  });

  it("leaves priced balances unflagged", async () => {
    const eth = (await balances()).find((b) => b.symbol === "ETH");
    expect(eth).toMatchObject({ usdValue: 3000 });
    expect(eth).not.toHaveProperty("unpriced");
  });
});
