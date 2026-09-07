import { describe, it, expect, vi } from "vitest";
import { BlockTimeOracle } from "../../../src/services/indexer/blockTimeOracle.js";

/** Every block in [from, to], as ingestion would pass them after finding a swap in each. */
function range(from: bigint, to: bigint): bigint[] {
  const out: bigint[] = [];
  for (let b = from; b <= to; b++) out.push(b);
  return out;
}

/** A chain producing a block every `blockMs`, starting at `originMs`. */
function fakeClient(blockMs: number, originMs = 1_700_000_000_000) {
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
    timestamp: BigInt(Math.floor((originMs + Number(blockNumber) * blockMs) / 1000)),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { getBlock } as any, getBlock, originMs };
}

describe("BlockTimeOracle", () => {
  it("interpolates accurately on a constant-block-time chain", async () => {
    const { client, originMs } = fakeClient(250);
    const oracle = new BlockTimeOracle(client);

    // Sparse swaps spread across a wide span: the oracle holds the endpoints
    // and a scatter between, and interpolates everything in between them.
    await oracle.primeBlocks([1_000n, 6_000n, 11_000n, 16_000n, 21_000n]);

    for (const block of [1_000n, 5_137n, 12_500n, 20_999n, 21_000n]) {
      const expected = originMs + Number(block) * 250;
      // Within a second — the bucket it feeds is five minutes wide.
      expect(Math.abs(oracle.timeOf(block) - expected)).toBeLessThan(1_000);
    }
  });

  it("samples every block asked for when they fit the budget", async () => {
    const { client, getBlock } = fakeClient(250);
    const oracle = new BlockTimeOracle(client, 200);

    await oracle.primeBlocks(range(10n, 20n));

    expect(getBlock.mock.calls.length).toBe(11);
  });

  it("clamps rather than extrapolates outside the primed range", async () => {
    const { client, originMs } = fakeClient(1_000);
    const oracle = new BlockTimeOracle(client);

    await oracle.primeBlocks([100n, 150n, 200n]);

    expect(oracle.timeOf(50n)).toBe(originMs + 100 * 1_000);
    expect(oracle.timeOf(500n)).toBe(originMs + 200 * 1_000);
  });

  it("falls back when nothing could be sampled", async () => {
    const client = {
      getBlock: vi.fn().mockRejectedValue(new Error("rpc down")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const oracle = new BlockTimeOracle(client);

    await oracle.primeBlocks(range(1n, 100n));

    // An unreachable RPC must not throw out of ingestion; swaps still land,
    // just in the current bucket.
    expect(oracle.sampleCount).toBe(0);
    expect(oracle.timeOf(50n, 12_345)).toBe(12_345);
  });

  it("survives a partially failing RPC", async () => {
    let calls = 0;
    const client = {
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        if (++calls % 3 === 0) throw new Error("flaky");
        return { timestamp: BigInt(1_700_000_000 + Number(blockNumber)) };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const oracle = new BlockTimeOracle(client);

    await oracle.primeBlocks(range(0n, 300n));

    expect(oracle.sampleCount).toBeGreaterThan(0);
    const at = oracle.timeOf(150n);
    expect(Number.isFinite(at)).toBe(true);
  });

  describe("primeBlocks", () => {
    it("samples only the blocks it is given, not the range they span", async () => {
      const { client, getBlock, originMs } = fakeClient(250);
      const oracle = new BlockTimeOracle(client);

      // Four swaps across three distinct blocks, spread over 20k blocks.
      await oracle.primeBlocks([1_000n, 12_500n, 12_500n, 21_000n]);

      // The whole point of the change: three reads, not twenty thousand — and
      // not the 200 that priming the enclosing range would have cost.
      expect(getBlock.mock.calls.length).toBe(3);
      expect(oracle.timeOf(12_500n)).toBe(originMs + 12_500 * 250);
    });

    it("costs nothing when the range produced no swaps", async () => {
      const { client, getBlock } = fakeClient(250);
      const oracle = new BlockTimeOracle(client);

      await oracle.primeBlocks([]);

      expect(getBlock).not.toHaveBeenCalled();
      expect(oracle.sampleCount).toBe(0);
    });

    it("ignores null and undefined block numbers", async () => {
      const { client, getBlock } = fakeClient(250);
      const oracle = new BlockTimeOracle(client);

      await oracle.primeBlocks([null, 5n, undefined, 5n]);

      expect(getBlock.mock.calls.length).toBe(1);
    });

    it("stays bounded when a range is dense with swaps", async () => {
      const { client, getBlock } = fakeClient(250);
      const oracle = new BlockTimeOracle(client, 50);

      const blocks = Array.from({ length: 5_000 }, (_, i) => BigInt(i));
      await oracle.primeBlocks(blocks);

      // Interpolation still applies above the budget: a busy range must not
      // become one round trip per block.
      expect(getBlock.mock.calls.length).toBeLessThanOrEqual(51);
    });

    it("keeps both endpoints so nothing extrapolates", async () => {
      const { client, originMs } = fakeClient(1_000);
      const oracle = new BlockTimeOracle(client, 10);

      const blocks = Array.from({ length: 500 }, (_, i) => BigInt(i));
      await oracle.primeBlocks(blocks);

      // The last block is in the sampled set, so it reads exactly rather than
      // being clamped to whatever the last strided sample happened to be.
      expect(oracle.timeOf(499n)).toBe(originMs + 499 * 1_000);
    });

    it("does not re-fetch a block it already sampled", async () => {
      const { client, getBlock } = fakeClient(250);
      const oracle = new BlockTimeOracle(client);

      await oracle.primeBlocks([10n, 20n]);
      await oracle.primeBlocks([10n, 20n, 30n]);

      expect(getBlock.mock.calls.length).toBe(3);
    });
  });

  it("returns monotonically increasing times for increasing blocks", async () => {
    const { client } = fakeClient(2_000);
    const oracle = new BlockTimeOracle(client, 50);

    await oracle.primeBlocks(range(0n, 500n).map((b) => b * 20n));

    let previous = -Infinity;
    for (let block = 0n; block <= 10_000n; block += 137n) {
      const at = oracle.timeOf(block);
      expect(at).toBeGreaterThanOrEqual(previous);
      previous = at;
    }
  });
});
