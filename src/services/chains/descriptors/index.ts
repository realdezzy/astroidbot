import type { ChainDescriptor, ChainId } from "../../../types/chain.js";
import { STACKS_MAINNET, STACKS_TESTNET } from "./stacks.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "./base.js";
import { CELO_MAINNET } from "./celo.js";
import { SOLANA_MAINNET, SOLANA_DEVNET } from "./solana.js";
import { ETHEREUM_MAINNET } from "./ethereum.js";
import { ROBINHOOD_MAINNET } from "./robinhood.js";
import { ARC_TESTNET } from "./arc.js";

export { defineEvmChain, parseCustomEvmChains } from "./defineEvmChain.js";
export type { EvmChainSpec } from "./defineEvmChain.js";

/**
 * Every chain this build knows how to describe.
 *
 * Being listed here does *not* mean a deployment uses it — `ENABLED_CHAINS`
 * decides that, and bootstrap() registers adapters only for the ids it names.
 * Adding a chain to this catalogue is inert until someone enables it.
 */
export const BUILT_IN_DESCRIPTORS: ChainDescriptor[] = [
  STACKS_MAINNET,
  STACKS_TESTNET,
  ETHEREUM_MAINNET,
  BASE_MAINNET,
  BASE_SEPOLIA,
  CELO_MAINNET,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  ROBINHOOD_MAINNET,
  ARC_TESTNET,
];

export function findDescriptor(chainId: ChainId): ChainDescriptor | undefined {
  return BUILT_IN_DESCRIPTORS.find((d) => d.chainId === chainId);
}

export const DEFAULT_CHAIN_ID: ChainId = "stacks:mainnet";

/**
 * Default network for a family, used only by compatibility paths that still
 * carry a bare `chainFamily` string (older Wallet rows, legacy call sites).
 * New code resolves a ChainId directly.
 */
export const DEFAULT_CHAIN_FOR_FAMILY: Record<string, ChainId> = {
  stacks: "stacks:mainnet",
  evm: "base:mainnet",
  svm: "solana:mainnet",
};

export {
  STACKS_MAINNET,
  STACKS_TESTNET,
  ETHEREUM_MAINNET,
  BASE_MAINNET,
  BASE_SEPOLIA,
  CELO_MAINNET,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  ROBINHOOD_MAINNET,
  ARC_TESTNET,
};

