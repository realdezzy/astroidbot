import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import { ConfigManager } from "../../src/config.js";
import { DatabaseService } from "../../src/services/db.js";
import { persistSwaps, recomputeCandles } from "../../src/services/indexer/swapStore.js";
import type { RawSwap } from "../../src/services/indexer/swapStore.js";

/**
 * Candle derivation, against a real Postgres.
 *
 * This is an integration test because the logic *is* SQL — window ordering,
 * FILTER clauses and an upsert that must SET rather than accumulate. Mirroring
 * it in TypeScript to unit-test it would create a second implementation that
 * could disagree with the one that runs, which is worse than no test.
 *
 * The property being pinned is the reason the table exists: running the same
 * ingestion twice must produce the same numbers. Under the previous design —
 * `volumeUsd = volumeUsd + new` — the second run doubled the volume, the third
 * tripled it, and nothing downstream could tell.
 *
 * Skips when no database is configured. It does *not* skip when the database
 * is there but unmigrated — that is a fixable mistake, and saying so beats a
 * bare PrismaClientInitializationError.
 */

const BUCKET = new Date("2026-08-02T12:00:00.000Z");
const CHAIN = "test:recompute";

// The URL usually lives in .env rather than the environment, and this file is
// read before ConfigManager has loaded anything.
dotenv.config();

const hasDatabase = Boolean(process.env.ASTROIDBOT_DATABASE_URL);
const withDb = hasDatabase ? describe : describe.skip;

withDb("candle recompute", () => {
  let poolId: number;

  beforeAll(async () => {
    // Prisma reads the URL through ConfigManager, which nothing else in an
    // integration run has initialised.
    ConfigManager.reset();
    ConfigManager.load();
    await DatabaseService.connect();
    const db = DatabaseService.getInstance();

    try {
      await db.prisma.indexedSwap.count();
    } catch (error) {
      throw new Error(
        "IndexedSwap is missing — this database predates the raw-swap migration. " +
          "Run `npx prisma migrate deploy` against it first. " +
          `(${error instanceof Error ? error.message.split("\n")[0] : String(error)})`
      );
    }

    await db.prisma.indexedPool.deleteMany({ where: { chainId: CHAIN } });

    const pool = await db.prisma.indexedPool.create({
      data: {
        chainId: CHAIN,
        dexId: "test",
        poolAddress: `pool-${Date.now()}`,
        token0: "token0",
        token1: "token1",
        decimals0: 18,
        decimals1: 6,
      },
    });
    poolId = pool.id;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    const db = DatabaseService.getInstance();
    // Cascades to the swaps and candles.
    await db.prisma.indexedPool.deleteMany({ where: { chainId: CHAIN } });
    await db.disconnect();
  });

  /** Deliberately out of block order, with one swap we could not price. */
  function swaps(): RawSwap[] {
    return [
      { poolId, txKey: "c", blockNumber: 30n, logIndex: 0, bucketStart: BUCKET, priceUsd: 90, volumeUsd: 300, isBuy: false },
      { poolId, txKey: "a", blockNumber: 10n, logIndex: 0, bucketStart: BUCKET, priceUsd: 100, volumeUsd: 100, isBuy: true },
      { poolId, txKey: "b", blockNumber: 20n, logIndex: 1, bucketStart: BUCKET, priceUsd: 120, volumeUsd: 200, isBuy: true },
      { poolId, txKey: "z", blockNumber: 25n, logIndex: 0, bucketStart: BUCKET, priceUsd: 0, volumeUsd: 50, isBuy: false },
    ];
  }

  async function candle() {
    return DatabaseService.getInstance().prisma.poolCandle.findUnique({
      where: { poolId_bucketStart: { poolId, bucketStart: BUCKET } },
    });
  }

  it("derives OHLC in block order, not insertion order", async () => {
    await persistSwaps(swaps());
    const row = (await candle())!;

    // Block 10 opened, block 30 closed, however they arrived.
    expect(row.open).toBe(100);
    expect(row.close).toBe(90);
    expect(row.high).toBe(120);
  });

  it("keeps an unpriceable swap out of OHLC but inside volume and counts", async () => {
    const row = (await candle())!;

    // The zero-price swap must not drag the low to nothing — the trade
    // happened, we just couldn't value it.
    expect(row.low).toBe(90);
    expect(row.volumeUsd).toBe(650);
    expect(row.buys).toBe(2);
    expect(row.sells).toBe(2);
  });

  it("produces identical numbers however many times it runs", async () => {
    // The whole reason IndexedSwap exists. Additively, this read 650, then
    // 1300, then 1950 — permanently wrong and indistinguishable from real
    // trading.
    const before = (await candle())!;

    await persistSwaps(swaps());
    await persistSwaps(swaps());

    const after = (await candle())!;
    expect(after.volumeUsd).toBe(before.volumeUsd);
    expect(after.buys).toBe(before.buys);
    expect(after.sells).toBe(before.sells);
  });

  it("stores each swap once, whatever the replay count", async () => {
    const count = await DatabaseService.getInstance().prisma.indexedSwap.count({
      where: { poolId },
    });
    expect(count).toBe(4);
  });

  it("reflects a deletion, which additive accumulation could never do", async () => {
    // Reorg repair. Addition has no inverse; recomputation does.
    await DatabaseService.getInstance().prisma.indexedSwap.deleteMany({
      where: { poolId, txKey: "c" },
    });

    await recomputeCandles([poolId], [BUCKET]);

    const row = (await candle())!;
    expect(row.volumeUsd).toBe(350);
    expect(row.close).toBe(120); // block 20 is now the last priced swap
  });
});
