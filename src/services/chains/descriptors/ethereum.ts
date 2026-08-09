import type { ChainDescriptor } from "../../../types/chain.js";

/**
 * Ethereum mainnet.
 *
 * Addresses are Uniswap's canonical V3 deployment — the same ones every other
 * V3 chain's are forked from. Written as a literal descriptor rather than
 * through defineEvmChain only because the curated token list is longer than
 * the helper's shape reads well for.
 *
 * Custody is EOA deliberately. Pimlico serves mainnet, but mainnet gas is the
 * one place where a bundler misconfiguration is expensive, and EOA removes the
 * bundler as a dependency. Flip to "erc4337" once exercised with real funds.
 */
export const ETHEREUM_MAINNET: ChainDescriptor = {
  chainId: "ethereum:mainnet",
  family: "evm",
  displayName: "Ethereum",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  stableSymbol: "USDC",
  isTestnet: false,
  tradable: true,
  explorerTxUrl: (txId) => `https://etherscan.io/tx/${txId}`,
  explorerAddressUrl: (address) => `https://etherscan.io/address/${address}`,
  evm: {
    id: 1,
    // publicnode over llamarpc: the latter was returning Cloudflare 521s when
    // this was written, and a dead default RPC makes the chain look broken
    // rather than misconfigured.
    defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    custody: "eoa",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    dex: {
      name: "UniswapV3",
      quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      swapRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      feeTiers: [100, 500, 3000, 10000],
    },
    tokens: {
      WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, name: "Wrapped Ether" },
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, name: "USD Coin" },
      USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, name: "Tether USD" },
      DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, name: "Dai Stablecoin" },
      WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, name: "Wrapped BTC" },
    },
  },
};
