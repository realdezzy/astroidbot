import type { ChainId } from "../../../types/chain.js";
import type { DexAdapter } from "./dexAdapter.js";
import { UniswapV3Adapter } from "./uniswapV3Adapter.js";
import { StacksAlexVelarAdapter } from "./stacksAlexVelarAdapter.js";
import { SolanaJupiterAdapter } from "./solanaJupiterAdapter.js";
import { BitflowAdapter } from "./bitflowAdapter.js";
import { PumpFunAdapter } from "./pumpFunAdapter.js";
import { RaydiumAdapter } from "./raydiumAdapter.js";

export class DexAdapterRegistry {
  private static instance: DexAdapterRegistry;
  private adapters: DexAdapter[] = [];

  private constructor() {
    this.register(new UniswapV3Adapter());
    this.register(new StacksAlexVelarAdapter());
    this.register(new SolanaJupiterAdapter());
    this.register(new BitflowAdapter());
    this.register(new PumpFunAdapter());
    this.register(new RaydiumAdapter());
  }

  static getInstance(): DexAdapterRegistry {
    if (!DexAdapterRegistry.instance) {
      DexAdapterRegistry.instance = new DexAdapterRegistry();
    }
    return DexAdapterRegistry.instance;
  }

  register(adapter: DexAdapter): void {
    this.adapters.push(adapter);
  }

  getAdapter(dexId: string, chainId: ChainId): DexAdapter | null {
    return this.adapters.find((adapter) => adapter.canHandle(dexId, chainId)) ?? null;
  }
}
