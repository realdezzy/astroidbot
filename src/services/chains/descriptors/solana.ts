import type { ChainDescriptor } from "../../../types/chain.js";

export const SOLANA_MAINNET: ChainDescriptor = {
  chainId: "solana:mainnet",
  family: "svm",
  displayName: "Solana",
  nativeSymbol: "SOL",
  nativeDecimals: 9,
  stableSymbol: "USDC",
  isTestnet: false,
  tradable: true,
  explorerTxUrl: (txId) => `https://solscan.io/tx/${txId}`,
  explorerAddressUrl: (address) => `https://solscan.io/account/${address}`,
  svm: {
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
    // Jupiter's Swap API. `quote-api.jup.ag/v6` was here and is *gone* — the
    // host no longer resolves, so every quote failed and Solana registered,
    // listed tokens, and then reported "no route" on every pair. The free tier
    // is lite-api; api.jup.ag is the same surface behind an API key and is
    // used instead when JUPITER_API_KEY is set.
    jupiterApiUrl: "https://lite-api.jup.ag/swap/v1",
    // Solana drops transactions that don't outbid the fee market during
    // congestion. A small default priority fee costs a fraction of a cent and
    // avoids silent non-inclusion.
    priorityFeeMicroLamports: 20_000,
  },
};

export const SOLANA_DEVNET: ChainDescriptor = {
  ...SOLANA_MAINNET,
  chainId: "solana:devnet",
  displayName: "Solana Devnet",
  isTestnet: true,
  // Jupiter does not serve devnet, so devnet is wallets/balances only.
  tradable: false,
  explorerTxUrl: (txId) => `https://solscan.io/tx/${txId}?cluster=devnet`,
  explorerAddressUrl: (address) => `https://solscan.io/account/${address}?cluster=devnet`,
  svm: {
    defaultRpcUrl: "https://api.devnet.solana.com",
    priorityFeeMicroLamports: 20_000,
  },
};
