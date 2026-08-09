import { defineEvmChain } from "./defineEvmChain.js";

/**
 * Robinhood Chain — an Arbitrum Orbit L2 for tokenized equities and RWAs.
 *
 * Every address below was read back off the chain itself rather than copied
 * from a listing: QuoterV2.factory() and the factory reported by a live pool
 * both return 0x1f7d…2efa, and SwapRouter02.WETH9() returns the WETH address
 * used here. A wrong router on an EVM chain fails closed ("no route") with
 * nothing in the logs, so verifying the wiring is cheaper than debugging it.
 *
 * The chain's dollar is **USDG** (Paxos' Global Dollar, 6 decimals) — what you
 * receive when you bridge USDC in, and what every pool here quotes against.
 *
 * This said `rUSDC` for a while, and that was worse than a wrong address
 * because it was a *real* token: 0x05fB…CBa3 exists, answers symbol() with
 * "rUSDC", and has 18 decimals — so it verified fine in isolation. It simply
 * has no pool at any fee tier, which meant every price on this chain resolved
 * to 0 and every limit order sat until forceAfter fired it. Checking that a
 * contract exists is not the same as checking it is the one being traded; the
 * factory's PoolCreated logs are what settle that.
 */
export const ROBINHOOD_MAINNET = defineEvmChain({
  chainId: "robinhood:mainnet",
  displayName: "Robinhood",
  id: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  nativeSymbol: "ETH",
  stableSymbol: "USDG",
  explorerBaseUrl: "https://robinhoodchain.blockscout.com",
  // No bundler serves chain 4663, so EOA is the only workable custody here.
  custody: "eoa",
  wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  dex: {
    name: "UniswapV3",
    quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    // Robinhood's pools use the 0.01% tier heavily — the deepest WETH pair we
    // sampled is fee 100. Omitting it would hide the best route on the chain.
    feeTiers: [100, 500, 3000, 10000],
  },
  tokens: {
    WETH: {
      address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      decimals: 18,
      name: "Wrapped Ether",
    },
    // Verified on chain 4663: symbol() "USDG", name() "Global Dollar",
    // decimals() 6, and WETH/USDG pools exist at all four fee tiers.
    USDG: {
      address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      decimals: 6,
      name: "Global Dollar",
    },
  },
});
