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
 * rUSDC is Robinhood's bridged dollar and it has **18 decimals**, not the 6
 * that USDC carries nearly everywhere else. Assuming 6 here would misprice
 * every quote by a factor of 10^12 while looking perfectly reasonable.
 */
export const ROBINHOOD_MAINNET = defineEvmChain({
  chainId: "robinhood:mainnet",
  displayName: "Robinhood",
  id: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  nativeSymbol: "ETH",
  stableSymbol: "rUSDC",
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
    rUSDC: {
      address: "0x05fB7316d600edC32c184e6987563faD153fCBa3",
      decimals: 18,
      name: "Robinhood USDC",
    },
  },
});
