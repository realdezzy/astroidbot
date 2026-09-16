import type { ChainId } from "../../types/chain.js";

/**
 * Tokenized equities this deployment is willing to list, keyed by chain.
 *
 * A curated allowlist, not a discovery rule. The catalogue's other source is
 * indexer promotion, which lists *everything* the indexer saw trade — right for
 * crypto, wrong for stocks, where anyone can deploy an ERC-20 called `AAPL`.
 * Symbols are not evidence; these addresses are.
 *
 * Each entry records where it came from (`sourceUrl`) and, where the issuer
 * publishes one, its Chainlink reference feed (`oracleFeed`). The list is
 * seeded from those official sources and verified on-chain rather than invented
 * here — see `Docs/architecture/equities.md` for the per-chain sourcing plan.
 *
 * Base — Coinbase Tokenized Stocks, B20 standard. Token addresses and Chainlink
 * feeds both come from Base's own documentation
 * (`docs.base.org/base-chain/specs/reference/b20/tokenized-stocks-on-base`) and
 * the Chainlink Coinbase feed page. Verified on Base mainnet: `decimals()` is 8
 * on every token and reads succeed even though `getCode` returns the precompile
 * marker `0xef` (B20 tokens are native precompiles, so there is no per-asset
 * bytecode). Feeds return 8 decimals and publish a total-return value
 * (`equity price × multiplier`), so they are the token's primary-market price.
 *
 * Deliberately absent: `COINc`, `CRCLc`, `INTCc`. They are registered and their
 * `name`/`symbol` and feeds answer, but they were never minted (`totalSupply`
 * is 0) — the docs warn about exactly this. Only a supply read tells them apart
 * from a live token.
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
  /** Who issues the tokenized instrument. */
  issuer: string;
  /** Chainlink aggregator proxy, read via `latestRoundData()`. */
  oracleFeed?: `0x${string}`;
  /** Decimals the feed's `answer` is scaled by. 8 for Chainlink equity feeds. */
  oracleDecimals?: number;
  /** The official page this entry was taken from. */
  sourceUrl: string;
}

const BASE_SOURCE =
  "https://docs.base.org/base-chain/specs/reference/b20/tokenized-stocks-on-base";
const ONDO_SOURCE = "https://ondo.finance/ondo-stocks";

export const CURATED_STOCKS: readonly CuratedStock[] = [
  {
    chainId: "base:mainnet",
    contractId: "0xb20000000000000000000078ee7ce2fe4908108c",
    symbol: "NVDAc",
    name: "NVIDIA Corporation",
    decimals: 8,
    underlyingSymbol: "NVDA",
    issuer: "Coinbase",
    oracleFeed: "0x04689a41629776563E6822F76f2e57D148d28513",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000c2e324d24d7eecd1fb",
    symbol: "AAPLc",
    name: "Apple Inc.",
    decimals: 8,
    underlyingSymbol: "AAPL",
    issuer: "Coinbase",
    oracleFeed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000008bc8786b856e61707c",
    symbol: "METAc",
    name: "Meta Platforms, Inc.",
    decimals: 8,
    underlyingSymbol: "META",
    issuer: "Coinbase",
    oracleFeed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000002d0ba3164cc74f58b7",
    symbol: "GOOGLc",
    name: "Alphabet Inc.",
    decimals: 8,
    underlyingSymbol: "GOOGL",
    issuer: "Coinbase",
    oracleFeed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000d9192b6b456483c2e8",
    symbol: "AMZNc",
    name: "Amazon.com, Inc.",
    decimals: 8,
    underlyingSymbol: "AMZN",
    issuer: "Coinbase",
    oracleFeed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000ab99cfa739e253872b",
    symbol: "MSFTc",
    name: "Microsoft Corporation",
    decimals: 8,
    underlyingSymbol: "MSFT",
    issuer: "Coinbase",
    oracleFeed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000004884b426556b92883d",
    symbol: "MSTRc",
    name: "Strategy Inc.",
    decimals: 8,
    underlyingSymbol: "MSTR",
    issuer: "Coinbase",
    oracleFeed: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb200000000000000000000397293cb8cda9a10c5",
    symbol: "SNDKc",
    name: "SanDisk Corporation",
    decimals: 8,
    underlyingSymbol: "SNDK",
    issuer: "Coinbase",
    oracleFeed: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000007b9fcbd005511acbd5",
    symbol: "SPCXc",
    name: "SpaceX",
    decimals: 8,
    underlyingSymbol: "SPCX",
    issuer: "Coinbase",
    oracleFeed: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },
  {
    chainId: "base:mainnet",
    contractId: "0xb2000000000000000000001e800a7f5189430cd0",
    symbol: "TSLAc",
    name: "Tesla, Inc.",
    decimals: 8,
    underlyingSymbol: "TSLA",
    issuer: "Coinbase",
    oracleFeed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    oracleDecimals: 8,
    sourceUrl: BASE_SOURCE,
  },

  // Solana — Ondo Stocks (Ondo Global Markets), SPL tokens minted under
  // Token-2022. Mints are base58 and therefore case-sensitive; never lowercase
  // them. Verified on Solana mainnet via Jupiter's token API (tagged
  // `ondo`+`verified`) and a live Jupiter route for the majors.
  //
  // The Token-2022 extensions are benign in practice: `transferHook.programId`
  // is null (no eligibility hook is installed), `defaultAccountState` is
  // `initialized` (new token accounts are not frozen), and `pausableConfig` is
  // unpaused. KYC gates mint/redeem at the issuer, not secondary DEX trading.
  //
  // These are total-return trackers: `scaledUiAmountConfig.multiplier` grows
  // with dividends, so a raw balance is not the equity value. The DEX/Jupiter
  // price is the market price actually paid, which is what a trade needs; a
  // portfolio *balance* has to apply the multiplier.
  //
  // No `oracleFeed`: that field is the EVM Chainlink aggregator. Solana pricing
  // comes from the DEX route (Jupiter) and the internal swap index.
  {
    chainId: "solana:mainnet",
    contractId: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
    symbol: "NVDAon",
    name: "NVIDIA (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "NVDA",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo",
    symbol: "AAPLon",
    name: "Apple (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "AAPL",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo",
    symbol: "TSLAon",
    name: "Tesla (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "TSLA",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "bbahNA5vT9WJeYft8tALrH1LXWffjwqVoUbqYa1ondo",
    symbol: "GOOGLon",
    name: "Alphabet Class A (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "GOOGL",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "FRmH6iRkMr33DLG6zVLR7EM4LojBFAuq6NtFzG6ondo",
    symbol: "MSFTon",
    name: "Microsoft (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "MSFT",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "14Tqdo8V1FhzKsE3W2pFsZCzYPQxxupXRcqw9jv6ondo",
    symbol: "AMZNon",
    name: "Amazon (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "AMZN",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "fDxs5y12E7x7jBwCKBXGqt71uJmCWsAQ3Srkte6ondo",
    symbol: "METAon",
    name: "Meta Platforms (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "META",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo",
    symbol: "SPYon",
    name: "SPDR S&P 500 ETF (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "SPY",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo",
    symbol: "QQQon",
    name: "Invesco QQQ (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "QQQ",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "6xHEyem9hmkGtVq6XGCiQUGpPsHBaoYuYdFNZa5ondo",
    symbol: "CRCLon",
    name: "Circle Internet Group (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "CRCL",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "BVdXGvmgi6A9oAiwWvBvP76fyTqcCNRJMM7zMN6ondo",
    symbol: "HOODon",
    name: "Robinhood Markets (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "HOOD",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "HfsnTS5qtdStwec9DfBrunRqnAMYMMz1kjv9Hu9ondo",
    symbol: "PLTRon",
    name: "Palantir Technologies (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "PLTR",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
  {
    chainId: "solana:mainnet",
    contractId: "5u6KDiNJXxX4rGMfYT4BApZQC5CuDNrG6MHkwp1ondo",
    symbol: "COINon",
    name: "Coinbase (Ondo Tokenized)",
    decimals: 9,
    underlyingSymbol: "COIN",
    issuer: "Ondo",
    sourceUrl: ONDO_SOURCE,
  },
] as const;

/** The curated stocks worth listing on one chain. */
export function stocksForChain(chainId: ChainId): CuratedStock[] {
  return CURATED_STOCKS.filter((s) => s.chainId === chainId);
}

/** The curated instrument for one token, or undefined if it is not one. */
export function stockByContract(chainId: ChainId, contractId: string): CuratedStock | undefined {
  // EVM addresses are case-insensitive; Solana mints are base58 and are not.
  const evm = contractId.startsWith("0x");
  return CURATED_STOCKS.find(
    (s) =>
      s.chainId === chainId &&
      (evm ? s.contractId.toLowerCase() === contractId.toLowerCase() : s.contractId === contractId)
  );
}
