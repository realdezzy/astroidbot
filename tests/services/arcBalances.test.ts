import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SwappableToken, TokenBalance } from "../../src/types.js";

/**
 * On Arc, the native balance and the USDC ERC-20 balance are one holding.
 *
 * `0x3600…0000` is not a token the wallet holds *alongside* its gas — it is
 * the same balance `eth_getBalance` returns, viewed at 6 decimals instead of
 * 18. Verified on eight live mainnet accounts, where `balanceOf` equalled
 * `eth_getBalance / 1e12` to the unit.
 *
 * `fetchEvmBalances` reads both: it pushes a row for the native asset, then
 * batches `balanceOf` across the curated token list and pushes a row for each
 * non-zero result. On every other chain those are disjoint. On Arc they are
 * the same money, so without the `nativeErc20` check the wallet reports twice
 * what it holds — and that figure feeds RiskManager position sizing, so an
 * Arc user's effective exposure cap would be double what they set.
 */
// Each case rebuilds the module graph (vi.resetModules) so the chain registry
// and ConfigManager are fresh, which costs more than the 5s default allows
// once the whole suite is competing for the same worker.
describe("Arc balances", { timeout: 30_000 }, () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const USDC = "0x3600000000000000000000000000000000000000";
  const OTHER = "0x6dc7DCBf19e07884e4762E06fB62128eC806Eda1";

  const baseEnv = { ...process.env };

  /** 7.5 USDC — as 18-decimal wei natively, and as 6-decimal units as ERC-20. */
  const NATIVE_WEI = 7_500_000_000_000_000_000n;
  const ERC20_UNITS = 7_500_000n;

  async function balancesFor(tokens: SwappableToken[]): Promise<TokenBalance[]> {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.ENABLED_CHAINS = "arc:mainnet";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    // Imported here, not at the top of the file: vi.resetModules() in
    // beforeEach gives each test a fresh module graph, and a statically
    // imported ConfigManager would be a different instance from the one
    // registerEnabledChains() reads.
    const { ConfigManager } = await import("../../src/config.js");
    ConfigManager.reset();
    ConfigManager.load();

    const { ChainAdapterRegistry } = await import(
      "../../src/services/chains/chainAdapterRegistry.js"
    );
    ChainAdapterRegistry.getInstance().reset();
    const { registerEnabledChains } = await import(
      "../../src/services/chains/registerChains.js"
    );
    registerEnabledChains();

    const { PortfolioManager } = await import("../../src/services/portfolio.js");
    return (
      PortfolioManager.getInstance() as unknown as {
        fetchEvmBalances: (
          address: string,
          tokens: SwappableToken[],
          ignoreDust: boolean,
          userId?: number,
          chainId?: string
        ) => Promise<TokenBalance[]>;
      }
    ).fetchEvmBalances(ADDRESS, tokens, true, undefined, "arc:mainnet");
  }

  beforeEach(() => {
    vi.resetModules();

    vi.doMock("../../src/services/chains/evm/evmClient.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      publicClientFor: () => ({
        getBalance: async () => NATIVE_WEI,
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === "balanceOf" ? ERC20_UNITS : 0n,
      }),
    }));

    // Individual reads rather than Multicall3, so the fake client above only
    // has to answer balanceOf.
    vi.doMock("../../src/services/chains/evm/multicall.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      hasMulticall3: async () => false,
    }));

    vi.doMock("../../src/services/dex/dexRegistry.js", () => ({
      DEXRegistry: {
        getInstance: () => ({
          // registerEnabledChains() registers this chain's providers; the
          // portfolio path only prices what it found.
          registerProvider: () => undefined,
          getTokenPrice: async () => 1,
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

  const usdcToken: SwappableToken = {
    contractId: USDC,
    symbol: "USDC",
    name: "USDC",
    decimals: 6,
    chainFamily: "evm",
    chainId: "arc:mainnet",
  };

  it("reports the wallet's USDC once, not once per view of it", async () => {
    const balances = await balancesFor([usdcToken]);
    expect(balances.filter((b) => b.symbol === "USDC")).toHaveLength(1);
  });

  it("reports the amount the wallet actually holds", async () => {
    // 7.5, not 15. This is the number RiskManager sizes positions against.
    const balances = await balancesFor([usdcToken]);
    expect(balances.reduce((sum, b) => sum + b.usdValue, 0)).toBe(7.5);
  });

  it("still reports ordinary ERC-20s on the chain", async () => {
    // The de-duplication is addressed at the native alias specifically; a
    // normal token at a different address is unaffected.
    const balances = await balancesFor([
      usdcToken,
      { contractId: OTHER, symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 6, chainFamily: "evm", chainId: "arc:mainnet" },
    ]);
    expect(balances.map((b) => b.symbol).sort()).toEqual(["USDC", "WBTC"]);
  });
});
