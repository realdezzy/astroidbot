import { describe, it, expect } from "vitest";
import { aggregateAssets } from "./portfolioAssets";
import type { ChainInfo } from "../hooks/useChains";

/**
 * Combining holdings across wallets, keyed by `chainId:symbol`.
 *
 * Keyed by the bare symbol, this summed USDC on Base with USDC on Solana into
 * one row — a holding the user does not have and cannot act on, since neither
 * half can be moved to the other. The backend catalogue was fixed for exactly
 * this in `10db259`; the Portfolio page then reintroduced it client-side, which
 * is why the rule is written down for the clients too.
 *
 * The logic lived inline in Portfolio.tsx, where nothing could reach it. It is
 * a pure reduction over wallets, so it lives here now and this file is what
 * stops the regression happening a third time.
 */

const chains: ChainInfo[] = [
  { chainId: "base:mainnet", displayName: "Base", nativeSymbol: "ETH", tradable: true } as ChainInfo,
  { chainId: "solana:mainnet", displayName: "Solana", nativeSymbol: "SOL", tradable: true } as ChainInfo,
  { chainId: "arc:mainnet", displayName: "Arc", nativeSymbol: "USDC", tradable: true } as ChainInfo,
];

describe("aggregateAssets", () => {
  it("keeps same-ticker tokens on different chains apart", () => {
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xbase", symbol: "USDC", balance: 100, usdValue: 100 }],
        },
        {
          id: 2, chain: "solana:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "EPjF", symbol: "USDC", balance: 250, usdValue: 250 }],
        },
      ],
      chains
    );

    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.balance).sort((x, y) => x - y)).toEqual([100, 250]);
  });

  it("still combines the same token held in two wallets on one chain", () => {
    // The other half of the rule: splitting by wallet would be just as wrong as
    // merging by symbol.
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xbase", symbol: "USDC", balance: 100, usdValue: 100 }],
        },
        {
          id: 2, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xbase", symbol: "USDC", balance: 50, usdValue: 50 }],
        },
      ],
      chains
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]!.balance).toBe(150);
    expect(assets[0]!.usdValue).toBe(150);
  });

  it("treats a symbol case difference as the same asset", () => {
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xbase", symbol: "usdc", balance: 10, usdValue: 10 }],
        },
        {
          id: 2, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xbase", symbol: "USDC", balance: 5, usdValue: 5 }],
        },
      ],
      chains
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]!.balance).toBe(15);
  });

  // An unpriced token is held but has no valuation. The row keeps its balance
  // and carries the flag so the page can show a dash rather than "$0.00".
  it("flags a row unpriced when any wallet's part of it could not be priced", () => {
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xmyst", symbol: "MYST", balance: 1000, usdValue: 0, unpriced: true }],
        },
        {
          id: 2, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [
            { token: "0xmyst", symbol: "MYST", balance: 500, usdValue: 0, unpriced: true },
            { token: "0xbase", symbol: "USDC", balance: 5, usdValue: 5 },
          ],
        },
      ],
      chains
    );

    expect(assets.find((a) => a.symbol === "MYST")).toMatchObject({ balance: 1500, unpriced: true });
    expect(assets.find((a) => a.symbol === "USDC")).not.toHaveProperty("unpriced");
  });

  it("falls back to the chain's native symbol for a wallet with no balance list", () => {
    // A wallet whose per-token balances have not loaded still has a native
    // balance worth showing, and the symbol has to come from the descriptor —
    // hardcoding one is the bug the chain-aware client rules exist to stop.
    const assets = aggregateAssets(
      [{ id: 1, chain: "solana:mainnet", balance: 3, balanceUsd: 600 }],
      chains
    );

    expect(assets).toEqual([
      expect.objectContaining({ symbol: "SOL", balance: 3, usdValue: 600, chain: "solana:mainnet" }),
    ]);
  });

  it("uses Arc's USDC rather than assuming a native symbol of ETH", () => {
    // Arc's gas token is USDC. A client that assumed ETH for anything EVM would
    // label this row wrong.
    const assets = aggregateAssets(
      [{ id: 1, chain: "arc:mainnet", balance: 12, balanceUsd: 12 }],
      chains
    );

    expect(assets[0]!.symbol).toBe("USDC");
  });

  it("drops zero and negative balances", () => {
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [
            { token: "0xa", symbol: "AAA", balance: 0, usdValue: 0 },
            { token: "0xb", symbol: "BBB", balance: 2, usdValue: 4 },
          ],
        },
      ],
      chains
    );

    expect(assets.map((a) => a.symbol)).toEqual(["BBB"]);
  });

  it("sorts by USD value, highest first", () => {
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [
            { token: "0xa", symbol: "SMALL", balance: 1, usdValue: 5 },
            { token: "0xb", symbol: "BIG", balance: 1, usdValue: 500 },
            { token: "0xc", symbol: "MID", balance: 1, usdValue: 50 },
          ],
        },
      ],
      chains
    );

    expect(assets.map((a) => a.symbol)).toEqual(["BIG", "MID", "SMALL"]);
  });

  it("treats a missing usdValue as zero rather than dropping the holding", () => {
    // An unpriced token is still held. Dropping the row would hide it; inventing
    // a price would misreport the portfolio. Zero with the balance intact is the
    // same choice the backend makes.
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xa", symbol: "NEW", balance: 7, usdValue: undefined }],
        },
      ],
      chains
    );

    expect(assets).toEqual([expect.objectContaining({ symbol: "NEW", balance: 7, usdValue: 0 })]);
  });

  it("does not merge wallets whose chain is unknown with a real chain", () => {
    const assets = aggregateAssets(
      [
        {
          id: 1, chain: null, balance: 0, balanceUsd: 0,
          balances: [{ token: "0xa", symbol: "USDC", balance: 1, usdValue: 1 }],
        },
        {
          id: 2, chain: "base:mainnet", balance: 0, balanceUsd: 0,
          balances: [{ token: "0xa", symbol: "USDC", balance: 1, usdValue: 1 }],
        },
      ],
      chains
    );

    expect(assets).toHaveLength(2);
  });
});
