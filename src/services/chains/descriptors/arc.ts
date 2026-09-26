import { defineEvmChain } from "./defineEvmChain.js";

/**
 * Arc — Circle's stablecoin L1, EVM-compatible with USDC as the gas token.
 *
 * Gas is USDC, but the EVM's native unit is still 18-decimal wei; Arc scales
 * USDC up to 18 decimals for gas accounting, so nativeDecimals stays 18. The
 * *ERC-20 view* of that same balance has 6 decimals — see `nativeErc20` below,
 * which is the one thing about this chain that does not follow the pattern
 * every other EVM chain here established.
 */

/**
 * Arc mainnet, chain 5042.
 *
 * Every address here was read back off chain 5042 rather than copied from a
 * listing, and on this chain that is not a formality. Uniswap's canonical v3
 * factory address (0x1F98…F984) holds a contract on Arc that is *not* the v3
 * factory, and Arc's v2 router is byte-identical to Robinhood's v3 factory —
 * so an address that looks familiar from another chain is exactly the kind
 * that verifies fine by eye and fails closed with "no route" in production.
 * What was checked: QuoterV2.factory() and SwapRouter02.factory() both return
 * the v3 factory below; v4Quoter.poolManager() and UniversalRouter.
 * poolManager() both return the PoolManager below; v2Router.factory() returns
 * the v2 factory below, which reports 764 pairs.
 *
 * All three protocol versions carry real flow — over one 84-minute window the
 * chain created 26 v3 pools, initialised 215 v4 pools and added 4 v2 pairs —
 * so all three are indexed, and v3 is what `dex` routes through.
 *
 * Block time is 0.507 s, measured across 50,000 blocks. It is stated because
 * the indexer's reorg margin is counted in blocks: without it the global
 * 12-block confirmation depth would be six seconds of protection here.
 *
 * One deployment note: Arc's public RPC caps `eth_getLogs` at under 10,000
 * blocks per request and rate-limits with "rate limit exceeded". Both are
 * already handled — the default chunk is 2,000 blocks, and that message is
 * classified as transient (back off) rather than oversized (subdivide).
 */
export const ARC_MAINNET = defineEvmChain({
  chainId: "arc:mainnet",
  displayName: "Arc",
  id: 5042,
  rpcUrl: "https://rpc.mainnet.arc.io",
  nativeSymbol: "USDC",
  stableSymbol: "USDC",
  explorerBaseUrl: "https://explorer.arc.io",
  // No bundler serves chain 5042, so EOA is the only workable custody here.
  custody: "eoa",
  indexer: { blockTimeSeconds: 0.507 },
  /**
   * USDC is the gas token *and* the quote asset of essentially every pool, and
   * this address is not a wrapper — it is the native balance surfaced as an
   * ERC-20. Checked on eight live accounts: `balanceOf` equalled
   * `eth_getBalance / 1e12` to the unit on every one. Hence `nativeErc20` and
   * not `wrappedNative`: there is nothing to deposit into (SwapRouter02's
   * WETH9() points at a 53-byte stub), and resolving the native symbol at the
   * descriptor's 18 decimals against a 6-decimal token would ask the router
   * to spend 10^12 times the intended amount.
   */
  nativeErc20: { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
  dex: {
    name: "UniswapV3",
    quoter: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
    swapRouter: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
    factory: "0xf0db7b58379503491d857db50ac9ece64c653918",
    v2Router: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    v2Factory: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
    universalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
    feeTiers: [100, 500, 3000, 10000],
  },
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  v4UniversalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
  // Deployment blocks found by bisecting eth_getCode; without them a first
  // pass would walk back to genesis over a 20-million-block gap.
  indexerFactories: [
    { address: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba", dexId: "uniswap-v2", protocol: "uniswap-v2", deploymentBlock: 1_948_011n },
    { address: "0xf0db7b58379503491d857db50ac9ece64c653918", dexId: "uniswap-v3", protocol: "uniswap-v3", deploymentBlock: 1_948_019n },
    { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", dexId: "uniswap-v4", protocol: "uniswap-v4", deploymentBlock: 1_948_056n },
  ],
  tokens: {
    // Verified on chain 5042: symbol() "USDC", decimals() 6, totalSupply
    // 618,250,388.657619. Listed as well as declared `nativeErc20` because
    // routing needs an address for the symbol; balance reading knows to count
    // it once, not twice.
    USDC: {
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
      name: "USDC",
    },
  },
});

/**
 * Arc testnet.
 *
 * No `dex` block, so `tradable` derives to false — the testnet is listable
 * (wallets, balances, discovery) but DEXRegistry will never offer it a quote.
 */
export const ARC_TESTNET = defineEvmChain({
  chainId: "arc:testnet",
  displayName: "Arc Testnet",
  id: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  nativeSymbol: "USDC",
  stableSymbol: "USDC",
  isTestnet: true,
  explorerBaseUrl: "https://testnet.arcscan.app",
  custody: "eoa",
});
