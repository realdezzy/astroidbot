import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChainId } from "../../../src/types/chain.js";
import type { ChainIndexer, IndexRunResult } from "../../../src/services/indexer/types.js";

/**
 * Mutual exclusion for ingestion.
 *
 * While the indexer ran inside the API process, a Set was enough: one process,
 * one guard. It now runs in its own container, so "another run" can be another
 * *process* — a second replica, or a deploy overlapping its predecessor. An
 * in-process Set cannot see either.
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

/**
 * Health tracking is stubbed out: this file is about mutual exclusion.
 *
 * Left real, it leaks between cases. The monitor is a singleton whose
 * consecutive-failure count accumulates across the whole file, so the third
 * deliberately-failing run in here trips the alert path — which reaches for
 * the admin list in Postgres and makes the suite slow and order-dependent.
 */
vi.mock("../../../src/services/chains/chainHealth.js", () => ({
  ChainHealthMonitor: {
    getInstance: () => ({ track: <T,>(_chainId: string, fn: () => Promise<T>) => fn() }),
  },
}));

vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => ({ acquireLock, releaseLock }) },
}));

const CHAIN = "base:mainnet" as ChainId;
const LOCK_KEY = `indexer:ingest:${CHAIN}`;

function stubIndexer(chainId: ChainId = CHAIN): ChainIndexer & { runs: number } {
  const indexer = {
    chainId,
    runs: 0,
    async run(): Promise<IndexRunResult> {
      indexer.runs++;
      return {
        chainId,
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

  it("takes one lock per chain rather than one for the pass", async () => {
    // Chains run concurrently and are bound by different RPC endpoints. A
    // single global lock would make the slowest chain set the pace for every
    // other one, and would let a stuck chain block all of them.
    const IndexerService = await loadService();
    const service = IndexerService.getInstance();

    const base = stubIndexer();
    const celo = stubIndexer("celo:mainnet" as ChainId);
    service.register(base);
    service.register(celo);

    // Base is already being ingested elsewhere; Celo must be unaffected.
    locks.set(LOCK_KEY, "held-by-another-process");

    const results = await service.runAll();

    expect(base.runs).toBe(0);
    expect(results.map((r) => r.chainId)).toEqual(["celo:mainnet"]);
  });
});
