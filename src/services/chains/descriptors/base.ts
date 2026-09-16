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
  // Measured 2.05 s/block against the head, matching OP Stack's 2 s target.
  indexer: { blockTimeSeconds: 2 },
  evm: {
    v4PoolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    v4Quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
    v4UniversalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    id: 8453,
    defaultRpcUrl: "https://mainnet.base.org",
    custody: "erc4337",
    bundler: { provider: "pimlico", slug: "base" },
    wrappedNative: "0x4200000000000000000000000000000000000006",
    dex: {
      name: "Uniswap",
      quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
      v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
      universalRouter: "0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      feeTiers: [500, 3000, 10000],
    },
    indexerFactories: [
      { address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", dexId: "uniswap-v3", protocol: "uniswap-v3" },
      { address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", dexId: "uniswap-v2", protocol: "uniswap-v2" },
      { address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", dexId: "aerodrome-v2", protocol: "aerodrome-v2" },
      { address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", dexId: "aerodrome-slipstream", protocol: "aerodrome-slipstream" },
      { address: "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a", dexId: "aerodrome-slipstream", protocol: "aerodrome-slipstream" },
      { address: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef", dexId: "aerodrome-slipstream", protocol: "aerodrome-slipstream" },
    ],
    // Read back off chain 8453, one router/quoter per factory (a Slipstream
    // router is bound to the factory it was built with). The tokenized stocks
    // are deep on the newest factory at tick spacing 10 — far deeper than the
    // Uniswap V3 pools of the same pair — so that is the route worth having.
    aerodrome: {
      slipstream: [
        {
          factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
          router: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
          quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
          tickSpacings: [1, 50, 100, 200, 2000],
        },
        {
          factory: "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a",
          router: "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D",
          quoter: "0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C",
          tickSpacings: [1, 50, 100, 200, 2000],
        },
        {
          factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
          router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
          quoter: "0x514c8B5f54112481E28028F1166Bd78501089259",
          tickSpacings: [1, 10, 50, 100, 200, 500, 2000],
        },
      ],
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
  indexer: { blockTimeSeconds: 2 },
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
