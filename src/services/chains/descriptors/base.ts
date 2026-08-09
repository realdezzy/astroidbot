import type { ChainDescriptor } from "../../../types/chain.js";

export const BASE_MAINNET: ChainDescriptor = {
  chainId: "base:mainnet",
  family: "evm",
  displayName: "Base",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  stableSymbol: "USDC",
  isTestnet: false,
  tradable: true,
  explorerTxUrl: (txId) => `https://basescan.org/tx/${txId}`,
  explorerAddressUrl: (address) => `https://basescan.org/address/${address}`,
  evm: {
    id: 8453,
    defaultRpcUrl: "https://mainnet.base.org",
    custody: "erc4337",
    bundler: { provider: "pimlico", slug: "base" },
    wrappedNative: "0x4200000000000000000000000000000000000006",
    dex: {
      name: "UniswapV3",
      // QuoterV2. This constant was 39 hex characters for months; viem threw
      // InvalidAddressError inside the per-fee-tier catch, so every mainnet
      // pair reported "no route" with nothing in the logs. EvmChainAdapter
      // validates every address at registration now — see assertValidAddresses.
      quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      feeTiers: [500, 3000, 10000],
    },
    tokens: {
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, name: "Wrapped Ether" },
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USD Coin" },
      DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, name: "Dai Stablecoin" },
    },
  },
};

export const BASE_SEPOLIA: ChainDescriptor = {
  chainId: "base:sepolia",
  family: "evm",
  displayName: "Base Sepolia",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  stableSymbol: "USDC",
  isTestnet: true,
  tradable: true,
  explorerTxUrl: (txId) => `https://sepolia.basescan.org/tx/${txId}`,
  explorerAddressUrl: (address) => `https://sepolia.basescan.org/address/${address}`,
  evm: {
    id: 84532,
    defaultRpcUrl: "https://sepolia.base.org",
    custody: "erc4337",
    bundler: { provider: "pimlico", slug: "base-sepolia" },
    wrappedNative: "0x4200000000000000000000000000000000000006",
    dex: {
      name: "UniswapV3",
      quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
      swapRouter: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
      factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      feeTiers: [500, 3000, 10000],
    },
    tokens: {
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, name: "Wrapped Ether" },
      USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, name: "USD Coin" },
    },
  },
};
