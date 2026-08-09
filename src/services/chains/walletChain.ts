import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { resolveChainId } from "./executeSwap.js";
import { findDescriptor, DEFAULT_CHAIN_ID } from "./descriptors/index.js";
import type { ChainDescriptor, ChainId } from "../../types/chain.js";

/** The minimum shape any wallet-ish row needs for chain resolution. */
export interface ChainBearing {
  chain?: string | null;
  chainFamily?: string | null;
}

/**
 * The one way to get a wallet's ChainId.
 *
 * Every call site used to write `w.chainFamily ?? "stacks"` inline, which was
 * both a repeated default and — once two chains shared a family — the wrong
 * answer. Centralised so the fallback order is stated once.
 */
export function walletChainId(wallet: ChainBearing): ChainId {
  return resolveChainId({ chainId: wallet.chain, chainFamily: wallet.chainFamily });
}

/**
 * The descriptor for a wallet's chain.
 *
 * Prefers the registered adapter (which reflects what this deployment actually
 * runs), then the built-in catalogue, then the default chain. Never throws —
 * display code calling this must not blow up on a wallet whose chain has been
 * disabled, it just needs sensible labels.
 */
export function walletDescriptor(wallet: ChainBearing): ChainDescriptor {
  const chainId = walletChainId(wallet);
  const registry = ChainAdapterRegistry.getInstance();

  if (registry.has(chainId)) return registry.get(chainId).descriptor;

  return findDescriptor(chainId) ?? findDescriptor(DEFAULT_CHAIN_ID)!;
}

/** Native asset ticker for a wallet's chain — replaces hardcoded "STX". */
export function walletNativeSymbol(wallet: ChainBearing): string {
  return walletDescriptor(wallet).nativeSymbol;
}

/** USD-denominating stablecoin symbol the wallet's DEXs can actually route. */
export function walletStableSymbol(wallet: ChainBearing): string {
  return walletDescriptor(wallet).stableSymbol;
}

/**
 * Explorer link for a transaction on a named chain, or null if we don't run it.
 *
 * Exists so no surface composes one by hand. Four of them did — the trades
 * table, the strategy detail modal, the agent chat and the perp row — each
 * hardcoding a Hiro URL, so every trade on any other chain linked to an
 * explorer that has never heard of it. Returning null rather than a guess lets
 * a caller render plain text instead of a link that 404s.
 */
export function explorerTxUrlFor(chainId: string, txId: string | null): string | null {
  if (!txId) return null;
  const descriptor = findDescriptor(chainId);
  return descriptor ? descriptor.explorerTxUrl(txId) : null;
}

/** Groups rows by ChainId — used wherever balances or quotes must be fetched per chain. */
export function groupByChainId<T extends ChainBearing>(rows: T[]): Map<ChainId, T[]> {
  const out = new Map<ChainId, T[]>();
  for (const row of rows) {
    const id = walletChainId(row);
    const bucket = out.get(id);
    if (bucket) bucket.push(row);
    else out.set(id, [row]);
  }
  return out;
}
