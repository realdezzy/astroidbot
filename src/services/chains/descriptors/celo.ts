import type { ChainDescriptor } from "../../../types/chain.js";

/**
 * Celo. Uniswap deployed V3 to Celo, so it reuses UniswapV3Provider unchanged —
 * only the addresses below differ from Base. That reuse is the point of the
 * descriptor split: this file is the entire cost of adding the chain.
 *
 * Addresses are Uniswap's official Celo deployment. Verify against
 * https://docs.uniswap.org/contracts/v3/reference/deployments before enabling
 * on mainnet with real funds — a wrong router address fails closed (no route)
 * rather than losing funds, but it fails silently.
 */
export const CELO_MAINNET: ChainDescriptor = {
  chainId: "celo:mainnet",
  family: "evm",
  displayName: "Celo",
  nativeSymbol: "CELO",
  nativeDecimals: 18,
  // cUSD is Celo's native-issued dollar and the deepest stable pair on-chain.
  stableSymbol: "cUSD",
  isTestnet: false,
  tradable: true,
  explorerTxUrl: (txId) => `https://celoscan.io/tx/${txId}`,
  explorerAddressUrl: (address) => `https://celoscan.io/address/${address}`,
  evm: {
    id: 42220,
    defaultRpcUrl: "https://forno.celo.org",
    // Pimlico does serve Celo, but EOA custody is the safer default for a
    // chain we have not exercised in production: it removes the bundler as a
    // dependency and a failure mode. Flip to "erc4337" once verified.
    custody: "eoa",
    // CELO is itself an ERC-20, so the "wrapped native" is the CELO contract.
    wrappedNative: "0x471EcE3750Da237f93B8E339c536989b8978a438",
    dex: {
      name: "UniswapV3",
      quoter: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8",
      swapRouter: "0x5615CDAb10dc425a742d643d949a7F474C01abc4",
      feeTiers: [500, 3000, 10000],
    },
    tokens: {
      CELO: { address: "0x471EcE3750Da237f93B8E339c536989b8978a438", decimals: 18, name: "Celo" },
      cUSD: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18, name: "Celo Dollar" },
      cEUR: { address: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73", decimals: 18, name: "Celo Euro" },
      USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, name: "USD Coin" },
    },
  },
};
