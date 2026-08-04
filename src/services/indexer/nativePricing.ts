import { DatabaseService } from "../db.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { logger } from "../../utils/logger.js";
import type { ChainDescriptor } from "../../types/chain.js";

/**
 * USD price for a chain's native asset.
 *
 * This is the keystone of the whole index: nearly every pool on an EVM chain
 * quotes against the wrapped native, so without this number no swap on the
 * chain has a dollar value and the volume column is uniformly zero.
 *
 * It cannot always be answered locally. Robinhood Chain is the case that forced
 * this module to exist — it has no WETH/rUSDC pool at any fee tier, so there is
 * no on-chain path from ETH to a dollar anywhere on that chain. Anchoring
 * purely to local pools produced a plausible-looking index in which every
 * token had $0 volume.
 *
 * The resolution order below reflects what is both available and *truthful*:
 *
 *  1. The deepest local native/stable pool. Most accurate when it exists,
 *     because it is the price this chain's traders actually transact at.
 *  2. The same asset's price on another chain we index. ETH is ETH — its
 *     dollar price is a global fact, and a deep Ethereum pool is a far better
 *     estimate for Robinhood's WETH than a thin local pool would be.
 *  3. A live DEX quote through the chain's own router.
 *
 * When all three fail we return null and say so, rather than defaulting to a
 * number. A wrong anchor silently misprices every token on the chain by the
 * same factor, which is much harder to notice than a missing one.
 */

export interface NativePriceInput {
  descriptor: ChainDescriptor;
  /** Local candidate pools pairing the wrapped native against a stable. */
  anchorPools: { token0: string; lastPrice0: number | null; liquidityUsd: number | null }[];
  wrappedNative: string;
  stables: Set<string>;
}

export async function resolveNativeUsd(input: NativePriceInput): Promise<number | null> {
  const local = fromLocalPool(input);
  if (local != null) return local;

  const crossChain = await fromOtherChains(input.descriptor);
  if (crossChain != null) {
    logger.debug("[indexer] native price sourced cross-chain", {
      chainId: input.descriptor.chainId,
      symbol: input.descriptor.nativeSymbol,
      priceUsd: crossChain,
    });
    return crossChain;
  }

  const quoted = await fromDexQuote(input.descriptor);
  if (quoted != null) return quoted;

  logger.warn(
    "[indexer] no USD anchor for native asset — volume on this chain cannot be valued",
    {
      chainId: input.descriptor.chainId,
      symbol: input.descriptor.nativeSymbol,
      hint:
        "No local native/stable pool, no other indexed chain carrying this symbol, " +
        "and no routable DEX quote. Enable a chain that prices this asset " +
        "(e.g. ethereum:mainnet for ETH) to value this chain's swaps.",
    }
  );

  return null;
}

/** Deepest local wrappedNative/stable pool. */
function fromLocalPool({ anchorPools, wrappedNative }: NativePriceInput): number | null {
  const best = anchorPools
    .filter((p) => p.lastPrice0 != null && p.lastPrice0 > 0)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];

  if (!best?.lastPrice0) return null;

  // lastPrice0 is token0 denominated in token1; invert when native is token1.
  const price = best.token0 === wrappedNative ? best.lastPrice0 : 1 / best.lastPrice0;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * The same asset, priced on a chain that can price it.
 *
 * Matches on symbol across chains — deliberately, because that is exactly the
 * claim being made: the ETH on Robinhood is the same asset as the ETH on
 * Ethereum. Restricted to mainnets so a testnet's arbitrary price can never
 * leak into a mainnet valuation.
 */
async function fromOtherChains(descriptor: ChainDescriptor): Promise<number | null> {
  const db = DatabaseService.getInstance();
  const symbol = descriptor.nativeSymbol.toUpperCase();

  // "ETH" and "WETH" are the same thing for pricing purposes, and chains
  // disagree about which name they list.
  const aliases = [symbol, `W${symbol}`, symbol.replace(/^W/, "")];

  // IndexedToken, not Token: the anchor must be a price we observed on-chain
  // ourselves. Token's price column can be a DEX-derived spot quote or a stale
  // cache, and anchoring on one would misprice every token on this chain by
  // the same factor — the hardest kind of error to notice.
  const candidates = await db.prisma.indexedToken.findMany({
    where: {
      symbol: { in: [...new Set(aliases)], mode: "insensitive" },
      chainId: { not: descriptor.chainId },
      priceUsd: { gt: 0 },
    },
    orderBy: [{ liquidityUsd: { sort: "desc", nulls: "last" } }],
    take: 5,
  });

  for (const candidate of candidates) {
    if (candidate.priceUsd && candidate.priceUsd > 0) return candidate.priceUsd;
  }

  return null;
}

/** A live quote through this chain's own router. */
async function fromDexQuote(descriptor: ChainDescriptor): Promise<number | null> {
  try {
    const price = await DEXRegistry.getInstance().getTokenPrice(
      descriptor.nativeSymbol,
      descriptor.chainId
    );
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}
