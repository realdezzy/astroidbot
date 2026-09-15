import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexerSettings } from "../../../src/services/indexer/settings.js";

const state = vi.hoisted(() => ({ cursor: null as null | Record<string, unknown> }));
const rpc = vi.hoisted(() => ({
  getBlockNumber: vi.fn().mockResolvedValue(1000n),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: `hash-${blockNumber}`, timestamp: blockNumber * 12n })),
  getLogs: vi.fn().mockResolvedValue([]),
}));
const db = vi.hoisted(() => ({
  indexerCursor: {
    findUnique: vi.fn(async () => state.cursor),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { state.cursor = data; return data; }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(state.cursor!, data); return state.cursor; }),
    upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => { Object.assign(state.cursor!, update); return state.cursor; }),
  },
  indexedPool: { findMany: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../../src/services/db.js", () => ({ DatabaseService: { getInstance: () => ({ prisma: db }) } }));
vi.mock("../../../src/services/chains/evm/evmClient.js", () => ({ batchingPublicClientFor: () => rpc }));
import { UniswapV3Indexer } from "../../../src/services/indexer/evm/uniswapV3Indexer.js";
import { ETHEREUM_MAINNET } from "../../../src/services/chains/descriptors/ethereum.js";

const settings: IndexerSettings = { confirmations: 0, confirmationSeconds: 0, blockChunkSize: 100, maxBlocksPerRun: 100, initialLookbackBlocks: 10, initialLookbackHours: 0, maxPools: 1, maxTxPerRun: 50, maxAddressesPerFilter: 100, maxSplitDepth: 12, retryBackoffMs: 0, backfillWindowHours: 0, maxBackfillBlocksPerRun: 100, maxBackfillSourcesPerRun: 1, backfillFullHistory: false };
type Seam = {
  getLogsAdaptive(fetch: (from: bigint, to: bigint) => Promise<unknown[]>, from: bigint, to: bigint): Promise<unknown[] | null>;
  readSwapLogs(addresses: string[], from: bigint, to: bigint): Promise<unknown[]>;
};

describe("EVM ingestion completeness", () => {
  beforeEach(() => { vi.clearAllMocks(); state.cursor = null; rpc.getLogs.mockResolvedValue([]); });
  it("walks factory history from genesis without claiming unscanned swaps", async () => {
    const indexer = new UniswapV3Indexer(ETHEREUM_MAINNET, settings);
    const first = await indexer.run();
    expect(first).toMatchObject({ toBlock: 989n, discoveryBlock: 99n, targetBlock: 1000n });
    expect(state.cursor?.lastPoolBlock).toBe(99n);
    expect(rpc.getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 0n, toBlock: 99n });
    for (let i = 0; i < 10; i++) await indexer.run();
    expect(state.cursor?.lastBlock).toBe(1000n);
    expect(state.cursor?.lastPoolBlock).toBe(1000n);
  });
  it("does not advance either cursor when factory discovery fails", async () => {
    state.cursor = { lastBlock: 990n, lastPoolBlock: 990n };
    rpc.getLogs.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(new UniswapV3Indexer(ETHEREUM_MAINNET, settings).run()).rejects.toThrow("Factory discovery incomplete");
    expect(state.cursor).toMatchObject({ lastBlock: 990n, lastPoolBlock: 990n });
  });
  it("never turns an unreadable single block into an empty block", async () => {
    const indexer = new UniswapV3Indexer(ETHEREUM_MAINNET, settings) as unknown as Seam;
    expect(await indexer.getLogsAdaptive(async () => { throw new Error("too many results"); }, 5n, 5n)).toBeNull();
  });
  it("splits address filters when a single block exceeds provider limits", async () => {
    rpc.getLogs.mockImplementation(async ({ address }: { address: string[] }) => {
      if (address.length > 1) throw new Error("too many results");
      return [{ address: address[0] }];
    });
    const indexer = new UniswapV3Indexer(ETHEREUM_MAINNET, settings) as unknown as Seam;
    expect(await indexer.readSwapLogs(["a", "b"], 5n, 5n)).toEqual([{ address: "a" }, { address: "b" }]);
  });
});
