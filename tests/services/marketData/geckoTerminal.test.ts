import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTestConfig } from "../../helpers/config.js";

/**
 * The external market-data client.
 *
 * Nothing here touches the network: the live API is rate-limited at 30 calls a
 * minute on the keyless tier, which a test suite would exhaust in seconds — and
 * a test that depends on a third party's uptime fails for reasons that have
 * nothing to do with the code.
 */

const get = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn(() => ({ get })));

vi.mock("axios", () => ({
  default: {
    create,
    isAxiosError: (e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => redis },
}));

const { GeckoTerminalService, geckoNetworkFor } = await import(
  "../../../src/services/geckoTerminal.js"
);

/** A 429 as axios reports one. */
function rateLimited(retryAfter?: string) {
  return {
    isAxiosError: true,
    response: { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} },
  };
}

function tokenResource(address: string, attributes: Record<string, unknown>) {
  return { id: `base_${address}`, type: "token", attributes: { address, ...attributes } };
}

describe("GeckoTerminalService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig();
    GeckoTerminalService.reset();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);
    get.mockResolvedValue({ data: { data: [] } });
  });

  it("maps the default-enabled chains it has data for", () => {
    for (const chainId of ["stacks:mainnet", "base:mainnet", "robinhood:mainnet", "solana:mainnet"]) {
      expect(geckoNetworkFor(chainId)).not.toBeNull();
    }
  });

  it("leaves Arc unmapped even though the API lists it", () => {
    // This is the one default-enabled chain deliberately absent from the
    // table, and "the API has never heard of it" is no longer the reason —
    // GeckoTerminal does publish an `arc` network. It publishes no pools on
    // it. A slug that resolves and returns nothing is worse than no slug at
    // all: the empty list reads as "this chain has no tokens" rather than
    // "this source cannot answer", and it stays invisible until someone asks
    // why Arc looks dead. Our own index covers Arc, so being unmapped here
    // routes those reads to the source that has the data.
    //
    // Map it once their `arc` network returns pools, not before.
    expect(geckoNetworkFor("arc:mainnet")).toBeNull();
    expect(geckoNetworkFor("arc:testnet")).toBeNull();
  });

  it("batches token lookups at the endpoint's thirty-address limit", async () => {
    const addresses = Array.from({ length: 65 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);

    await GeckoTerminalService.getInstance().tokenMetrics("base:mainnet", addresses);

    expect(get).toHaveBeenCalledTimes(3);
    const requested = get.mock.calls.map((call) => {
      const path = String(call[0]);
      return path.slice(path.indexOf("multi/") + 6, path.indexOf("?")).split(",").length;
    });
    expect(requested).toEqual([30, 30, 5]);
  });

  it("preserves case-sensitive Solana mints and Stacks principals", async () => {
    // Lowercasing these produces a valid-looking address for something else,
    // and the API answers with an empty result instead of an error — which is
    // how a chain's metrics silently went missing.
    const solana = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const stacks = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.usdc-token";
    get.mockResolvedValueOnce({
      data: { data: [tokenResource(solana, { symbol: "BONK", price_usd: "0.00002" })] },
    });
    get.mockResolvedValueOnce({
      data: { data: [tokenResource(stacks, { symbol: "USDC", price_usd: "1" })] },
    });

    const solanaResult = await GeckoTerminalService.getInstance().tokenMetrics("solana:mainnet", [
      solana,
    ]);
    const stacksResult = await GeckoTerminalService.getInstance().tokenMetrics("stacks:mainnet", [
      stacks,
    ]);

    const solanaPath = String(get.mock.calls[0]![0]);
    const stacksPath = String(get.mock.calls[1]![0]);
    expect(solanaPath).toContain(solana);
    expect(solanaPath).not.toContain(solana.toLowerCase());
    expect(stacksPath).toContain(stacks);
    expect(solanaResult.tokens[0]?.address).toBe(solana);
    expect(stacksResult.tokens[0]?.address).toBe(stacks);
  });

  it("reads the change columns off the pools the batch call includes", async () => {
    get.mockResolvedValue({
      data: {
        data: [tokenResource("0xabc", { symbol: "WETH", price_usd: "2500.5", volume_usd: { h24: "1000" } })],
        included: [
          {
            id: "base_0xpool",
            type: "pool",
            attributes: {
              address: "0xpool",
              reserve_in_usd: "500000",
              price_change_percentage: { m5: "1.5", h24: "-3" },
              transactions: { h24: { buys: 10, sells: 4 } },
            },
            relationships: { base_token: { data: { id: "base_0xabc" } } },
          },
        ],
      },
    });

    const { tokens, pools } = await GeckoTerminalService.getInstance().tokenMetrics(
      "base:mainnet",
      ["0xABC"]
    );

    expect(tokens[0]).toMatchObject({ address: "0xabc", symbol: "WETH", priceUsd: 2500.5 });
    expect(pools[0]).toMatchObject({ baseTokenAddress: "0xabc", priceChange5m: 1.5, priceChange24h: -3 });
  });

  /**
   * `total_reserve_in_usd` came back as a ~600-digit number for USDC on Base
   * while this integration was being evaluated. That is not a large pool, it
   * is a broken field — and it sorts to the top of every liquidity-ranked
   * page, where null sorts out of the way.
   */
  it("rejects an absurd liquidity figure rather than rendering it", async () => {
    get.mockResolvedValue({
      data: {
        data: [
          tokenResource("0xabc", {
            price_usd: "1",
            total_reserve_in_usd: "9".repeat(600),
          }),
        ],
      },
    });

    const { tokens } = await GeckoTerminalService.getInstance().tokenMetrics("base:mainnet", ["0xabc"]);

    expect(tokens[0]!.liquidityUsd).toBeNull();
    // The rest of the row is still usable: one broken field is not a broken token.
    expect(tokens[0]!.priceUsd).toBe(1);
  });

  it("reports an unknown metric as null, never as zero", async () => {
    get.mockResolvedValue({ data: { data: [tokenResource("0xabc", { symbol: "X" })] } });

    const { tokens } = await GeckoTerminalService.getInstance().tokenMetrics("base:mainnet", ["0xabc"]);

    expect(tokens[0]).toMatchObject({
      priceUsd: null,
      volume24h: null,
      liquidityUsd: null,
      marketCapUsd: null,
    });
  });

  it("returns OHLCV rows chronologically, dropping malformed ones", async () => {
    get.mockResolvedValue({
      data: {
        data: {
          attributes: {
            ohlcv_list: [
              [200, 2, 3, 1, 2.5, 100],
              [100, 1, 2, 0.5, 1.5, 50],
              [300, "bad"],
            ],
          },
        },
      },
    });

    const rows = await GeckoTerminalService.getInstance().ohlcv("base:mainnet", "0xpool", "1h", 10);

    expect(rows.map((r) => r.timestampSeconds)).toEqual([100, 200]);
    expect(rows[0]).toMatchObject({ open: 1, high: 2, low: 0.5, close: 1.5, volumeUsd: 50 });
  });

  /**
   * A 429 is the one error that has to change future behaviour. Retrying into
   * a rate limit is what keeps you inside it, so the client goes quiet for the
   * window rather than asking again.
   */
  it("stops calling after a 429 instead of retrying into it", async () => {
    get.mockRejectedValue(rateLimited());
    const api = GeckoTerminalService.getInstance();

    expect(await api.topPools("base:mainnet", "0xabc")).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);

    expect(await api.topPools("base:mainnet", "0xdef")).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("serves a cached response without calling the API at all", async () => {
    redis.get.mockResolvedValue(JSON.stringify({ data: [tokenResource("0xabc", { symbol: "CACHED" })] }));

    const { tokens } = await GeckoTerminalService.getInstance().tokenMetrics("base:mainnet", ["0xabc"]);

    expect(tokens[0]!.symbol).toBe("CACHED");
    expect(get).not.toHaveBeenCalled();
  });

  it("degrades to nothing on a transport failure rather than throwing", async () => {
    get.mockRejectedValue(new Error("socket hang up"));

    await expect(
      GeckoTerminalService.getInstance().tokenMetrics("base:mainnet", ["0xabc"])
    ).resolves.toEqual({ tokens: [], pools: [] });
  });

  it("uses the paid host and header when a key is configured", async () => {
    loadTestConfig({ GECKOTERMINAL_API_KEY: "cg-test-key" });
    GeckoTerminalService.reset();

    await GeckoTerminalService.getInstance().newPools("base:mainnet");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://pro-api.coingecko.com/api/v3/onchain",
        headers: { "x-cg-pro-api-key": "cg-test-key" },
      })
    );
  });

  it("uses the keyless host when no key is configured", async () => {
    delete process.env.GECKOTERMINAL_API_KEY;
    loadTestConfig();
    GeckoTerminalService.reset();

    await GeckoTerminalService.getInstance().newPools("base:mainnet");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.geckoterminal.com/api/v2" })
    );
  });
});
