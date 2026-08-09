import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

/**
 * Backfill walks history downward so a chain's first day of 24H figures isn't
 * a fraction of the real one.
 *
 * The whole feature is one bigint away from corrupting the data it exists to
 * complete: candle volume accumulates additively, so any range walked twice is
 * inflated permanently and indistinguishably from real trading. These tests
 * are mostly about *where the walk is allowed to start*.
 */

const cursorRow: Record<string, unknown> = {};
const cursor = {
  findUnique: vi.fn(),
  create: vi.fn(),
  upsert: vi.fn(),
};

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        indexerCursor: cursor,
        indexedPool: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
        indexedToken: { findUnique: vi.fn(), create: vi.fn() },
        $transaction: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn(),
      },
    }),
  },
}));

const getBlockNumber = vi.fn();
const getBlock = vi.fn();
const getLogs = vi.fn().mockResolvedValue([]);

const stubClient = { getBlockNumber, getBlock, getLogs, readContract: vi.fn() };
vi.mock("../../../src/services/chains/evm/evmClient.js", () => ({
  publicClientFor: () => stubClient,
  batchingPublicClientFor: () => stubClient,
  rpcUrlFor: () => "https://rpc.example",
}));

const { UniswapV3Indexer } = await import(
  "../../../src/services/indexer/evm/uniswapV3Indexer.js"
);
const { indexerSettings } = await import("../../../src/services/indexer/settings.js");
const { BASE_MAINNET } = await import("../../../src/services/chains/descriptors/base.js");

function loadConfig(extra: Record<string, string> = {}) {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
  delete process.env.INDEXER_BACKFILL_FULL_HISTORY;
  delete process.env.INDEXER_BACKFILL_WINDOW_HOURS;
  Object.assign(process.env, extra);
  ConfigManager.reset();
  ConfigManager.load();
}

/** The private walk, exposed for the test. */
interface BackfillSeam {
  backfillStep(safeHead: bigint): Promise<{ swapsIngested: number; bucketsWritten: number }>;
}

describe("indexer backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(cursorRow)) delete cursorRow[key];
    loadConfig({ INDEXER_CONFIRMATIONS: "0", INDEXER_MAX_BACKFILL_BLOCKS_PER_RUN: "1000" });
    cursor.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => {
      Object.assign(cursorRow, update);
      return cursorRow;
    });
    // 2s blocks: 1000 blocks apart, 2000 seconds apart.
    getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: BigInt(blockNumber) * 2n,
    }));
  });

  function indexer() {
    return new UniswapV3Indexer(BASE_MAINNET, indexerSettings()) as unknown as BackfillSeam;
  }

  it("does nothing for a cursor with no recorded start", async () => {
    // Pre-dates the feature: the original ingestion start is unrecoverable, so
    // a walk would have to begin at lastBlock and descend through blocks
    // already ingested — double-counting their volume forever.
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: null,
      backfillFloor: null,
      backfillDone: false,
    });

    const result = await indexer().backfillStep(1_000_000n);

    expect(result.swapsIngested).toBe(0);
    expect(cursorRow.backfillDone).toBe(true);
  });

  it("stops once the walk reaches the floor", async () => {
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: 900_000n,
      backfillFloor: 950_000n,
      backfillDone: false,
    });

    await indexer().backfillStep(1_000_000n);
    expect(cursorRow.backfillDone).toBe(true);
  });

  it("never restarts a chain it has already finished", async () => {
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: 950_000n,
      backfillFloor: 950_000n,
      backfillDone: true,
    });

    await indexer().backfillStep(1_000_000n);
    expect(getLogs).not.toHaveBeenCalled();
    expect(cursor.upsert).not.toHaveBeenCalled();
  });

  it("derives the floor from measured block time, not a block count", async () => {
    // 50k blocks is a week of Ethereum and about three hours of a sub-second
    // L2, so a constant would leave the busiest chains with the least history.
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: 1_000_000n,
      backfillFloor: null,
      backfillDone: false,
    });

    await indexer().backfillStep(1_000_000n);

    // 24h at 2s/block = 43,200 blocks.
    expect(cursorRow.backfillFloor).toBe(1_000_000n - 43_200n);
  });

  it("is bounded per tick so it cannot starve live ingestion", async () => {
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: 1_000_000n,
      backfillFloor: 900_000n,
      backfillDone: false,
    });

    await indexer().backfillStep(1_000_000n);

    // One tick moved the mark down by the configured budget and no further.
    expect(cursorRow.backfillBlock).toBe(999_999n - 1000n);
    expect(cursorRow.backfillDone).toBeUndefined();
  });

  it("walks to genesis when asked for all of history", async () => {
    // The explicit switch beats the tuning knob: a window of zero would
    // otherwise read as "disabled" and silently ignore the request.
    loadConfig({
      INDEXER_MAX_BACKFILL_BLOCKS_PER_RUN: "1000",
      INDEXER_BACKFILL_WINDOW_HOURS: "0",
      INDEXER_BACKFILL_FULL_HISTORY: "true",
    });
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: 1_000_000n,
      backfillFloor: null,
      backfillDone: false,
    });

    await indexer().backfillStep(1_000_000n);

    expect(cursorRow.backfillFloor).toBe(0n);
    // A floor that needs no measuring needs no block reads either.
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("can be turned off entirely", async () => {
    loadConfig({ INDEXER_BACKFILL_WINDOW_HOURS: "0" });
    cursor.findUnique.mockResolvedValue({
      chainId: "base:mainnet",
      lastBlock: 1_000_000n,
      backfillBlock: 1_000_000n,
      backfillFloor: null,
      backfillDone: false,
    });

    await indexer().backfillStep(1_000_000n);
    expect(cursor.findUnique).not.toHaveBeenCalled();
  });
});
