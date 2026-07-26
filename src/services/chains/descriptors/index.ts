import type { ChainDescriptor, ChainId } from "../../../types/chain.js";
import { STACKS_MAINNET, STACKS_TESTNET } from "./stacks.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "./base.js";
import { CELO_MAINNET } from "./celo.js";
import { SOLANA_MAINNET, SOLANA_DEVNET } from "./solana.js";

export { defineEvmChain, parseCustomEvmChains } from "./defineEvmChain.js";
export type { EvmChainSpec } from "./defineEvmChain.js";

/**
 * Every chain this build knows how to describe.
 *
 * Being listed here does *not* mean a deployment uses it — `ENABLED_CHAINS`
 * decides that, and bootstrap() registers adapters only for the ids it names.
 * Adding a chain to this catalogue is inert until someone enables it.
 *
 * To add a chain: write a descriptor file, export it here, done. If it's an
 * EVM chain whose parameters aren't settled enough to hardcode, skip this file
 * entirely and use CUSTOM_EVM_CHAINS (see defineEvmChain.ts) — that path
 * covers networks like ARC and Robinhood Chain whose router deployments we
 * can't verify from here.
 */
export const BUILT_IN_DESCRIPTORS: ChainDescriptor[] = [
  STACKS_MAINNET,
  STACKS_TESTNET,
  BASE_MAINNET,
  BASE_SEPOLIA,
  CELO_MAINNET,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
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
  BASE_MAINNET,
  BASE_SEPOLIA,
  CELO_MAINNET,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
};
