import type { ChainId } from "../../../types/chain.js";
import type { DexAdapter } from "./dexAdapter.js";
import { UniswapV2Adapter } from "./uniswapV2Adapter.js";
import { UniswapV3Adapter } from "./uniswapV3Adapter.js";
import type { TrackedPool } from "../types.js";

/** Aerodrome has different creation events; its swap amounts share V2/V3 semantics. */
export class AerodromeAdapter implements DexAdapter {
  readonly chainFamily = "evm";
  private readonly delegate;
  constructor(readonly dexId: "aerodrome-v2" | "aerodrome-slipstream") {
    this.delegate = dexId === "aerodrome-v2" ? new UniswapV2Adapter() : new UniswapV3Adapter();
  }
  canHandle(dexId: string, _chainId: ChainId) { return dexId === this.dexId; }
  decodePoolCreated(raw: unknown, chainId: ChainId) {
    const log = raw as { args?: { pool?: string } };
    const decoded = this.delegate.decodePoolCreated(this.dexId === "aerodrome-v2"
      ? { ...log, args: { ...log.args, pair: log.args?.pool } } : log, chainId);
    return decoded ? { ...decoded, dexId: this.dexId, feeTier: null } : null;
  }
  decodeSwap(pool: TrackedPool, raw: unknown) { return this.delegate.decodeSwap(pool, raw); }
}
