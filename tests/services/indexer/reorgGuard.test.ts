import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

const state = vi.hoisted(() => ({ cursor: { lastBlock: 200n, forwardState: {} as Record<string, unknown> } }));
const rollback = vi.hoisted(() => vi.fn().mockResolvedValue(3));
const update = vi.hoisted(() => vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(state.cursor, data)));
const getBlock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  indexerCursor: { findUnique: async () => state.cursor, update },
  indexedSwap: { deleteMany: vi.fn() }, poolCandle: { deleteMany: vi.fn() },
  indexedPool: { deleteMany: vi.fn(), updateMany: vi.fn() }, indexedToken: { updateMany: vi.fn() },
}));
vi.mock("../../../src/services/db.js", () => ({ DatabaseService: { getInstance: () => ({ prisma: db }) } }));
vi.mock("../../../src/services/indexer/swapStore.js", () => ({ rollbackFrom: rollback }));
import { reconcileEvmHistory, evmCheckpoint, prepareEvmRange } from "../../../src/services/indexer/evm/reorgGuard.js";
const rpc = { getBlock } as unknown as PublicClient;

describe("canonical EVM checkpoints", () => {
  beforeEach(() => { vi.clearAllMocks(); state.cursor = { lastBlock: 200n, forwardState: {} }; });
  it("rolls back to the last matching checkpoint and removes orphaned pools", async () => {
    state.cursor.forwardState = { checkpoints: [{ height: "100", hash: "canonical" }, { height: "200", hash: "orphan" }] };
    getBlock.mockImplementation(async ({ blockNumber }) => ({ hash: blockNumber === 100n ? "canonical" : "replacement" }));
    await reconcileEvmHistory("base:mainnet", rpc);
    expect(rollback).toHaveBeenCalledWith("base:mainnet", 101n);
    expect(state.cursor.lastBlock).toBe(100n);
    expect(db.indexedPool.deleteMany).toHaveBeenCalledWith({ where: { chainId: "base:mainnet", createdBlock: { gte: 101n } } });
    expect(update.mock.calls[0]?.[0].data).toMatchObject({ forwardState: { rollbackFrom: "101" } });
  });
  it("repeats interrupted range recovery after a process restart", async () => {
    await prepareEvmRange("base:mainnet", 201n);
    expect(state.cursor.forwardState.pendingFrom).toBe("201");
    await reconcileEvmHistory("base:mainnet", rpc);
    expect(rollback).toHaveBeenCalledWith("base:mainnet", 201n);
    expect(state.cursor.lastBlock).toBe(200n);
    expect(state.cursor.forwardState).not.toHaveProperty("pendingFrom");
  });
  it("fails closed when the reorg predates every known checkpoint", async () => {
    state.cursor.forwardState = { checkpoints: [{ height: "100", hash: "orphan" }] };
    getBlock.mockResolvedValue({ hash: "replacement" });
    await expect(reconcileEvmHistory("base:mainnet", rpc)).rejects.toThrow("exceeds retained checkpoints");
    expect(rollback).not.toHaveBeenCalled();
  });
  it("returns a checkpoint for atomic cursor commit without clearing pending work early", async () => {
    state.cursor.forwardState = { checkpoints: [{ height: "100", hash: "old" }], pendingFrom: "101" };
    getBlock.mockResolvedValue({ hash: "new" });
    expect(await evmCheckpoint("base:mainnet", 200n, rpc)).toEqual({ checkpoints: [{ height: "100", hash: "old" }, { height: "200", hash: "new" }] });
    expect(update).not.toHaveBeenCalled();
    expect(state.cursor.forwardState.pendingFrom).toBe("101");
  });
});
