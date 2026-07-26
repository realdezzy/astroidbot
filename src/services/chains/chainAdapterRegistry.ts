import { logger } from "../../utils/logger.js";
import type { ChainAdapter } from "../../types/chainAdapter.js";

// Mirrors DEXRegistry's registration pattern (src/services/dex/dexRegistry.ts)
// so the two registries are instantly recognizable as the same shape.
export class ChainAdapterRegistry {
  private static instance: ChainAdapterRegistry;
  private adapters = new Map<string, ChainAdapter>();

  private constructor() { }

  static getInstance(): ChainAdapterRegistry {
    if (!ChainAdapterRegistry.instance) {
      ChainAdapterRegistry.instance = new ChainAdapterRegistry();
    }
    return ChainAdapterRegistry.instance;
  }

  register(adapter: ChainAdapter): void {
    if (this.adapters.has(adapter.chainFamily)) return;
    this.adapters.set(adapter.chainFamily, adapter);
    logger.info(`[ChainAdapterRegistry] Registered adapter: ${adapter.chainFamily}`);
  }

  get(chainFamily: string): ChainAdapter {
    const adapter = this.adapters.get(chainFamily);
    if (!adapter) {
      throw new Error(`No chain adapter registered for chainFamily "${chainFamily}"`);
    }
    return adapter;
  }

  has(chainFamily: string): boolean {
    return this.adapters.has(chainFamily);
  }
}
