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
const ROBINHOOD_SOURCE = "https://docs.robinhood.com/chain/stock-tokens/";
const ONDO_ETH_SOURCE = "https://docs.ondo.finance/";

/**
 * Builds EVM stock entries from `[symbol, token, chainlinkFeed?]` rows.
 *
 * Both audiences of this list are 18-decimal ERC-20s, and the Chainlink equity
 * feeds are 8-decimal. Declared as rows rather than full objects because these
 * chains carry dozens of instruments each and the typed-object form is 90%
 * boilerplate.
 */
function evmStockRows(
  chainId: ChainId,
  issuer: string,
  sourceUrl: string,
  rows: readonly (readonly [string, string, string?])[]
): CuratedStock[] {
  return rows.map(([symbol, contractId, feed]) => ({
    chainId,
    contractId,
    symbol,
    name: symbol,
    decimals: 18,
    underlyingSymbol: symbol,
    issuer,
    ...(feed ? { oracleFeed: feed as `0x${string}`, oracleDecimals: 8 } : {}),
    sourceUrl,
  }));
}

// Robinhood Chain stock tokens + their Chainlink equity feeds. Token addresses
// come from Robinhood's own registry (`api.robinhood.com/rhj/assets`); feeds
// from the reference-data-directory behind Chainlink's Robinhood provider page.
// Only the 33 with a feed are listed; the chain registers ~194 assets.
const ROBINHOOD_STOCKS: CuratedStock[] = evmStockRows("robinhood:mainnet", "Robinhood", ROBINHOOD_SOURCE, [
  ["AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0"],
  ["AMD", "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72"],
  ["AMZN", "0x12f190a9F9d7D37a250758b26824B97CE941bF54", "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C"],
  ["ASML", "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA", "0xB4106147E8cce40b7d46124090d373A71b70f87D"],
  ["BABA", "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984"],
  ["CLSK", "0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3", "0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF"],
  ["COIN", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", "0xA3a468A452940B7D6b69991207B508c609a98Ef2"],
  ["CRCL", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a"],
  ["CRWV", "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", "0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C"],
  ["DELL", "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", "0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b"],
  ["EWY", "0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc", "0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1"],
  ["GME", "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", "0x27C71df6A64fB476468EdF256CF72c038baB5B67"],
  ["GOOGL", "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", "0xF6f373a037c30F0e5010d854385cA89185AE638b"],
  ["INTC", "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", "0x3f390C5C24628Ac7C489515402235FeAD71D1913"],
  ["IONQ", "0x558378E000D634A36593E338eBacdd6207640EfE", "0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb"],
  ["META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "0x7C38C00C30BEe9378381E7B6135d7283356D71b1"],
  ["MSFT", "0xe93237C50D904957Cf27E7B1133b510C669c2e74", "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E"],
  ["MSTR", "0xec262a75e413fAfD0dF80480274532C79D42da09", "0x396118bdFB181e6240E74D243F266B061c0edc3D"],
  ["MU", "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596"],
  ["NBIS", "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931", "0xE1D87B116Ba0fe898998f1D140339D1fA1E09705"],
  ["NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"],
  ["ORCL", "0xb0992820E760d836549ba69BC7598b4af75dEE03", "0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844"],
  ["PLTR", "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c"],
  ["QQQ", "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", "0x80901d846d5D7B030F26B480776EE3b29374C2ae"],
  ["RGTI", "0x284358abc07F9359f19f4b5b4aC91901Be2597Ba", "0x2A045cF1C49c61c166C036d2f06FA2D2d984f765"],
  ["RKLB", "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2", "0x045477BF65Aef6f4F2386ad0164579e48381CC74"],
  ["SLV", "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", "0x209b73908e92Ae021826eD79609845451Ecba2ce"],
  ["SNDK", "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", "0xfb133Fa4B7b385802B693a293606682Df47109A3"],
  ["SPCX", "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb"],
  ["SPY", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", "0x319724394D3A0e3669269846abE664Cd621f9f6A"],
  ["TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "0x4A1166a659A55625345e9515b32adECea5547C38"],
  ["TSM", "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", "0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F"],
  ["USO", "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c"],
]);

// Ondo "on" tokens on Ethereum. Addresses from CoinGecko's platform data and
// cross-checked against Ondo's OpenAPI example (AAPLon matched exactly);
// Chainlink equity feeds only exist for a few of these today.
const ONDO_ETHEREUM_STOCKS: CuratedStock[] = evmStockRows("ethereum:mainnet", "Ondo", ONDO_ETH_SOURCE, [
  ["TSLAon", "0xf6b1117ec07684d3958cad8beb1b302bfd21103f", "0x737401E0D1299D8A85b653Fd52823501f4FE0be0"],
  ["SPYon", "0xfedc5f4a6c38211c1338aa411018dfaf26612c08", "0x6EcC1b902dB35eAFE95332443802774Fd1D72576"],
  ["QQQon", "0x0e397938c1aa0680954093495b70a9f5e2249aba", "0xE5DF423251c67D85B2D70787Af76069d96BC4D4C"],
  ["NVDAon", "0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee"],
  ["AAPLon", "0x14c3abf95cb9c93a8b82c1cdcb76d72cb87b2d4c"],
  ["MSFTon", "0xb812837b81a3a6b81d7cd74cfb19a7f2784555e5"],
  ["GOOGLon", "0xba47214edd2bb43099611b208f75e4b42fdcfedc"],
  ["AMZNon", "0xbb8774fb97436d23d74c1b882e8e9a69322cfd31"],
  ["METAon", "0x59644165402b611b350645555b50afb581c71eb2"],
  ["CRCLon", "0x3632dea96a953c11dac2f00b4a05a32cd1063fae"],
  ["HOODon", "0x998f02a9e343ef6e3e6f28700d5a20f839fd74e6"],
  ["PLTRon", "0x0c666485b02f7a87d21add7aeb9f5e64975aa490"],
  ["COINon", "0xf042cfa86cf1d598a75bdb55c3507a1f39f9493b"],
]);

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
  ...ROBINHOOD_STOCKS,
  ...ONDO_ETHEREUM_STOCKS,
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
