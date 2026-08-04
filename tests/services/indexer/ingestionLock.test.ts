import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChainId } from "../../../src/types/chain.js";
import type { ChainIndexer, IndexRunResult } from "../../../src/services/indexer/types.js";

/**
 * Mutual exclusion for ingestion.
 *
 * While the indexer ran inside the API process, a Set was enough: one process,
 * one guard. It now runs in its own container, so "another run" can be another
 * *process* — a second replica, a deploy overlapping its predecessor, an
 * operator who left INDEXER_MODE=inline on the API. An in-process Set cannot
 * see any of those.
 *
 * The consequence of losing this is not a crash. Both runs read the same
 * cursor, ingest the same blocks, and add the same volume to the same candles
 * — and volume accumulates additively, so the inflation is permanent and looks
 * exactly like real trading.
 */

/** Minimal Redis stand-in with the SET NX semantics acquireLock relies on. */
const locks = new Map<string, string>();

const acquireLock = vi.fn(async (key: string): Promise<string | null> => {
  if (locks.has(key)) return null;
  const token = `token-${Math.random()}`;
  locks.set(key, token);
  return token;
});

const releaseLock = vi.fn(async (key: string, token?: string): Promise<void> => {
  // Compare-and-delete, as the real implementation does: a run must not
  // release a lock that has since been taken by someone else.
  if (!token || locks.get(key) === token) locks.delete(key);
});

vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => ({ acquireLock, releaseLock }) },
}));

const CHAIN = "base:mainnet" as ChainId;
const LOCK_KEY = `indexer:ingest:${CHAIN}`;

function stubIndexer(onRun?: () => Promise<void>): ChainIndexer & { runs: number } {
  const indexer = {
    chainId: CHAIN,
    runs: 0,
    async run(): Promise<IndexRunResult> {
      indexer.runs++;
      if (onRun) await onRun();
      return {
        chainId: CHAIN,
        poolsDiscovered: 0,
        swapsIngested: 1,
        bucketsWritten: 1,
        fromBlock: 1n,
        toBlock: 2n,
      };
    },
  };
  return indexer;
}

async function loadService(): Promise<
  typeof import("../../../src/services/indexer/indexerService.js").IndexerService
> {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  process.env.INDEXER_MODE = "standalone";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;

  const { ConfigManager } = await import("../../../src/config.js");
  ConfigManager.reset();
  ConfigManager.load();

  const { IndexerService } = await import("../../../src/services/indexer/indexerService.js");
  IndexerService.getInstance().reset();
  return IndexerService;
}

describe("ingestion locking", () => {
  beforeEach(() => {
    locks.clear();
    acquireLock.mockClear();
    releaseLock.mockClear();
  });

  it("skips a chain another process is already ingesting", async () => {
    const IndexerService = await loadService();
    const service = IndexerService.getInstance();
    const indexer = stubIndexer();
    service.register(indexer);

    // Stand in for the other container: the lock is held before we start.
    locks.set(LOCK_KEY, "held-by-another-process");

    const results = await service.runAll();

    expect(indexer.runs).toBe(0);
    expect(results).toEqual([]);
    // And it must not have stolen the lock on the way past.
    expect(locks.get(LOCK_KEY)).toBe("held-by-another-process");
  });

  it("releases the lock so the next tick can run", async () => {
    const IndexerService = await loadService();
    const service = IndexerService.getInstance();
    const indexer = stubIndexer();
    service.register(indexer);

    await service.runAll();
    expect(indexer.runs).toBe(1);
    expect(locks.has(LOCK_KEY)).toBe(false);

    await service.runAll();
    expect(indexer.runs).toBe(2);
  });

  it("releases the lock when the run throws", async () => {
    // A failed pass that kept the lock would take the chain out of the index
    // until the TTL expired — five minutes of missing swaps for one bad RPC
    // response.
    const IndexerService = await loadService();
    const service = IndexerService.getInstance();

    service.register({
      chainId: CHAIN,
      run: async () => {
        throw new Error("RPC exploded");
      },
    });

    const results = await service.runAll();

    expect(results).toEqual([]);
    expect(locks.has(LOCK_KEY)).toBe(false);
  });

  it("does not ingest at all when indexing is off", async () => {
    const IndexerService = await loadService();
    process.env.INDEXER_MODE = "off";
    const { ConfigManager } = await import("../../../src/config.js");
    ConfigManager.reset();
    ConfigManager.load();

    const service = IndexerService.getInstance();
    const indexer = stubIndexer();
    service.register(indexer);

    expect(await service.runAll()).toEqual([]);
    expect(indexer.runs).toBe(0);
    expect(acquireLock).not.toHaveBeenCalled();
  });
});
