import { logger } from "../../utils/logger.js";
import { DEFAULT_CHAIN_FOR_FAMILY } from "./descriptors/index.js";
import type { ChainAdapter } from "../../types/chainAdapter.js";
import type { ChainDescriptor, ChainFamily, ChainId } from "../../types/chain.js";

/**
 * Registry of the chains this deployment can actually transact on.
 *
 * Keyed by ChainId, not ChainFamily. The previous version keyed on family and
 * `return`ed early on a duplicate, which meant registering a second EVM chain
 * silently did nothing — Celo would be dropped on the floor with no log line
 * and no error, and every Celo wallet would dispatch through Base's adapter.
 * Duplicate registration now throws, because a chain that fails to register is
 * indistinguishable from one that was never configured.
 */
export class ChainAdapterRegistry {
  private static instance: ChainAdapterRegistry;
  private byChainId = new Map<ChainId, ChainAdapter>();
  private byFamily = new Map<ChainFamily, ChainAdapter[]>();

  private constructor() { }

  static getInstance(): ChainAdapterRegistry {
    if (!ChainAdapterRegistry.instance) {
      ChainAdapterRegistry.instance = new ChainAdapterRegistry();
    }
    return ChainAdapterRegistry.instance;
  }

  register(adapter: ChainAdapter): void {
    const { chainId, family } = adapter.descriptor;

    if (this.byChainId.has(chainId)) {
      throw new Error(
        `Duplicate chain adapter registration for "${chainId}". ` +
        `Already registered: ${[...this.byChainId.keys()].join(", ")}`
      );
    }

    this.byChainId.set(chainId, adapter);
    this.byFamily.set(family, [...(this.byFamily.get(family) ?? []), adapter]);
    logger.info(`[ChainAdapterRegistry] Registered ${chainId} (family: ${family})`);
  }

  get(chainId: ChainId): ChainAdapter {
    const adapter = this.byChainId.get(chainId);
    if (!adapter) {
      throw new Error(
        `No chain adapter registered for "${chainId}". ` +
        `Registered: ${[...this.byChainId.keys()].join(", ") || "(none)"}`
      );
    }
    return adapter;
  }

  has(chainId: ChainId): boolean {
    return this.byChainId.has(chainId);
  }

  /** All adapters sharing an execution shape. */
  forFamily(family: ChainFamily): ChainAdapter[] {
    return this.byFamily.get(family) ?? [];
  }

  /** Descriptors for every registered chain — powers /api/chains and UI pickers. */
  list(): ChainDescriptor[] {
    return [...this.byChainId.values()].map((a) => a.descriptor);
  }

  /** Registered chains that have a routing DEX, i.e. can actually swap. */
  tradable(): ChainDescriptor[] {
    return this.list().filter((d) => d.tradable);
  }

  /**
   * Resolves the ChainId for a wallet row.
   *
   * `Wallet.chain` has held the concrete chainId since the column was added, so
   * it is preferred. The `chainFamily` fallback covers rows written before that
   * and any caller still passing a bare family string; it resolves to the
   * family's default network, which is the pre-multi-chain behaviour.
   */
  resolveChainId(wallet: { chain?: string | null; chainFamily?: string | null }): ChainId {
    if (wallet.chain && this.byChainId.has(wallet.chain)) return wallet.chain;
    if (wallet.chain) {
      // The row names a chain this deployment doesn't have enabled. Return it
      // anyway so get() throws a message naming the actual chain rather than
      // quietly executing on the family default — which would be the wrong
      // network, with real funds.
      return wallet.chain;
    }
    const family = wallet.chainFamily ?? "stacks";
    return DEFAULT_CHAIN_FOR_FAMILY[family] ?? family;
  }

  /** Test-only: drop all registrations so suites can build their own fixtures. */
  reset(): void {
    this.byChainId.clear();
    this.byFamily.clear();
  }
}
