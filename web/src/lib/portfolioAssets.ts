import { nativeSymbolOf, type ChainInfo } from "../hooks/useChains";

/** One wallet's worth of what the portfolio endpoint returns. */
export interface WalletBalances {
  id: number;
  chain?: string | null;
  balance: number;
  balanceUsd: number;
  balances?: {
    token: string;
    symbol: string;
    balance: number;
    usdValue?: number;
  }[];
}

export interface AssetRow {
  token: string;
  symbol: string;
  balance: number;
  usdValue: number;
  chain?: string | null;
}

/**
 * Combines holdings across wallets into one row per asset.
 *
 * **Keyed by `chainId:symbol`, never by the bare symbol.** USDC on Base and
 * USDC on Solana are different assets that cannot be moved between each other,
 * so summing them produces a balance the user does not have and cannot act on.
 * The backend catalogue was fixed for this once already; the Portfolio page
 * reintroduced it client-side, which is why the rule is written down for the
 * clients and why this is a tested function rather than a loop inside a
 * component.
 *
 * Native symbols come from the chain descriptors, never from a constant — Arc's
 * gas token is USDC, so "EVM means ETH" is wrong for a chain this build already
 * enables.
 */
export function aggregateAssets(wallets: WalletBalances[], chains: ChainInfo[]): AssetRow[] {
  const byChainAndSymbol = new Map<string, AssetRow>();

  for (const wallet of wallets) {
    // A wallet whose per-token balances have not loaded still has a native
    // balance worth showing.
    const balances = wallet.balances ?? [
      {
        token: nativeSymbolOf(wallet.chain, chains),
        symbol: nativeSymbolOf(wallet.chain, chains),
        balance: wallet.balance,
        usdValue: wallet.balanceUsd,
      },
    ];

    for (const balance of balances) {
      const key = `${wallet.chain ?? "unknown"}:${balance.symbol.toUpperCase()}`;
      const existing = byChainAndSymbol.get(key);

      if (existing) {
        existing.balance += balance.balance;
        // `?? 0`, not a skip and not a guess: an unpriced token is still held,
        // so the balance stays and the value reads zero rather than inventing a
        // price or hiding the row.
        existing.usdValue += balance.usdValue ?? 0;
        continue;
      }

      byChainAndSymbol.set(key, {
        token: balance.token,
        symbol: balance.symbol,
        balance: balance.balance,
        usdValue: balance.usdValue ?? 0,
        chain: wallet.chain,
      });
    }
  }

  return [...byChainAndSymbol.values()]
    .filter((asset) => asset.balance > 0)
    .sort((a, b) => b.usdValue - a.usdValue);
}
