import { describe, it, expect, vi } from "vitest";
import { BlockTimeOracle } from "../../../src/services/indexer/blockTimeOracle.js";

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

    await oracle.prime(1_000n, 21_000n);

    for (const block of [1_000n, 5_137n, 12_500n, 20_999n, 21_000n]) {
      const expected = originMs + Number(block) * 250;
      // Within a second — the bucket it feeds is five minutes wide.
      expect(Math.abs(oracle.timeOf(block) - expected)).toBeLessThan(1_000);
    }
  });

  it("samples a bounded number of blocks regardless of range size", async () => {
    const { client, getBlock } = fakeClient(12_000);
    const oracle = new BlockTimeOracle(client, 200);

    await oracle.prime(0n, 1_000_000n);

    // The entire point: cost is constant in range size, not linear.
    expect(getBlock.mock.calls.length).toBeLessThanOrEqual(201);
    expect(oracle.sampleCount).toBeGreaterThan(0);
  });

  it("samples every block when the range is smaller than the sample budget", async () => {
    const { client, getBlock } = fakeClient(250);
    const oracle = new BlockTimeOracle(client, 200);

    await oracle.prime(10n, 20n);

    expect(getBlock.mock.calls.length).toBe(11);
  });

  it("clamps rather than extrapolates outside the primed range", async () => {
    const { client, originMs } = fakeClient(1_000);
    const oracle = new BlockTimeOracle(client);

    await oracle.prime(100n, 200n);

    expect(oracle.timeOf(50n)).toBe(originMs + 100 * 1_000);
    expect(oracle.timeOf(500n)).toBe(originMs + 200 * 1_000);
  });

  it("falls back when nothing could be sampled", async () => {
    const client = {
      getBlock: vi.fn().mockRejectedValue(new Error("rpc down")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const oracle = new BlockTimeOracle(client);

    await oracle.prime(1n, 100n);

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

    await oracle.prime(0n, 300n);

    expect(oracle.sampleCount).toBeGreaterThan(0);
    const at = oracle.timeOf(150n);
    expect(Number.isFinite(at)).toBe(true);
  });

  it("returns monotonically increasing times for increasing blocks", async () => {
    const { client } = fakeClient(2_000);
    const oracle = new BlockTimeOracle(client, 50);

    await oracle.prime(0n, 10_000n);

    let previous = -Infinity;
    for (let block = 0n; block <= 10_000n; block += 137n) {
      const at = oracle.timeOf(block);
      expect(at).toBeGreaterThanOrEqual(previous);
      previous = at;
    }
  });
});
