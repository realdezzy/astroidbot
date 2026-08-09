import { defineEvmChain } from "./defineEvmChain.js";

/**
 * Arc — Circle's stablecoin L1, EVM-compatible with USDC as the gas token.
 *
 * **There is no Arc mainnet yet.** Arc is in public testnet, and Circle's docs
 * state plainly that "mainnet endpoints and parameters are published separately
 * when available". So this file describes the testnet and nothing else. An
 * `arc:mainnet` entry with invented parameters would be worse than no entry at
 * all: `ENABLED_CHAINS` would accept it, wallets would be generated against a
 * chain id that doesn't exist, and the failure would surface as unexplained
 * broadcast errors rather than as "that chain isn't supported yet".
 *
 * No `dex` block, so `tradable` derives to false — Arc is listable (wallets,
 * balances, discovery) but DEXRegistry will never offer it a quote. When a
 * router ships, adding it here is the entire change.
 *
 * Gas is USDC, but the EVM's native unit is still 18-decimal wei; Arc scales
 * USDC up to 18 decimals for gas accounting, so nativeDecimals stays 18.
 */
export const ARC_TESTNET = defineEvmChain({
  chainId: "arc:testnet",
  displayName: "Arc Testnet",
  id: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  nativeSymbol: "USDC",
  stableSymbol: "USDC",
  isTestnet: true,
  explorerBaseUrl: "https://testnet.arcscan.app",
  custody: "eoa",
});
