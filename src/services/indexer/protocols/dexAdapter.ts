import type { ChainId } from "../../../types/chain.js";
import type { SwapEvent, PoolCreatedEvent } from "../events/canonical.js";
import type { TrackedPool } from "../types.js";

export interface DexAdapter {
  readonly dexId: string;
  readonly chainFamily: "evm" | "svm" | "stacks";

  canHandle(dexId: string, chainId: ChainId): boolean;
  decodeSwap(pool: TrackedPool, rawLogOrTx: unknown): SwapEvent | null;
  decodePoolCreated(rawLogOrTx: unknown, chainId: ChainId): PoolCreatedEvent | null;
}
