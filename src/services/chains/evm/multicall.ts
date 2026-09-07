import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { logger } from "../../../utils/logger.js";

/**
 * Batched contract reads through Multicall3.
 *
 * The indexer's two heaviest read paths are shaped identically: the same
 * function against many addresses, or a handful of functions against one. Sent
 * one at a time that is an `eth_call` each — refreshing liquidity for 300 pools
 * was 300 round trips a tick, and cataloguing one token was three. Through
 * Multicall3 the same work is one `eth_call` per hundred.
 *
 * Multicall3 is deployed at the same address on essentially every EVM chain,
 * because it is deployed with a deterministic-deployment proxy — verified
 * present on Base and Robinhood Chain, and that universality is what makes it
 * usable from code that only knows a descriptor.
 *
 * `aggregate3` rather than `aggregate`: it takes `allowFailure` per call, so
 * one reverting read (a non-standard ERC-20, a token whose `symbol()` returns
 * bytes32) yields `success: false` for that entry instead of reverting the
 * whole batch. That is what lets this replace a loop of individually
 * try/caught reads without changing their tolerance.
 */

/** Canonical Multicall3, identical on every chain that has one. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

/**
 * Calls per `aggregate3`.
 *
 * Bounded by the response size a node will return rather than by anything
 * on-chain. 100 balance reads is a few kilobytes; a few thousand would risk
 * the same "response too large" refusals the log reader already has to handle,
 * and splitting here is free.
 */
const DEFAULT_BATCH_SIZE = 100;

export interface MulticallRequest {
  address: string;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Runs every request and returns one result per request, in order.
 *
 * A failed call — reverted, undecodable, or in a batch the node refused — is
 * `null` rather than a throw, mirroring the per-call try/catch this replaces.
 * Callers already treat an unreadable value as "we don't know", which is the
 * correct reading of a null here too.
 */
export async function multicallRead(
  client: PublicClient,
  requests: MulticallRequest[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<(unknown | null)[]> {
  if (requests.length === 0) return [];

  const out: (unknown | null)[] = new Array(requests.length).fill(null);

  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const slice = requests.slice(offset, offset + batchSize);

    // An unencodable request is the caller's bug, not the chain's, but it must
    // not take the rest of the batch with it.
    const encoded = slice.map((request) => {
      try {
        return encodeFunctionData({
          abi: request.abi as Abi,
          functionName: request.functionName,
          args: request.args as never,
        });
      } catch {
        return null;
      }
    });

    const sendable = encoded
      .map((callData, index) => ({ callData, index }))
      .filter((entry): entry is { callData: `0x${string}`; index: number } => entry.callData !== null);

    if (sendable.length === 0) continue;

    let results: readonly { success: boolean; returnData: `0x${string}` }[];

    try {
      results = (await client.readContract({
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [
          sendable.map((entry) => ({
            target: slice[entry.index]!.address as Address,
            allowFailure: true,
            callData: entry.callData,
          })),
        ],
      })) as readonly { success: boolean; returnData: `0x${string}` }[];
    } catch (error) {
      // No Multicall3 on this chain, or the node refused the batch. Every
      // entry stays null and the caller falls back or reports "unknown" —
      // the same outcome each individual call failing would have produced.
      logger.debug("[multicall] batch failed", {
        size: sendable.length,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const [position, entry] of sendable.entries()) {
      const result = results[position];
      if (!result?.success) continue;

      const request = slice[entry.index]!;
      try {
        out[offset + entry.index] = decodeFunctionResult({
          abi: request.abi as Abi,
          functionName: request.functionName,
          data: result.returnData,
        });
      } catch {
        // Decoded nothing usable — a bytes32 `symbol()`, most often. Null.
      }
    }
  }

  return out;
}

/**
 * Whether this chain has Multicall3 deployed.
 *
 * Cached per chain: the answer is a property of the deployment and cannot
 * change while the process is up. Callers use it to decide whether batching is
 * available at all, rather than discovering it through a failed batch on every
 * pass.
 */
const deployment = new Map<string, Promise<boolean>>();

export function hasMulticall3(client: PublicClient, chainId: string): Promise<boolean> {
  const cached = deployment.get(chainId);
  if (cached) return cached;

  const probe = client
    .getBytecode({ address: MULTICALL3_ADDRESS })
    .then((code) => Boolean(code) && code !== "0x")
    .catch(() => false);

  deployment.set(chainId, probe);
  return probe;
}

/** Test seam — the deployment probe is module state and leaks between suites. */
export function resetMulticallCache(): void {
  deployment.clear();
}
