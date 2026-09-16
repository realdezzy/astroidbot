import type { ChainId } from "../../types/chain.js";

/**
 * Tokenized equities this deployment is willing to list.
 *
 * A curated allowlist, not a discovery rule. The token catalogue's other source
 * is indexer promotion, which lists *everything* the indexer saw trade — a rule
 * that is right for crypto and wrong for stocks, where anyone can deploy an
 * ERC-20 called `AAPL`. Symbols are not evidence; these addresses are.
 *
 * Every entry here was read back from the issuer's own documentation and
 * confirmed on-chain (decimals, totalSupply, and a live oracle feed). Adding a
 * token means verifying it the same way, never copying a ticker.
 *
 * Base — Coinbase Tokenized Stocks, issued under the B20 standard. Verified on
 * Base mainnet: `decimals()` is 8 on every token, reads succeed even though
 * `eth_getCode` returns the precompile marker `0xef` (B20 tokens are native
 * precompiles, so there is no per-asset bytecode to verify). Addresses are
 * keyed by `chainId` because an EVM contract address on one chain says nothing
 * about another. `underlyingSymbol` is the off-chain ticker, for display.
 *
 * Deliberately absent: `COINc`, `CRCLc`, `INTCc`. They are registered and their
 * `name`/`symbol` and oracle feeds answer, but they were never minted
 * (`totalSupply` is 0) — the docs warn about exactly this. Only a supply read
 * tells them apart from a live token.
 */
export interface CuratedStock {
  chainId: ChainId;
  /** EVM contract address. Stored lowercased, matching how pools are keyed. */
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  /** The underlying equity's ticker when it differs from the token symbol. */
  underlyingSymbol?: string;
}

export const CURATED_STOCKS: readonly CuratedStock[] = [
  {
    chainId: "base:mainnet",
    contractId: "0xb20000000000000000000078ee7ce2fe4908108c",
    symbol: "NVDAc",
    name: "NVIDIA Corporation",
    decimals: 8,
    underlyingSymbol: "NVDA",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000c2e324d24d7eecd1fb",
    symbol: "AAPLc",
    name: "Apple Inc.",
    decimals: 8,
    underlyingSymbol: "AAPL",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000008bc8786b856e61707c",
    symbol: "METAc",
    name: "Meta Platforms, Inc.",
    decimals: 8,
    underlyingSymbol: "META",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000002d0ba3164cc74f58b7",
    symbol: "GOOGLc",
    name: "Alphabet Inc.",
    decimals: 8,
    underlyingSymbol: "GOOGL",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000d9192b6b456483c2e8",
    symbol: "AMZNc",
    name: "Amazon.com, Inc.",
    decimals: 8,
    underlyingSymbol: "AMZN",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000ab99cfa739e253872b",
    symbol: "MSFTc",
    name: "Microsoft Corporation",
    decimals: 8,
    underlyingSymbol: "MSFT",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000004884b426556b92883d",
    symbol: "MSTRc",
    name: "Strategy Inc.",
    decimals: 8,
    underlyingSymbol: "MSTR",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000397293cb8cda9a10c5",
    symbol: "SNDKc",
    name: "SanDisk Corporation",
    decimals: 8,
    underlyingSymbol: "SNDK",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000007b9fcbd005511acbd5",
    symbol: "SPCXc",
    name: "SpaceX",
    decimals: 8,
    underlyingSymbol: "SPCX",
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000001e800a7f5189430cd0",
    symbol: "TSLAc",
    name: "Tesla, Inc.",
    decimals: 8,
    underlyingSymbol: "TSLA",
  },
] as const;

/** The curated stocks worth listing on one chain. */
export function stocksForChain(chainId: ChainId): CuratedStock[] {
  return CURATED_STOCKS.filter((s) => s.chainId === chainId);
}
