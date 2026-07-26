import { UniswapV3Provider } from "./uniswapV3.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "../../chains/descriptors/base.js";
import { ConfigManager } from "../../../config.js";
import type { ChainDescriptor } from "../../../types/chain.js";

/**
 * Uniswap V3 on Base.
 *
 * Retained as a named class only because bootstrap and the existing tests
 * reference it; all behaviour lives in UniswapV3Provider, and Celo or any
 * other V3 fork is now `new UniswapV3Provider(descriptor)` with no subclass at
 * all. Address validation happens in the adapter at registration.
 */
export class UniswapV3BaseProvider extends UniswapV3Provider {
  private static instance: UniswapV3BaseProvider | undefined;

  constructor(descriptor?: ChainDescriptor) {
    super(descriptor ?? UniswapV3BaseProvider.descriptorFromConfig());
  }

  private static descriptorFromConfig(): ChainDescriptor {
    return ConfigManager.getInstance().config.BASE_NETWORK === "mainnet"
      ? BASE_MAINNET
      : BASE_SEPOLIA;
  }

  static initialize(): UniswapV3BaseProvider {
    if (!UniswapV3BaseProvider.instance) {
      UniswapV3BaseProvider.instance = new UniswapV3BaseProvider();
    }
    return UniswapV3BaseProvider.instance;
  }

  static getInstance(): UniswapV3BaseProvider {
    if (!UniswapV3BaseProvider.instance) {
      throw new Error("UniswapV3BaseProvider not initialized. Call initialize() first.");
    }
    return UniswapV3BaseProvider.instance;
  }

  /** Test-only: drop the singleton so suites can rebuild it per descriptor. */
  static reset(): void {
    UniswapV3BaseProvider.instance = undefined;
  }
}
