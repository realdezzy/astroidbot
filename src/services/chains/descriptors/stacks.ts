import type { ChainDescriptor } from "../../../types/chain.js";

const explorerBase = "https://explorer.hiro.so";

export const STACKS_MAINNET: ChainDescriptor = {
  chainId: "stacks:mainnet",
  family: "stacks",
  displayName: "Stacks",
  nativeSymbol: "STX",
  nativeDecimals: 6,
  // Stacks' bridged USDC is listed as USDCx by the DEXs that route it.
  stableSymbol: "USDCx",
  isTestnet: false,
  tradable: true,
  explorerTxUrl: (txId) => `${explorerBase}/txid/${txId}?chain=mainnet`,
  explorerAddressUrl: (address) => `${explorerBase}/address/${address}?chain=mainnet`,
  stacks: {
    apiUrl: "https://api.hiro.so",
    // One contract per protocol, not per pair — a Stacks AMM holds every pool
    // in one contract and names the pair in the swap print. Pools are
    // therefore discovered from the events rather than from a factory.
    swapContracts: [
      { contractId: "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01", dexId: "alex" },
      { contractId: "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-core", dexId: "velar" },
    ],
  },
};

export const STACKS_TESTNET: ChainDescriptor = {
  ...STACKS_MAINNET,
  chainId: "stacks:testnet",
  displayName: "Stacks Testnet",
  isTestnet: true,
  // Testnet AMM deployments are not stable enough to pin, and nothing reads
  // testnet discovery data. Absent `stacks` config means "not indexable",
  // which is a normal state rather than a misconfiguration.
  stacks: undefined,
  explorerTxUrl: (txId) => `${explorerBase}/txid/${txId}?chain=testnet`,
  explorerAddressUrl: (address) => `${explorerBase}/address/${address}?chain=testnet`,
};
