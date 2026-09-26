import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexerSettings } from "../../../src/services/indexer/settings.js";

/**
 * The EVM pass with swap ingestion switched off.
 *
 * Discovery and ingestion have completely different economics — one
 * `eth_getLogs` per factory per range against every `Swap` log on the chain —
 * and this mode keeps the first. What it must not do is *claim* the second:
 * `lastBlock` means "swaps are ingested up to here", so advancing it while
 * reading none would tell a later `INDEXER_MODE=full` that the intervening
 * blocks had been read, and the gap would be invisible.
 */

const state = vi.hoisted(() => ({ cursor: null as null | Record<string, unknown> }));
const rpc = vi.hoisted(() => ({
  getBlockNumber: vi.fn().mockResolvedValue(1000n),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
    hash: `hash-${blockNumber}`,
    timestamp: blockNumber * 2n,
  })),
  getLogs: vi.fn().mockResolvedValue([]),
  // Balance and slot0 reads answer null, which `refreshLiquidity` skips over:
  // these tests are about which queries the pass makes, not about arithmetic
  // on values a stub invented.
  readContract: vi.fn().mockResolvedValue(null),
  getBytecode: vi.fn().mockResolvedValue(undefined),
}));

const db = vi.hoisted(() => ({
  indexerCursor: {
    findUnique: vi.fn(async () => state.cursor),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { state.cursor = data; return data; }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(state.cursor!, data); return state.cursor; }),
    upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => { Object.assign(state.cursor!, update); return state.cursor; }),
  },
  indexedPool: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
  indexedToken: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
  $transaction: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/services/db.js", () => ({ DatabaseService: { getInstance: () => ({ prisma: db }) } }));
vi.mock("../../../src/services/chains/evm/evmClient.js", () => ({ batchingPublicClientFor: () => rpc }));

const { UniswapV3Indexer } = await import("../../../src/services/indexer/evm/uniswapV3Indexer.js");
const { BASE_MAINNET } = await import("../../../src/services/chains/descriptors/base.js");

const base: IndexerSettings = {
  mode: "discovery", confirmations: 0, confirmationSeconds: 0, blockChunkSize: 1000,
  maxBlocksPerRun: 100, initialLookbackBlocks: 10, initialLookbackHours: 0, maxPools: 5,
  maxTxPerRun: 50, maxAddressesPerFilter: 100, maxSplitDepth: 12, retryBackoffMs: 0,
  backfillWindowHours: 24, maxBackfillBlocksPerRun: 100, maxBackfillSourcesPerRun: 1,
  backfillFullHistory: false,
};

describe("EVM discovery mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cursor = null;
    rpc.getLogs.mockResolvedValue([]);
    db.indexedPool.findMany.mockResolvedValue([]);
  });

  it("reports no swaps and reads no swap logs", async () => {
    state.cursor = { lastBlock: 500n, lastPoolBlock: 500n };

    const result = await new UniswapV3Indexer(BASE_MAINNET, base).run();

    expect(result.swapsIngested).toBe(0);
    expect(result.bucketsWritten).toBe(0);

    // Every log read in this mode is a factory read; a `Swap` topic among them
    // would mean ingestion happened under another name.
    const events = rpc.getLogs.mock.calls.map((call) => (call[0] as { event?: { name?: string } }).event?.name);
    expect(events.every((name) => name !== "Swap")).toBe(true);
  });

  it("leaves the swap cursor exactly where it was", async () => {
    state.cursor = { lastBlock: 500n, lastPoolBlock: 500n };

    await new UniswapV3Indexer(BASE_MAINNET, base).run();

    expect(state.cursor.lastBlock).toBe(500n);
  });

  /**
   * In a full pass discovery is clamped to the range swaps are about to be
   * read for — correct there, since a swap must never be claimed from a range
   * whose pool set isn't known. With the swap cursor frozen, that same clamp
   * would pin discovery to wherever ingestion stopped and it would never move
   * again.
   */
  it("advances pool discovery from the head rather than from the frozen swap cursor", async () => {
    state.cursor = { lastBlock: 100n, lastPoolBlock: 100n };

    const first = await new UniswapV3Indexer(BASE_MAINNET, base).run();
    expect(first.discoveryBlock).toBe(200n);
    expect(state.cursor.lastPoolBlock).toBe(200n);

    const second = await new UniswapV3Indexer(BASE_MAINNET, base).run();
    expect(second.discoveryBlock).toBe(300n);
  });

  it("creates a cursor on a fresh chain so a later full pass isn't a first run", async () => {
    await new UniswapV3Indexer(BASE_MAINNET, base).run();

    expect(db.indexerCursor.create).toHaveBeenCalled();
    expect(state.cursor).toMatchObject({ lastBlock: 989n, backfillBlock: 990n });
  });

  it("measures liquidity for pools it has never measured", async () => {
    state.cursor = { lastBlock: 500n, lastPoolBlock: 500n };
    db.indexedPool.findMany.mockResolvedValue([
      {
        id: 1, chainId: "base:mainnet", dexId: "uniswap-v3", poolAddress: "0xpool",
        token0: "0xtoken", token1: "0x4200000000000000000000000000000000000006",
        decimals0: 18, decimals1: 18, feeTier: 500, baseToken: "0xtoken", lastPrice0: 1,
      },
    ]);

    await new UniswapV3Indexer(BASE_MAINNET, base).run();

    // Nothing else writes `IndexedPool.liquidityUsd` in this mode, and it
    // decides which pool sets a token's price, whether that price is trusted,
    // and whether the token is ever promoted into the catalogue at all.
    const unmeasured = db.indexedPool.findMany.mock.calls.find(
      (call) => (call[0] as { where?: { liquidityUsd?: unknown } })?.where?.liquidityUsd === null
    );
    expect(unmeasured).toBeDefined();
  });
});
