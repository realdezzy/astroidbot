import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import {
  MULTICALL3_ADDRESS,
  hasMulticall3,
  multicallRead,
  resetMulticallCache,
} from "../../../src/services/chains/evm/multicall.js";
import { ERC20_ABI } from "../../../src/services/chains/evm/abis.js";

function uint256(value: bigint): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters("uint256"), [value]);
}

/**
 * A Multicall3 that answers `balanceOf` with the index of the call, and marks
 * whichever positions the test names as failed.
 */
function fakeMulticall(count: number, failAt: number[] = []) {
  const readContract = vi.fn(async () =>
    Array.from({ length: count }, (_, i) =>
      failAt.includes(i)
        ? { success: false, returnData: "0x" as const }
        : { success: true, returnData: uint256(BigInt(i * 100)) }
    )
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { readContract } as any, readContract };
}

const requests = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    address: `0x${String(i).padStart(40, "0")}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: ["0x0000000000000000000000000000000000000001"],
  }));

describe("multicallRead", () => {
  beforeEach(() => resetMulticallCache());

  it("collapses many reads into one eth_call", async () => {
    const { client, readContract } = fakeMulticall(50);

    const results = await multicallRead(client, requests(50));

    // The reason this module exists: 50 balance reads, one round trip.
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(50);
    expect(results[7]).toBe(700n);
  });

  it("targets the canonical Multicall3 address", async () => {
    const { client, readContract } = fakeMulticall(1);

    await multicallRead(client, requests(1));

    expect(readContract.mock.calls[0]![0].address).toBe(MULTICALL3_ADDRESS);
    expect(readContract.mock.calls[0]![0].functionName).toBe("aggregate3");
  });

  it("allows failure per call rather than losing the batch", async () => {
    const { client } = fakeMulticall(4, [1]);

    const results = await multicallRead(client, requests(4));

    // A reverting ERC-20 is one null, not four — this is the property that
    // lets it replace a loop of individually try/caught reads.
    expect(results[0]).toBe(0n);
    expect(results[1]).toBeNull();
    expect(results[2]).toBe(200n);
    expect(results[3]).toBe(300n);
  });

  it("splits past the batch ceiling and keeps result order", async () => {
    let call = 0;
    const readContract = vi.fn(async ({ args }: { args: [unknown[]] }) => {
      const size = args[0].length;
      const base = call;
      call += size;
      return Array.from({ length: size }, (_, i) => ({
        success: true,
        returnData: uint256(BigInt(base + i)),
      }));
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { readContract } as any;

    const results = await multicallRead(client, requests(250));

    expect(readContract).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(250);
    expect(results[0]).toBe(0n);
    expect(results[249]).toBe(249n);
  });

  it("returns nulls rather than throwing when the chain has no Multicall3", async () => {
    const client = {
      readContract: vi.fn().mockRejectedValue(new Error("execution reverted")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const results = await multicallRead(client, requests(3));

    // Same outcome as each individual read failing: "we don't know", which is
    // what every caller already handles.
    expect(results).toEqual([null, null, null]);
  });

  it("makes no call at all for an empty request set", async () => {
    const { client, readContract } = fakeMulticall(0);

    expect(await multicallRead(client, [])).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("hasMulticall3", () => {
  beforeEach(() => resetMulticallCache());

  it("probes once per chain and caches the answer", async () => {
    const getBytecode = vi.fn().mockResolvedValue("0x6080604052");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { getBytecode } as any;

    expect(await hasMulticall3(client, "base:mainnet")).toBe(true);
    expect(await hasMulticall3(client, "base:mainnet")).toBe(true);

    // A deployment cannot appear while the process is up.
    expect(getBytecode).toHaveBeenCalledTimes(1);
  });

  it("reads empty bytecode as absent", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { getBytecode: vi.fn().mockResolvedValue("0x") } as any;
    expect(await hasMulticall3(client, "obscure:mainnet")).toBe(false);
  });

  it("reads a failed probe as absent rather than throwing", async () => {
    const client = {
      getBytecode: vi.fn().mockRejectedValue(new Error("rpc down")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(await hasMulticall3(client, "flaky:mainnet")).toBe(false);
  });
});
