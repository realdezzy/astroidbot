import type { PublicClient } from "viem";
import { DatabaseService } from "../../db.js";
import { rollbackFrom } from "../swapStore.js";

type Checkpoint = { height: string; hash: string };
type State = { checkpoints?: Checkpoint[]; rollbackFrom?: string; pendingFrom?: string };

/** Detect canonical-history changes before allowing another cursor advance. */
export async function reconcileEvmHistory(chainId: string, rpc: PublicClient): Promise<void> {
  const db = DatabaseService.getInstance().prisma;
  const cursor = await db.indexerCursor.findUnique({ where: { chainId } });
  if (!cursor) return;
  const state = (cursor.forwardState ?? {}) as State;
  const checkpoints = state.checkpoints ?? [];
  let from = state.rollbackFrom ? BigInt(state.rollbackFrom) : state.pendingFrom ? BigInt(state.pendingFrom) : null;
  if (from === null && checkpoints.length) {
    const latest = checkpoints.at(-1)!;
    const block = await rpc.getBlock({ blockNumber: BigInt(latest.height) });
    if (block.hash === latest.hash) return;
    let ancestor: bigint | null = null;
    for (const saved of [...checkpoints].reverse().slice(1)) {
      const canonical = await rpc.getBlock({ blockNumber: BigInt(saved.height) });
      if (canonical.hash === saved.hash) { ancestor = BigInt(saved.height); break; }
    }
    if (ancestor === null) throw new Error("Reorg exceeds retained checkpoints; explicit historical rebuild required");
    from = ancestor + 1n;
    // Persist repair intent first, so a crash halfway through repeats the repair.
    await db.indexerCursor.update({ where: { chainId }, data: { forwardState: { checkpoints, rollbackFrom: from.toString() } } });
  }
  if (from === null) return;
  await rollbackFrom(chainId, from);
  // Pool creations can be orphaned too. Delete dependants explicitly.
  const orphaned = { chainId, createdBlock: { gte: from } };
  await db.indexedSwap.deleteMany({ where: { pool: orphaned } });
  await db.poolCandle.deleteMany({ where: { pool: orphaned } });
  await db.indexedPool.deleteMany({ where: orphaned });
  await db.indexedPool.updateMany({ where: { chainId }, data: { lastPrice0: null, lastSwapAt: null, liquidityUsd: null } });
  await db.indexedToken.updateMany({ where: { chainId }, data: { priceUsd: null, priceChange5m: null, priceChange1h: null, priceChange6h: null, priceChange24h: null } });
  await db.indexerCursor.update({ where: { chainId }, data: {
    lastBlock: from - 1n, lastPoolBlock: from - 1n,
    forwardState: { checkpoints: checkpoints.filter((c) => BigInt(c.height) < from) },
  } });
}

export async function prepareEvmRange(chainId: string, from: bigint): Promise<void> {
  const db = DatabaseService.getInstance().prisma;
  const cursor = await db.indexerCursor.findUnique({ where: { chainId } });
  const state = (cursor?.forwardState ?? {}) as State;
  await db.indexerCursor.update({ where: { chainId }, data: {
    forwardState: { checkpoints: state.checkpoints ?? [], pendingFrom: from.toString() },
  } });
}

/** Commit this state in the SAME transaction as lastBlock. */
export async function evmCheckpoint(chainId: string, height: bigint, rpc: PublicClient) {
  const db = DatabaseService.getInstance().prisma;
  const cursor = await db.indexerCursor.findUnique({ where: { chainId } });
  const state = (cursor?.forwardState ?? {}) as State;
  const block = await rpc.getBlock({ blockNumber: height });
  if (!block.hash) throw new Error(`Missing canonical hash at ${height}`);
  const checkpoints = (state.checkpoints ?? []).filter((c) => BigInt(c.height) < height);
  checkpoints.push({ height: height.toString(), hash: block.hash });
  return { checkpoints: checkpoints.slice(-64) };
}
