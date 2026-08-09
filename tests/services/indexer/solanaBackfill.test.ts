import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

/**
 * Solana's cursors are signatures, not heights: `getSignaturesForAddress` is an
 * account-level query that pages backwards from the newest and takes `until` or
 * `before`. Both directions of travel are therefore per pool, and both are
 * tested here — the forward pass, whose budget must be spent on the *oldest*
 * unread signatures, and the downward walk that fills in a pool's past.
 */

const indexedPool = {
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn(),
  update: vi.fn(),
};

const indexedSwap = {
  findFirst: vi.fn().mockResolvedValue(null),
  createMany: vi.fn(),
};

const transaction = vi.fn().mockResolvedValue([]);

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        indexedPool,
        indexedSwap,
        indexerCursor: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
        $transaction: transaction,
        $executeRaw: vi.fn().mockResolvedValue(0),
      },
    }),
  },
}));

vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({
      getSwappableTokens: async () => [
        { symbol: "USDC", contractId: "UsdcMint111111111111111111111111111111111111" },
        { symbol: "SOL", contractId: "So11111111111111111111111111111111111111112" },
      ],
    }),
  },
}));

const { SolanaIndexer } = await import("../../../src/services/indexer/svm/solanaIndexer.js");
const { indexerSettings } = await import("../../../src/services/indexer/settings.js");
const { SOLANA_MAINNET } = await import("../../../src/services/chains/descriptors/solana.js");

const POOL = {
  id: 7,
  poolAddress: "PoolAcct1111111111111111111111111111111111111",
  token0: "So11111111111111111111111111111111111111112",
  token1: "UsdcMint111111111111111111111111111111111111",
  decimals0: 9,
  decimals1: 6,
};

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

/** The private seams under test. */
interface IndexerSeam {
  ingestPool(
    pool: typeof POOL,
    usd: Map<string, number>,
    rawSwaps: unknown[]
  ): Promise<{ swaps: number; progress: { signature: string; backfillSeed?: string } | null }>;
  ingest(pools: (typeof POOL)[], slot: bigint): Promise<unknown>;
  backfillStep(): Promise<{ swapsIngested: number }>;
}

/** Newest-first signatures, `count` of them, `ageMs` old and 1s apart. */
function signatures(prefix: string, count: number, ageMs = 60_000) {
  const now = Math.floor((Date.now() - ageMs) / 1000);
  return Array.from({ length: count }, (_, i) => ({
    signature: `${prefix}-${count - 1 - i}`,
    slot: 300_000 - i,
    blockTime: now - i,
    err: null,
  }));
}

/** Requests the indexer made, as [method, params] pairs. */
let calls: { method: string; params: unknown[] }[] = [];

function serve(onSignatures: (params: Record<string, unknown>) => unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as
        | { id: number; method: string; params: unknown[] }
        | { id: number; method: string; params: unknown[] }[];

      // Batched getTransaction: answered emptily, since decoding balance
      // deltas is balanceDeltas.test.ts's job, not this file's.
      if (Array.isArray(body)) {
        for (const call of body) calls.push({ method: call.method, params: call.params });
        return { ok: true, json: async () => body.map((c) => ({ id: c.id, result: null })) };
      }

      calls.push({ method: body.method, params: body.params });

      const result =
        body.method === "getSignaturesForAddress"
          ? onSignatures((body.params[1] ?? {}) as Record<string, unknown>)
          : null;

      return { ok: true, json: async () => ({ result }) };
    })
  );
}

describe("solana ingestion cursors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    loadConfig({ INDEXER_MAX_TX_PER_RUN: "50" });
    indexedPool.findMany.mockResolvedValue([]);
    indexedSwap.findFirst.mockResolvedValue(null);
    transaction.mockResolvedValue([]);
  });

  function indexer() {
    return new SolanaIndexer(SOLANA_MAINNET, indexerSettings()) as unknown as IndexerSeam;
  }

  describe("forward pass", () => {
    it("spends its budget on the oldest unread signatures, not the newest", async () => {
      // The RPC returns the newest `limit` signatures and silently omits the
      // rest, so a pool busier than one tick's budget used to lose everything
      // between the cursor and the newest page — a hole no cursor could
      // describe, and therefore one nothing would ever retry.
      indexedPool.findUnique.mockResolvedValue({ lastSignature: "sig-caught-up" });
      serve(() => signatures("sig", 120));

      const { progress } = await indexer().ingestPool(POOL, new Map(), []);

      // 120 unread, budget of 50: the walk stops 50 above where it resumed,
      // contiguous with the last tick rather than adjacent to the head.
      expect(progress?.signature).toBe("sig-49");
    });

    it("pages the signature list rather than trusting one call to reach the cursor", async () => {
      indexedPool.findUnique.mockResolvedValue({ lastSignature: "sig-caught-up" });

      let page = 0;
      serve((params) => {
        expect(params.until).toBe("sig-caught-up");
        // A full page means there may be more between it and `until`.
        return page++ === 0 ? signatures("first", 1_000) : signatures("second", 10);
      });

      await indexer().ingestPool(POOL, new Map(), []);

      const listings = calls.filter((c) => c.method === "getSignaturesForAddress");
      expect(listings).toHaveLength(2);
      expect((listings[1]!.params[1] as Record<string, unknown>).before).toBe("first-0");
    });

    it("advances past signatures that held no decodable swap", async () => {
      // Otherwise a pool whose traffic this indexer cannot decode re-reads the
      // same page every tick forever, at full cost, learning nothing.
      indexedPool.findUnique.mockResolvedValue({ lastSignature: "sig-caught-up" });
      serve(() => signatures("sig", 5));

      const { swaps, progress } = await indexer().ingestPool(POOL, new Map(), []);

      expect(swaps).toBe(0);
      expect(progress?.signature).toBe("sig-4");
    });

    it("seeds the downward walk from the first pass, and only the first", async () => {
      // A pool's first pass reads the newest page; its oldest signature is
      // exactly where a walk into that pool's past has to start.
      indexedPool.findUnique.mockResolvedValue({ lastSignature: null });
      serve(() => signatures("sig", 30));

      const first = await indexer().ingestPool(POOL, new Map(), []);
      expect(first.progress?.backfillSeed).toBe("sig-0");

      indexedPool.findUnique.mockResolvedValue({ lastSignature: "sig-29" });
      const second = await indexer().ingestPool(POOL, new Map(), []);
      expect(second.progress?.backfillSeed).toBeUndefined();
    });

    it("does not write a price it never learned", async () => {
      // lastPrice0 of zero would erase a real price with the absence of one,
      // and the deepest pool's price is what a token displays.
      indexedPool.findUnique.mockResolvedValue({ lastSignature: "sig-caught-up" });
      serve(() => signatures("sig", 5));

      await indexer().ingest([POOL], 300_000n);

      const writes = transaction.mock.calls[0]?.[0] as unknown[];
      const data = (indexedPool.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(writes.length).toBeGreaterThan(0);
      expect(data.lastSignature).toBe("sig-4");
      expect(data).not.toHaveProperty("lastPrice0");
      expect(data).not.toHaveProperty("lastSwapAt");
    });
  });

  describe("downward walk", () => {
    it("walks below the seed and records where it got to", async () => {
      indexedPool.findMany.mockResolvedValue([{ ...POOL, backfillSignature: "seed-sig" }]);
      serve((params) => {
        expect(params.before).toBe("seed-sig");
        return signatures("older", 50);
      });

      await indexer().backfillStep();

      const data = (indexedPool.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data.backfillSignature).toBe("older-0");
      // A full page means there is more history below it.
      expect(data.backfillDone).toBe(false);
      // Nothing that means *latest* is touched by a walk through the past.
      expect(data).not.toHaveProperty("lastSignature");
      expect(data).not.toHaveProperty("lastPrice0");
      expect(data).not.toHaveProperty("liquidityUsd");
    });

    it("finishes when the walk reaches the window", async () => {
      indexedPool.findMany.mockResolvedValue([{ ...POOL, backfillSignature: "seed-sig" }]);
      serve(() => signatures("older", 50, 48 * 3_600_000));

      await indexer().backfillStep();

      const data = (indexedPool.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data.backfillDone).toBe(true);
      // Signatures beyond the window are not fetched at all.
      expect(calls.filter((c) => c.method === "getTransaction")).toHaveLength(0);
    });

    it("finishes when the pool has no history left", async () => {
      indexedPool.findMany.mockResolvedValue([{ ...POOL, backfillSignature: "seed-sig" }]);
      serve(() => []);

      await indexer().backfillStep();

      const data = (indexedPool.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data.backfillDone).toBe(true);
      expect(data.backfillSignature).toBe("seed-sig");
    });

    it("keeps going past the window when asked for all of history", async () => {
      loadConfig({
        INDEXER_MAX_TX_PER_RUN: "50",
        INDEXER_BACKFILL_WINDOW_HOURS: "0",
        INDEXER_BACKFILL_FULL_HISTORY: "true",
      });
      indexedPool.findMany.mockResolvedValue([{ ...POOL, backfillSignature: "seed-sig" }]);
      serve(() => signatures("older", 50, 730 * 24 * 3_600_000));

      await indexer().backfillStep();

      const data = (indexedPool.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data.backfillDone).toBe(false);
    });

    it("seeds a pool that predates the feature from its oldest stored swap", async () => {
      // lastSignature is the *newest* swap seen, so walking down from it would
      // re-read the pool's whole ingested range. The oldest swap we hold is the
      // same boundary the first pass would have recorded.
      indexedPool.findMany.mockResolvedValue([{ ...POOL, backfillSignature: null }]);
      indexedSwap.findFirst.mockResolvedValue({ txKey: "oldest-stored-sig" });
      serve((params) => {
        expect(params.before).toBe("oldest-stored-sig");
        return [];
      });

      await indexer().backfillStep();
      expect(indexedSwap.findFirst).toHaveBeenCalled();
    });

    it("waits for the forward pass when a pool has no seed at all", async () => {
      indexedPool.findMany.mockResolvedValue([{ ...POOL, backfillSignature: null }]);
      indexedSwap.findFirst.mockResolvedValue(null);
      serve(() => []);

      await indexer().backfillStep();
      expect(calls).toHaveLength(0);
      expect(indexedPool.update).not.toHaveBeenCalled();
    });

    it("can be turned off entirely", async () => {
      loadConfig({ INDEXER_BACKFILL_WINDOW_HOURS: "0" });
      await indexer().backfillStep();
      expect(indexedPool.findMany).not.toHaveBeenCalled();
    });
  });
});
