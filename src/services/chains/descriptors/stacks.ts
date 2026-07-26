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
};

export const STACKS_TESTNET: ChainDescriptor = {
  ...STACKS_MAINNET,
  chainId: "stacks:testnet",
  displayName: "Stacks Testnet",
  isTestnet: true,
  explorerTxUrl: (txId) => `${explorerBase}/txid/${txId}?chain=testnet`,
  explorerAddressUrl: (address) => `${explorerBase}/address/${address}?chain=testnet`,
};
