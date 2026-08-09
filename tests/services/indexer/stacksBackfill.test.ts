import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

/**
 * Stacks walks history by paging an address's transaction list, because that is
 * the only shape its API offers — there is no "give me this block range for
 * this contract". Everything awkward about these tests follows from that: the
 * resume point is an *offset*, and an offset into a list that grows at the head
 * is only meaningful alongside the length it was recorded against.
 */

const cursor = {
  findUnique: vi.fn(),
  create: vi.fn(),
  upsert: vi.fn(),
};

const savedCursor: Record<string, unknown> = {};

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        indexerCursor: cursor,
        indexedPool: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() },
        indexedToken: { create: vi.fn() },
        indexedSwap: { createMany: vi.fn() },
        $transaction: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(0),
      },
    }),
  },
}));

const { StacksIndexer } = await import("../../../src/services/indexer/stacks/stacksIndexer.js");
const { indexerSettings } = await import("../../../src/services/indexer/settings.js");
const { STACKS_MAINNET } = await import("../../../src/services/chains/descriptors/stacks.js");

const ALEX = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01";
const VELAR = "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-core";

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
  backfillStep(): Promise<{ swapsIngested: number; bucketsWritten: number }>;
}

/** A transaction the decoder will find no swap prints in. */
function tx(blockHeight: number, ageMs: number) {
  return {
    tx: {
      tx_id: `0x${blockHeight.toString(16)}`,
      tx_status: "success",
      block_height: blockHeight,
      block_time: Math.floor((Date.now() - ageMs) / 1000),
    },
  };
}

/** URLs the walk asked for, in order. */
let requested: string[] = [];

/**
 * Serves the transaction-list endpoint from a per-contract page function and
 * answers everything else emptily.
 */
function serve(pages: (contract: string, offset: number, limit: number) => unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requested.push(url);
      const parsed = new URL(url);
      const contract = parsed.pathname.split("/")[4] ?? "";
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 50);

      if (parsed.pathname.includes("/transactions")) {
        return {
          ok: true,
          json: async () => ({ results: pages(contract, offset, limit), total: 5_000 }),
        };
      }
      return { ok: true, json: async () => ({}) };
    })
  );
}

describe("stacks backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requested = [];
    for (const key of Object.keys(savedCursor)) delete savedCursor[key];
    loadConfig({ INDEXER_MAX_TX_PER_RUN: "50" });
    cursor.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => {
      Object.assign(savedCursor, update);
      return savedCursor;
    });
  });

  function indexer() {
    return new StacksIndexer(STACKS_MAINNET, indexerSettings()) as unknown as BackfillSeam;
  }

  function state() {
    return savedCursor.backfillState as Record<
      string,
      { offset: number; total: number; done: boolean }
    >;
  }

  it("corrects a stored offset by however much the list grew since", async () => {
    // The list is paged from the newest transaction, so 200 trades arriving
    // between ticks push the position we stopped at 200 places further down.
    // Without the correction the walk re-reads what it already has and, on a
    // busy contract, never descends at all.
    cursor.findUnique.mockResolvedValue({
      chainId: "stacks:mainnet",
      backfillDone: false,
      backfillState: {
        [ALEX]: { offset: 100, total: 4_800, done: false },
        [VELAR]: { offset: 0, total: 0, done: true },
      },
    });

    // 5000 now vs 4800 recorded: a drift of 200.
    serve((_c, offset, limit) =>
      Array.from({ length: limit }, (_, i) => tx(150_000 - offset - i, 60_000))
    );

    await indexer().backfillStep();

    const alexPages = requested.filter((u) => u.includes(ALEX) && !u.includes("limit=1&"));
    expect(new URL(alexPages[0]!).searchParams.get("offset")).toBe("300");

    // 50 transactions inspected from there, and the new list length recorded
    // so the next tick can correct against it in turn.
    expect(state()[ALEX]).toEqual({ offset: 350, total: 5_000, done: false });
  });

  it("stops when the walk reaches transactions older than the window", async () => {
    cursor.findUnique.mockResolvedValue({
      chainId: "stacks:mainnet",
      backfillDone: false,
      backfillState: {},
    });

    // Everything on the first page predates the 24h window.
    serve((_c, _offset, limit) => Array.from({ length: limit }, (_, i) => tx(90_000 - i, 48 * 3_600_000)));

    await indexer().backfillStep();

    expect(state()[ALEX]?.done).toBe(true);
    expect(state()[VELAR]?.done).toBe(true);
    // Every contract finished means the chain has.
    expect(savedCursor.backfillDone).toBe(true);
  });

  it("stops when it runs off the end of a contract's history", async () => {
    cursor.findUnique.mockResolvedValue({
      chainId: "stacks:mainnet",
      backfillDone: false,
      backfillState: {},
    });

    serve(() => []);

    await indexer().backfillStep();
    expect(state()[ALEX]?.done).toBe(true);
    expect(savedCursor.backfillDone).toBe(true);
  });

  it("never restarts a chain it has already finished", async () => {
    cursor.findUnique.mockResolvedValue({
      chainId: "stacks:mainnet",
      backfillDone: true,
      backfillState: {},
    });
    serve(() => []);

    await indexer().backfillStep();
    expect(requested).toHaveLength(0);
    expect(cursor.upsert).not.toHaveBeenCalled();
  });

  it("can be turned off entirely", async () => {
    loadConfig({ INDEXER_BACKFILL_WINDOW_HOURS: "0" });
    await indexer().backfillStep();
    expect(cursor.findUnique).not.toHaveBeenCalled();
  });

  it("keeps walking past the window when asked for all of history", async () => {
    // The explicit switch beats the tuning knob: a window of zero would
    // otherwise read as "disabled" and silently ignore the request.
    loadConfig({
      INDEXER_MAX_TX_PER_RUN: "50",
      INDEXER_BACKFILL_WINDOW_HOURS: "0",
      INDEXER_BACKFILL_FULL_HISTORY: "true",
    });
    cursor.findUnique.mockResolvedValue({
      chainId: "stacks:mainnet",
      backfillDone: false,
      backfillState: {},
    });

    // Two years old, and still not a reason to stop.
    serve((_c, _offset, limit) =>
      Array.from({ length: limit }, (_, i) => tx(50_000 - i, 730 * 24 * 3_600_000))
    );

    await indexer().backfillStep();

    expect(state()[ALEX]?.done).toBe(false);
    expect(state()[ALEX]?.offset).toBe(50);
    expect(savedCursor.backfillDone).toBe(false);
  });

  it("ignores a stored entry it cannot make sense of", async () => {
    // The column has no schema, and a walk that throws on a malformed entry
    // takes the chain's live ingestion down with it. Restarting that contract
    // from the head costs requests and nothing else — a replayed swap inserts
    // nothing, since swaps are stored under their on-chain identity.
    cursor.findUnique.mockResolvedValue({
      chainId: "stacks:mainnet",
      backfillDone: false,
      backfillState: { [ALEX]: { offset: "not a number" }, [VELAR]: null },
    });

    serve((_c, _offset, limit) => Array.from({ length: limit }, (_, i) => tx(150_000 - i, 60_000)));

    await indexer().backfillStep();
    expect(state()[ALEX]).toEqual({ offset: 50, total: 5_000, done: false });
  });
});
