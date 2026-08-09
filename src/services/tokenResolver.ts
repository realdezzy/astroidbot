import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { ChainAdapterRegistry } from "./chains/chainAdapterRegistry.js";
import type { ChainId } from "../types/chain.js";

/**
 * Turns what a user typed into tokens they could actually trade.
 *
 * Both interfaces used to match a typed symbol against `getSwappableTokens()`
 * — the curated per-provider list — with an exact string compare. Anything
 * else was rejected as "not recognized by any DEX provider". Two consequences,
 * and the second is the awkward one:
 *
 *  - A contract address could never match, because an address is not a symbol.
 *  - **The entire long tail the indexer exists to surface was unreachable.**
 *    Those tokens live in the catalogue and the index, not in any provider's
 *    hardcoded list, so the one feature built to find them could not be used
 *    to buy them. The only route was clicking through from the discovery page.
 *
 * So resolution walks outward from the most trustworthy source to the least,
 * and every result says which source it came from. A caller that wants to
 * refuse anything unlisted still can; a caller that wants to let someone paste
 * an address now has the information to warn them properly.
 */

/** Where a match came from, in descending order of how much it implies. */
export type TokenSource =
  /** In a DEX provider's list — routable today, and curated by us. */
  | "provider"
  /** In the Token catalogue: listed on discovery, not necessarily routable. */
  | "catalogue"
  /** Seen trading by the indexer. No curation whatsoever. */
  | "indexed"
  /** Nothing knew it; it merely looks like an address for this chain. */
  | "address";

export interface ResolvedToken {
  chainId: ChainId;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  source: TokenSource;
  /** Signals for the caller to render. Absent means unknown, not zero. */
  liquidityUsd: number | null;
  priceUsd: number | null;
  isVerified: boolean;
}

/**
 * Does this look like an address on the given chain?
 *
 * Shape only — it says nothing about whether a contract is there. The point is
 * to tell "the user pasted an address" apart from "the user typed a symbol we
 * don't know", because those deserve different answers.
 */
export function looksLikeAddress(query: string, chainId: ChainId): boolean {
  const descriptor = ChainAdapterRegistry.getInstance().find(chainId);
  if (!descriptor) return false;

  switch (descriptor.family) {
    case "evm":
      return /^0x[0-9a-fA-F]{40}$/.test(query);
    case "svm":
      // Base58, and mints are 32 bytes — 32-44 characters once encoded.
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query);
    case "stacks":
      // `SP….contract-name`, optionally with a `::asset` suffix.
      return /^S[PT][0-9A-Z]{20,50}\.[a-zA-Z0-9-]+/.test(query);
    default:
      return false;
  }
}

/**
 * Every token matching `query`, across the given chain or all enabled chains.
 *
 * Returns an array rather than a best guess *on purpose*. `USDC` exists on
 * five chains and `PEPE` on several; picking one silently is how a user ends
 * up trading the wrong asset on the wrong network. Callers disambiguate — the
 * same rule social trading already applies.
 *
 * Ordered most-trustworthy first, then by liquidity, so a caller that does
 * want a single answer can take the head and be right most of the time.
 */
export async function resolveTokenQuery(
  query: string,
  chainId?: ChainId
): Promise<ResolvedToken[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const chains = chainId
    ? [chainId]
    : ChainAdapterRegistry.getInstance()
        .list()
        .filter((d) => !d.isTestnet)
        .map((d) => d.chainId);

  const found = new Map<string, ResolvedToken>();
  const key = (t: { chainId: string; contractId: string }) =>
    `${t.chainId}:${t.contractId.toLowerCase()}`;

  // 1. Provider lists. Routable today, so these outrank everything else.
  for (const chain of chains) {
    const tokens = await DEXRegistry.getInstance()
      .getSwappableTokens(false, chain)
      .catch(() => []);

    for (const token of tokens) {
      if (!matches(trimmed, token.symbol, token.contractId)) continue;
      const resolved: ResolvedToken = {
        chainId: chain,
        contractId: token.contractId,
        symbol: token.symbol,
        name: token.name ?? token.symbol,
        decimals: token.decimals,
        source: "provider",
        liquidityUsd: null,
        priceUsd: null,
        isVerified: false,
      };
      found.set(key(resolved), resolved);
    }
  }

  const db = DatabaseService.getInstance();

  // 2. The catalogue — what discovery lists, including promoted long-tail
  //    tokens. Also where the liquidity and verification signals live, so this
  //    pass enriches provider hits rather than only adding new ones.
  const catalogued = await db.prisma.token
    .findMany({
      where: { chainId: { in: chains }, ...matchWhere(trimmed) },
      orderBy: { liquidityUsd: { sort: "desc", nulls: "last" } },
      take: 25,
    })
    .catch(() => []);

  for (const row of catalogued) {
    const existing = found.get(key(row));
    if (existing) {
      existing.liquidityUsd = row.liquidityUsd;
      existing.priceUsd = row.priceUsd;
      existing.isVerified = row.isVerified;
      continue;
    }

    found.set(key(row), {
      chainId: row.chainId,
      contractId: row.contractId,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      source: "catalogue",
      liquidityUsd: row.liquidityUsd,
      priceUsd: row.priceUsd,
      isVerified: row.isVerified,
    });
  }

  // 3. The index — tokens seen trading that nothing has listed. This is the
  //    long tail, and it is the whole reason the indexer exists.
  const indexed = await db.prisma.indexedToken
    .findMany({
      where: { chainId: { in: chains }, ...matchWhere(trimmed) },
      orderBy: { liquidityUsd: { sort: "desc", nulls: "last" } },
      take: 25,
    })
    .catch(() => []);

  for (const row of indexed) {
    const existing = found.get(key(row));
    if (existing) {
      existing.liquidityUsd ??= row.liquidityUsd;
      existing.priceUsd ??= row.priceUsd;
      continue;
    }

    found.set(key(row), {
      chainId: row.chainId,
      contractId: row.contractId,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      source: "indexed",
      liquidityUsd: row.liquidityUsd,
      priceUsd: row.priceUsd,
      isVerified: false,
    });
  }

  // 4. Nothing knows it, but it is shaped like an address. Offered only when
  //    the chain is known — resolving a bare address against every chain would
  //    invite trading the wrong one — and marked as the least-known source, so
  //    a caller can insist on a confirmation step.
  if (found.size === 0 && chainId && looksLikeAddress(trimmed, chainId)) {
    found.set(`${chainId}:${trimmed.toLowerCase()}`, {
      chainId,
      contractId: trimmed,
      symbol: shortAddress(trimmed),
      name: trimmed,
      // Not assumed: the provider reads it from the contract at quote time and
      // refuses to route if it can't. Anything stated here would be a guess,
      // and decimals scale the amount actually spent.
      decimals: 0,
      source: "address",
      liquidityUsd: null,
      priceUsd: null,
      isVerified: false,
    });
  }

  return [...found.values()].sort(compareResolved);
}

/**
 * A single best match, or null when the query is ambiguous.
 *
 * Ambiguity here means "the same symbol on more than one chain", which is the
 * case worth stopping for. Several contracts on *one* chain is resolved by
 * ranking, since the caller has already said which network they mean.
 */
export function pickUnambiguous(matches: ResolvedToken[]): ResolvedToken | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  const chains = new Set(matches.map((m) => m.chainId));
  return chains.size === 1 ? matches[0]! : null;
}

function matches(query: string, symbol: string, contractId: string): boolean {
  const q = query.toLowerCase();
  return symbol.toLowerCase() === q || contractId.toLowerCase() === q;
}

/**
 * Exact on contract, exact-or-prefix on symbol.
 *
 * Deliberately not a substring match on symbol: searching "PE" should not
 * offer to sell you everything containing those letters, and a scam token
 * named to contain a real ticker is a known trick.
 */
function matchWhere(query: string) {
  return {
    OR: [
      { contractId: { equals: query, mode: "insensitive" as const } },
      { symbol: { equals: query, mode: "insensitive" as const } },
    ],
  };
}

const SOURCE_RANK: Record<TokenSource, number> = {
  provider: 0,
  catalogue: 1,
  indexed: 2,
  address: 3,
};

function compareResolved(a: ResolvedToken, b: ResolvedToken): number {
  const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (bySource !== 0) return bySource;

  // Deeper liquidity first. Unknown sorts last rather than as zero — the two
  // are different facts and this is a list someone picks from.
  return (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
